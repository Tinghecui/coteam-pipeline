// The scheduler role: one round. Gather the state of the repository, let core/plan.mjs decide
// (planTick, pure and tested), carry the plan out. It never runs the agent.
//
//   run({ dry }, io) -> { ok, mode, dry, counts, done, failures, skipped, notes, plan? }
//
// `--dry` prints the plan as JSON and changes nothing. In mode "record" everything is done
// except merging and applying defaults. One action that fails does not stop the others: the
// role goes on, lists what failed and returns ok = false.
import { ciRuns } from "../core/decide.mjs"
import { issueOfBranch, markAuthors as authorsOf } from "../core/marks.mjs"
import { GHOST_RUN_MS, FIX_WORKFLOW, REVIEW_WORKFLOW, emptyPlan, planTick } from "../core/plan.mjs"
import { parseSpec } from "../core/spec.mjs"
import { TICK_TEXT as TEXT } from "../core/text.mjs"

export const CLOSED_PR_DAYS = 7
const RUNS_PER_PAGE = 50
const CLOSED_PR_PAGES = 3

// User-visible wording: TICK_TEXT in cli/core/text.mjs.
export { TEXT }

// The order the lists are carried out in. Bookkeeping first, decisions next, then what
// follows from them; dispatches last, so a round that breaks half-way starts nothing it has
// not recorded.
export const ORDER = ["markRows", "applyAnswers", "applyDefaults", "merge", "closeItems", "labels", "closeIssues", "openItems", "nudges", "dispatchReview", "dispatchRework", "dispatchFix"]

const names = (labels) => (labels || []).map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean)
const firstLine = (e) => String(e?.message || e).split("\n")[0].slice(0, 300)
const slimComment = (c) => ({ id: c.id, body: c.body || "", created_at: c.created_at, updated_at: c.updated_at || c.created_at, user: { login: c.user?.login || "" } })
const slimRun = (r) => ({ id: r.id, status: r.status, conclusion: r.conclusion || null, created_at: r.created_at, display_title: r.display_title || r.name || "", html_url: r.html_url || "" })

// ---------- gather ----------

// Everything planTick needs (the shape is documented at the top of core/plan.mjs).
// Reads that the plan cannot do without throw: a round planned on half the state could
// dispatch work that is already going. Reads it can do without are noted in `problems`.
export async function gather(io) {
  const { gh, config } = io
  const L = config.labels
  const prefix = config.branch_prefix
  const now = io.now()
  const problems = []
  const comments = async (n) => (await gh.list(`issues/${n}/comments?per_page=100`)).map(slimComment)
  const label = (name) => encodeURIComponent(name)

  // ---- work issues ----
  const issues = []
  for (const i of (await gh.list(`issues?state=open&labels=${label(L.work)}&per_page=100`)).filter((x) => !x.pull_request)) {
    issues.push({ number: i.number, title: i.title || "", body: i.body || "", labels: names(i.labels), state_reason: i.state_reason || null, created_at: i.created_at, comments: await comments(i.number) })
  }

  // ---- open PRs on the prefix, from this repository only ----
  // A fork can name its branch anything; only a branch of this repository is the pipeline's.
  const ours = (p) => issueOfBranch(p.head?.ref, prefix) > 0 && (!p.head?.repo || !p.base?.repo || p.head.repo.full_name === p.base.repo.full_name)
  const prs = []
  const openPrs = await gh.list("pulls?state=open&per_page=100")
  // Everybody else's open pull requests, from the same list: the plan reads their title and
  // body for "Fixes #n" of a work issue (a person has taken it). No call of their own.
  const otherPrs = openPrs.filter((p) => !ours(p)).map((p) => ({ number: p.number, title: p.title || "", body: p.body || "", head: { ref: p.head?.ref || "" } }))
  for (const p of openPrs.filter(ours)) {
    // The list does not say whether the PR can be merged; the single PR does.
    const full = await gh.get(`pulls/${p.number}`)
    const sha = full.head?.sha || p.head?.sha || ""
    const status = sha ? await gh.get(`commits/${sha}/status?per_page=100`) : { statuses: [] }
    const checks = sha ? await gh.get(`commits/${sha}/check-runs?filter=latest&per_page=100`) : { check_runs: [] }
    const labels = names(full.labels || p.labels)
    let approved = null
    if (labels.includes(L.approved)) {
      try {
        const ev = (await gh.list(`issues/${p.number}/events?per_page=100`)).filter((e) => e.event === "labeled" && e.label?.name === L.approved).pop()
        if (ev) approved = { by: ev.actor?.login || "", at: ev.created_at }
      } catch {
        problems.push(TEXT.noEvents(p.number))
      }
    }
    prs.push({
      number: p.number,
      title: full.title || p.title || "",
      body: full.body || "",
      draft: Boolean(full.draft),
      node_id: full.node_id || p.node_id || "",
      labels,
      head: { ref: full.head?.ref || p.head?.ref, sha },
      mergeable: full.mergeable ?? null,
      mergeable_state: full.mergeable_state || "",
      comments: await comments(p.number),
      statuses: (status?.statuses || []).map((s) => ({ context: s.context, state: s.state, description: s.description || "", target_url: s.target_url || "", created_at: s.created_at, updated_at: s.updated_at })),
      // Without the pipeline's own jobs: this very round's check run sits on the head when a
      // pull request event started it, and it is not the repository's CI.
      checkRuns: ciRuns(checks?.check_runs).map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion || null })),
      approved,
    })
  }

  // ---- PRs closed lately (merged or not) ----
  const cutoff = new Date(now.getTime() - CLOSED_PR_DAYS * 86400000).toISOString()
  const closedPrs = []
  for (let page = 1; page <= CLOSED_PR_PAGES; page++) {
    const list = (await gh.get(`pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`)) || []
    for (const p of list) {
      if (ours(p) && String(p.closed_at || "") >= cutoff) closedPrs.push({ number: p.number, title: p.title || "", head: { ref: p.head?.ref, sha: p.head?.sha }, merged_at: p.merged_at || null, closed_at: p.closed_at, labels: names(p.labels) })
    }
    if (list.length < 100 || String(list[list.length - 1].updated_at || "") < cutoff) break
  }

  // ---- decision items: the open ones with their comments, the lately closed ones without ----
  const slimItem = (i, cs) => ({ number: i.number, title: i.title || "", body: i.body || "", state: i.state, created_at: i.created_at, user: { login: i.user?.login || "" }, comments: cs })
  const items = []
  for (const i of (await gh.list(`issues?state=open&labels=${label(L.decide)}&per_page=100`)).filter((x) => !x.pull_request)) items.push(slimItem(i, await comments(i.number)))
  for (const i of ((await gh.get(`issues?state=closed&labels=${label(L.decide)}&since=${cutoff}&per_page=100`)) || []).filter((x) => !x.pull_request)) items.push(slimItem(i, []))

  // ---- the ledger: without it no budget can be checked ----
  const ledger = await io.ledger.read()

  // ---- workflow runs: not readable = nothing of that kind is dispatched ----
  const runsOf = async (workflow) => {
    try {
      const all = ((await gh.get(`actions/workflows/${workflow}/runs?per_page=${RUNS_PER_PAGE}`))?.workflow_runs || []).map(slimRun)
      for (const r of all) {
        // Queued for a long time: has it any job at all? A run without one is a ghost.
        if (r.status !== "queued" || now.getTime() - Date.parse(r.created_at) <= GHOST_RUN_MS) continue
        try {
          r.jobs = Number((await gh.get(`actions/runs/${r.id}/jobs?per_page=1`))?.total_count ?? 0)
        } catch {
          // unknown: planTick falls back to the run's title
        }
      }
      return all
    } catch (e) {
      problems.push(`${workflow}: ${firstLine(e)}`)
      return null
    }
  }
  const runs = { fix: await runsOf(FIX_WORKFLOW), review: await runsOf(REVIEW_WORKFLOW) }

  // ---- who may answer, when the config names nobody ----
  let maintainers = []
  if (!(config.owners || []).length) {
    try {
      maintainers = (await gh.list("collaborators?per_page=100")).filter((u) => u.permissions?.admin || u.permissions?.maintain).map((u) => u.login)
    } catch (e) {
      problems.push(`collaborators: ${firstLine(e)}`)
    }
    if (!maintainers.length) {
      // A token that may not list collaborators: a repository owned by a person has that person.
      try {
        const repo = await gh.get(`/repos/${gh.repo}`)
        if (repo?.owner?.type === "User" && repo.owner.login) maintainers = [repo.owner.login]
      } catch (e) {
        problems.push(`repository: ${firstLine(e)}`)
      }
    }
  }

  // ---- whose marks count ----
  // io.botLogin is worked out by the io layer (cli/io/real.mjs: PIPELINE_BOT, the app's
  // slug, or GET /user); the executor and the reviewer go by the same value.
  const markAuthors = authorsOf(io.botLogin, io.env?.PIPELINE_BOT)
  if (!markAuthors) problems.push(TEXT.noBot)

  // ---- "#123" dependencies in split tables: done when closed (a PR: merged) ----
  const refsDone = {}
  for (const i of issues) {
    const spec = parseSpec(i.body)
    if (!spec.isSpec || spec.problems.length) continue
    for (const n of spec.rows.flatMap((r) => r.deps.filter((d) => d && typeof d === "object").map((d) => d.pr))) {
      if (n in refsDone) continue
      try {
        const x = await gh.get(`issues/${n}`)
        refsDone[n] = Boolean(x && x.state === "closed" && (!x.pull_request || x.pull_request.merged_at))
      } catch {
        refsDone[n] = false
      }
    }
  }

  const fromEnv = String(io.env?.PIPELINE_HAS_CHECKS || "").toLowerCase()
  const repoHasChecks = ["true", "1", "yes"].includes(fromEnv) ? true : ["false", "0", "no"].includes(fromEnv) ? false : null
  return { state: { issues, prs, otherPrs, closedPrs, items, ledger, runs, maintainers, markAuthors, repoHasChecks, refsDone }, problems }
}

// ---------- execute ----------

// One step of a plan entry (the vocabulary is documented at the top of core/plan.mjs).
async function step(a, { gh, config }) {
  switch (a.do) {
    case "comment":
      return gh.post(`issues/${a.on}/comments`, { body: a.body })
    case "status":
      return gh.post(`statuses/${a.sha}`, { state: a.state, context: a.context, description: a.description })
    case "label":
      if (a.add) return gh.post(`issues/${a.on}/labels`, { labels: [a.add] })
      return gh.del(`issues/${a.on}/labels/${encodeURIComponent(a.remove)}`)
    case "ready": {
      const node = a.node || (await gh.get(`pulls/${a.pr}`))?.node_id
      const res = await gh.graphql("mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { number } } }", { id: node })
      if (res?.errors?.length) throw new Error(`markPullRequestReadyForReview: ${res.errors.map((e) => e.message).join("; ")}`)
      return res
    }
    case "closePr":
      return gh.patch(`pulls/${a.pr}`, { state: "closed" })
    case "closeIssue":
      return gh.patch(`issues/${a.issue}`, { state: "closed", state_reason: a.reason || "completed" })
    case "openIssue":
      return gh.post("issues", { title: a.title, body: a.body, labels: a.labels })
    case "dispatch":
      return gh.dispatch(a.workflow, config.base, a.inputs)
    case "merge":
      return gh.put(`pulls/${a.pr}/merge`, { merge_method: a.method, sha: a.sha })
    default:
      throw new Error(`unknown plan step "${a.do}"`)
  }
}

// Carry the plan out. -> { done: [what], failures: [{ list, what, step, error }], skipped: [{ list, what, why }] }
export async function execute(plan, io) {
  const { config } = io
  const done = []
  const failures = []
  const skipped = []
  // What could not be recorded: nothing that follows from it may run.
  const failed = { items: new Set(), prs: new Set(), issues: new Set(), marks: new Set() }
  const skip = (list, what, why) => {
    skipped.push({ list, what, why })
    io.log(TEXT.skipped(what, why))
  }
  let labelEnsured = false
  for (const list of ORDER) {
    for (const entry of plan[list] || []) {
      const what = TEXT.what[list](entry)
      if (config.mode !== "on" && (list === "merge" || list === "applyDefaults")) {
        skip(list, what, TEXT.why.record)
        continue
      }
      const follows = list === "merge" || list === "dispatchRework" || list === "dispatchFix"
      if (follows && ((entry.item && failed.items.has(entry.item)) || (entry.pr && failed.prs.has(entry.pr)) || (!entry.pr && failed.issues.has(entry.issue)))) {
        skip(list, what, TEXT.why.answerFailed)
        continue
      }
      if (list === "closeIssues" && failed.marks.has(entry.issue)) {
        skip(list, what, TEXT.why.markFailed)
        continue
      }
      if (list === "openItems" && !labelEnsured) {
        labelEnsured = true
        try {
          await io.gh.post("labels", { name: config.labels.decide, color: "d93f0b", description: TEXT.decideLabel })
        } catch {
          // it exists already
        }
      }
      let at = ""
      try {
        for (const a of entry.actions || []) {
          at = a.do
          await step(a, io)
        }
        done.push(what)
        io.log(TEXT.did(what))
      } catch (e) {
        const error = firstLine(e)
        failures.push({ list, what, step: at, error })
        io.log(TEXT.failed(what, error))
        if (list === "applyAnswers" || list === "applyDefaults") {
          if (entry.item) failed.items.add(entry.item)
          if (entry.pr) failed.prs.add(entry.pr)
          if (entry.issue) failed.issues.add(entry.issue)
        }
        if (list === "markRows") failed.marks.add(entry.issue)
      }
    }
  }
  return { done, failures, skipped }
}

// ---------- run ----------

const countsOf = (plan) => Object.fromEntries(ORDER.map((k) => [k, (plan[k] || []).length]))

export async function run(opts, io) {
  const dry = Boolean(opts?.dry)
  const { config } = io
  if (config.mode === "off") {
    const plan = emptyPlan("off")
    io.log(dry ? JSON.stringify(plan, null, 2) : TEXT.off)
    return { ok: true, mode: "off", dry, counts: countsOf(plan), done: [], failures: [], skipped: [], notes: [], ...(dry ? { plan } : {}) }
  }
  let gathered
  try {
    gathered = await gather(io)
  } catch (e) {
    io.log(TEXT.gatherFailed(firstLine(e)))
    return { ok: false, mode: config.mode, dry, error: firstLine(e), counts: {}, done: [], failures: [{ list: "gather", what: "read the repository state", step: "gather", error: firstLine(e) }], skipped: [], notes: [] }
  }
  const { state, problems } = gathered
  const plan = planTick(state, config, io.now())
  const notes = [...problems, ...plan.notes]
  const counts = countsOf(plan)
  if (dry) {
    io.log(JSON.stringify({ ...plan, notes }, null, 2))
    io.log(TEXT.dryRun)
    return { ok: true, mode: config.mode, dry, counts, done: [], failures: [], skipped: [], notes, plan }
  }
  io.log(TEXT.gathered({ issues: state.issues.length, prs: state.prs.length, items: state.items.filter((i) => i.state === "open").length, running: plan.running.length }))
  io.log(TEXT.planned(config.mode, counts))
  for (const line of notes) io.log(TEXT.note(line))
  const { done, failures, skipped } = await execute(plan, io)
  io.log(TEXT.result(done.length, failures.length))
  return { ok: failures.length === 0, mode: config.mode, dry, counts, done, failures, skipped, notes }
}
