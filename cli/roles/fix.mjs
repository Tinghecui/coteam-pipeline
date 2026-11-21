// The executor role: take one issue (or one row of a spec issue), let the agent do the work in
// a fresh branch, then inspect the result, commit, push and open the pull request. With `pr`
// it reworks an open pipeline pull request on its own branch.
//
// The role has three parts, and the workflow runs each in a job of its own, on a machine of
// its own (cli/core/handoff.mjs):
//   prepare  reads the issue, decides whether the run may start, claims it, and writes the
//            work order. It holds the bot's credential and runs nothing from the repository.
//   agent    checks the code out, runs the setup commands, the agent and the checks, and
//            hands back one git tree. It holds no credential that can write to GitHub.
//   publish  takes that tree, looks at it, makes the commit itself, pushes, opens the pull
//            request and writes the comments and the ledger line. It holds the bot's
//            credential and runs neither the agent nor any code from the repository.
// Nothing the agent's machine says is believed without a look: the changed paths come from
// git on the publishing machine, the commit and its parents are made there, and the text of
// the result is cleaned before it is used. `run` does the three in one process (trials on a
// person's machine, and the tests).
//
// Every way out leaves a trace the tick can read:
//   - refused before starting  -> a `skip` mark on the issue (or on the PR in rework mode)
//   - started                  -> a ledger line with the outcome, the claim released, and a
//                                 `result` mark on the issue (plus a `rework` mark on the PR)
import { ciRuns } from "../core/decide.mjs"
import { cleanResult, orderId } from "../core/handoff.mjs"
import { budget, claudeCooldown } from "../core/ledger.mjs"
import { activeClaims, believedReviews, branchFor, countSince, findMarks, isAfter, issueOfBranch, lastDecision, latestReview, mark, markAuthors, releaseClaim, reworkObsolete, rowOfBranch, takesIssue, trustedComments } from "../core/marks.mjs"
import { forbiddenHits, pathLevel } from "../core/policy.mjs"
import { BODY_CUT, buildExecutorPrompt, cut, prBody } from "../core/prompts.mjs"
import { parseSpec, specProgress } from "../core/spec.mjs"
import { T as CORE } from "../core/text.mjs"
import { FIX_TEXT as TEXT, taskName as item } from "../core/text.mjs"

// The agent's turn limit. The time limit (limits.executor_minutes) is the one that normally ends a run.
export const MAX_TURNS = 400
const SETUP_MS = 30 * 60000
const CHECK_MS = 30 * 60000
// History fetched when the checkout is shallow: the agent reads `git log`, and a rework needs
// the point where the branch left the base.
const SHALLOW_DEPTH = "--depth=500"
// The one git tree the agent part hands over travels as a bundle holding this ref.
const OUT_REF = "refs/pipeline/out"
const IN_REF = "refs/pipeline/in"
// Hooks are not run for the role's own merge and push: the agent could have written one.
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"]
// What the agent part may report. "staged": a tree is in the bundle.
const AGENT_OUTCOMES = new Set(["staged", "skipped", "unavailable", "cannot_fix", "forbidden", "checks_failed", "conflict", "failed"])

// Refusals that stay true until a person does something. The tick should stop dispatching
// and put the item in front of an owner. The others pass by themselves.
const PERMANENT = new Set(["closed", "not_issue", "no_label", "spec", "no_row", "row_done", "capped", "max_rework", "head_reworked", "not_ours", "pr_closed"])

const tail = (r, n = 3000) => `${r.stdout || ""}\n${r.stderr || ""}`.trim().slice(-n)
// Text from the agent or from a command's output, put into a comment: it must not be able to
// write a mark of its own (marks are HTML comments, and ours are trusted by who posted them).
const safe = (s) => String(s ?? "").replace(/<!--/g, "&lt;!--").trim()
const block = (s) => {
  const t = safe(s) || "(empty)"
  const n = Math.max(3, ...[...t.matchAll(/`+/g)].map((m) => m[0].length + 1))
  return `${"`".repeat(n)}text\n${t}\n${"`".repeat(n)}`
}

// User-visible wording: FIX_TEXT in cli/core/text.mjs.
export { TEXT }

// ---------- structured output ----------

// Problems of `value` against the subset of JSON Schema the output schemas use (type,
// required, properties, additionalProperties: false, items, enum). [] = it matches.
export function schemaProblems(value, schema, path = "output") {
  const s = schema || {}
  const type = Array.isArray(value) ? "array" : value === null ? "null" : typeof value
  if (s.type) {
    const ok = s.type === "integer" ? Number.isInteger(value) : s.type === type
    if (!ok) return [`${path} must be ${s.type === "array" ? "an array" : s.type === "object" ? "an object" : `a ${s.type}`}`]
  }
  const out = []
  if (s.enum && !s.enum.includes(value)) out.push(`${path} must be one of ${s.enum.join(", ")}`)
  if (type === "object") {
    for (const k of s.required || []) if (!Object.hasOwn(value, k)) out.push(`${path}.${k} is missing`)
    for (const [k, v] of Object.entries(value)) {
      if (s.properties && Object.hasOwn(s.properties, k)) out.push(...schemaProblems(v, s.properties[k], `${path}.${k}`))
      else if (s.additionalProperties === false) out.push(`${path}.${k} is not a known field`)
    }
  }
  if (type === "array" && s.items) value.forEach((v, i) => out.push(...schemaProblems(v, s.items, `${path}[${i}]`)))
  return out
}

// The first sentence of the summary: the pull request title and the commit subject.
export function titleOf(out, issue) {
  const first = String(out?.summary || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim()
    .split(/\n|(?<=[.!?])\s/)[0]
    .trim()
    .replace(/[.\s]+$/, "")
    .slice(0, 120)
  return first || TEXT.defaultTitle(issue)
}

// ---------- small io helpers ----------

// The comments of an issue or PR as this role reads them: of those that carry a mark, only the
// pipeline's own (c.authors; marks.trustedComments). The tick filters the same way, so both
// see the same claims, attempts, decisions and finished rows.
const commentsOf = (c, n) => trustedComments(c.gh.list(`issues/${n}/comments?per_page=100`), c.authors)
// The PR's comments as far as review verdicts go. When the pipeline's own login is not known,
// a review comment counts only if the commit status on the head names it (marks.believedReviews).
function reviewsOf(c, prComments) {
  if (c.authors) return prComments
  let status = null
  try {
    status = (c.gh.get(`commits/${c.sha}/status?per_page=100`)?.statuses || []).find((s) => s.context === c.config.status_context) || null
  } catch {
    // not readable: no review comment is believed
  }
  return believedReviews(prComments, { authors: null, status })
}
const comment = (gh, n, body) => gh.post(`issues/${n}/comments`, { body })
const labelsOf = (x) => (x?.labels || []).map((l) => (typeof l === "string" ? l : l?.name))
const names = (z) => String(z || "").split("\0").filter(Boolean)
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z")

// ---------- precheck ----------

// Reads the issue (and the PR in rework mode) and decides whether this run may start.
// -> { skip: { why, text, permanent, ... } } or everything the run needs.
function precheck(c) {
  const { io, config, gh } = c
  const prefix = config.branch_prefix
  const skip = (why, text, extra = {}) => ({ skip: { why, text, permanent: PERMANENT.has(why), ...extra } })
  if (config.mode === "off") return skip("off", TEXT.off)

  let pr = null
  if (c.prNo) {
    pr = gh.get(`pulls/${c.prNo}`)
    const ref = String(pr.head?.ref || "")
    c.issueNo ||= issueOfBranch(ref, prefix)
    c.sha = pr.head?.sha || ""
    if (pr.state !== "open") return skip("pr_closed", TEXT.prClosed(c.prNo, Boolean(pr.merged_at)))
    // Only pipeline branches of this very repository: a fork's branch cannot be pushed to,
    // and a person's branch is not ours to rewrite.
    if (!c.issueNo || issueOfBranch(ref, prefix) !== c.issueNo || pr.head?.repo?.full_name !== pr.base?.repo?.full_name) return skip("not_ours", TEXT.notOurs(c.prNo, ref))
  }
  const n = c.issueNo
  const issue = gh.get(`issues/${n}`)
  if (issue.pull_request) return skip("not_issue", TEXT.notIssue(n))
  if (issue.state !== "open") return skip("closed", TEXT.closed(n))
  if (!labelsOf(issue).includes(config.labels.work)) return skip("no_label", TEXT.noLabel(n, config.labels.work))
  const comments = commentsOf(c, n)
  const spec = parseSpec(issue.body)
  let row = null
  let prComments = []
  let reviews = []
  let attempt = 0

  if (pr) {
    prComments = commentsOf(c, c.prNo)
    reviews = reviewsOf(c, prComments)
    // Counts start again after the latest human decision, on the PR or on its issue: the same
    // rule and the same order of comments the tick uses (marks.lastDecision, marks.isAfter).
    const decided = lastDecision(comments, prComments)
    const marks = findMarks("rework", prComments).filter((m) => !decided || isAfter(m, decided))
    // Marks written by an executor run (pushed or failed) say "this head was already worked on".
    const tried = marks.some((m) => m.sha === c.sha && (m.done === true || m.failed === true) && !reworkObsolete({ at: m.at, sha: m.sha }, pr, reviews))
    if (tried) return skip("head_reworked", TEXT.headReworked(c.prNo, c.sha), { sha: c.sha })
    const earlier = new Set(marks.map((m) => String(m.sha || "")).filter((s) => s !== c.sha))
    if (earlier.size >= config.limits.max_rework) return skip("max_rework", TEXT.maxRework(c.prNo, earlier.size, config.limits.max_rework), { sha: c.sha })
    attempt = earlier.size + 1
    const r = rowOfBranch(pr.head.ref, prefix)
    if (spec.isSpec && r) {
      row = spec.rows.find((x) => x.n === r.row) || null
      if (!row) return skip("no_row", TEXT.noRow(n, r.row))
    }
  } else {
    const openPrs = gh.list("pulls?state=open&per_page=100")
    // The pipeline's own pull request for this issue, or a person's that says it closes it
    // (marks.takesIssue; the tick holds the issue back by the same test).
    const other = openPrs.find((p) => takesIssue(p, n, prefix))
    if (other) return skip("open_pr", TEXT.openPr(n, other.number), { other: other.number })
    if (spec.isSpec) {
      if (spec.problems.length) return skip("spec", TEXT.specProblems(n, spec.problems))
      if (spec.open) return skip("spec", TEXT.specOpen(n))
      const closedPrs = [1, 2].flatMap((page) => gh.get(`pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`) || [])
      // Whether "#123" dependencies are done is the tick's check; once a run is dispatched they count as done.
      const refsDone = Object.fromEntries(spec.rows.flatMap((r) => r.deps.filter((d) => d && typeof d === "object").map((d) => [d.pr, true])))
      const prog = specProgress(spec, { issue: n, branchPrefix: prefix, redoLabel: config.labels.redo, openPrs, closedPrs, comments, refsDone })
      const done = (k) => prog.merged.find((m) => m.row === k)
      if (c.rowNo) {
        row = spec.rows.find((x) => x.n === c.rowNo) || null
        if (!row) return skip("no_row", TEXT.noRow(n, c.rowNo))
        if (done(row.n)) return skip("row_done", TEXT.rowDone(n, row.n, done(row.n).pr), { row: row.n })
        const waits = row.deps.filter((d) => typeof d === "number" && !done(d))
        if (waits.length) return skip("row_waits", TEXT.rowWaits(n, row.n, waits), { row: row.n })
      } else {
        if (prog.done) return skip("row_done", TEXT.allDone(n))
        row = prog.next
        if (!row) return skip("row_waits", TEXT.noNext(n, prog.blocked))
      }
    }
  }
  c.row = row ? row.n : 0

  const now = io.now()
  const entries = io.ledger.read()
  const cool = claudeCooldown(entries, now)
  // `cooling: false` = the wait is over but nothing has worked since: this run is the probe.
  if (cool?.cooling) return skip("cooldown", TEXT.cooldown(cool.reason, cool.until), { until: cool.until })
  const b = budget(entries, { issue: n, row: row ? row.n : null, limits: config.limits, now, since: countSince(comments, prComments) })
  if (!b.ok) return skip(b.capped ? "capped" : "budget", b.reason)
  const claims = activeClaims(comments, { now })
  if (claims.length) return skip("claimed", TEXT.claimed(claims[0].run))

  return { issue, comments, spec, row, pr, prComments, reviews, attempt }
}

// Say on the issue (or the PR, in rework mode) why the run did not start. Without it the
// tick sees nothing and dispatches the same run again on every round.
// A refusal that stays true until a person acts is posted once per decision. One that passes
// by itself is posted every time: the tick waits a while after each (counted from the mark's
// time), so a mark that was not renewed would let it dispatch on every round again.
// The exception is "another pull request is open for this issue" (somebody's own pull
// request can stay open for days): said in one comment, which is renewed in place when the
// executor is started again while the same pull request is open. The tick counts its wait
// from the time a skip comment was last written, so the renewed comment holds it back as a
// new one would.
function postSkip(c, s) {
  const { io, gh } = c
  const target = c.prNo || c.issueNo
  if (!target || s.why === "off" || c.dry) return
  try {
    const payload = { why: s.why, permanent: s.permanent, run: c.run, row: Number(s.row ?? c.row ?? 0), ...(s.sha ? { sha: s.sha } : {}), ...(s.until ? { until: s.until } : {}), ...(s.other ? { other: s.other } : {}) }
    const body = `${mark("skip", payload)}\n${TEXT.skipped(safe(s.text))}${s.permanent ? ` ${TEXT.skippedPermanent}` : ""}`
    if (s.permanent || s.other) {
      const all = commentsOf(c, target)
      const decided = lastDecision(all)
      const same = findMarks("skip", all)
        .filter((m) => m.why === s.why && Number(m.row || 0) === payload.row && String(m.sha || "") === String(s.sha || "") && Number(m.other || 0) === Number(s.other || 0) && (!decided || isAfter(m, decided)))
        .pop()
      if (same && s.permanent) return
      if (same) {
        gh.patch(`issues/comments/${same.id}`, { body })
        return
      }
    }
    comment(gh, target, body)
  } catch (e) {
    io.log(`could not post the skip comment: ${e.message}`)
  }
}

// ---------- rework feedback ----------

const stripMarks = (s) => String(s || "").replace(/<!--[\s\S]*?-->/g, "").trim()

// What the agent is shown in a rework: the reviewer's verdict on this head, what people
// decided, and the checks that failed. All of it is untrusted text; the prompt fences it.
function collectFeedback(c, pre, mergedBase) {
  const { gh, config } = c
  const parts = []
  const review = latestReview(pre.reviews)
  if (review?.sha === c.sha) parts.push(`${TEXT.fb.review(review.verdict)}\n\n${stripMarks(pre.reviews.find((x) => x.id === review.id)?.body)}`)
  else parts.push(TEXT.fb.noReview(review?.sha || ""))
  const people = pre.prComments.filter((x) => /<!-- pipeline-decision /.test(String(x.body || ""))).slice(-3)
  if (people.length) parts.push(`${TEXT.fb.people}\n\n${people.map((x) => stripMarks(x.body)).join("\n\n-----\n\n")}`)
  try {
    const runs = ciRuns(gh.get(`commits/${c.sha}/check-runs?per_page=100`)?.check_runs, config.status_context).filter((r) => ["failure", "timed_out"].includes(r.conclusion))
    const statuses = (gh.get(`commits/${c.sha}/status`)?.statuses || []).filter((s) => ["failure", "error"].includes(s.state) && s.context !== config.status_context)
    const lines = [
      ...runs.slice(0, 6).map((r) => `${TEXT.fb.check(r.name, r.conclusion)}\n\n${cut([r.output?.title, r.output?.summary, r.details_url].filter(Boolean).join("\n\n"), 3000)}`),
      ...statuses.slice(0, 6).map((s) => `${TEXT.fb.check(s.context, s.state)}\n\n${[s.description, s.target_url].filter(Boolean).join("\n\n")}`),
    ]
    parts.push(lines.length ? `${TEXT.fb.checks}\n\n${lines.join("\n\n")}` : TEXT.fb.noFailed)
  } catch {
    parts.push(TEXT.fb.unreadable)
  }
  if (mergedBase) parts.push(TEXT.fb.merged(config.base))
  if (c.conflict) parts.unshift(TEXT.fb.conflict(config.base, c.conflict.files))
  return parts.join("\n\n")
}

// ---------- git, as every part uses it ----------

// Credentials a checkout step may have left in the repository's own git config: the agent
// can read that file. Our own git calls carry the token in their environment instead.
function dropStoredCredentials(git) {
  const keys = git.try(["config", "--local", "--name-only", "--get-regexp", "^(http\\..*extraheader|includeif\\..*\\.path)$"])
  for (const key of keys.stdout.split("\n").filter(Boolean)) git.try(["config", "--local", "--unset-all", key])
}

// What is wrong with the tree the agent left, if anything. -> { outcome, reason } or null.
// The agent part asks to stop early; the publishing part asks again, of the tree it was
// handed, and that answer is the one that counts.
//   - nothing changed (new work only: a rework may rewrite just the description);
//   - a path the executor may not touch, anywhere in the pull request;
//   - a conflicted merge that is not resolved. Two ways to get that wrong are caught:
//     conflict markers left in a file, and a base change thrown away (the agent ran
//     `git merge --abort` or checked a file out from the PR side), which would turn the merge
//     commit into a silent revert of the base branch. A file only the base changed may still
//     be edited further (a base test that has to follow the PR's change); it is lost only
//     when it is back to what it was before the base changed it.
function treeProblem(git, config, order, tree) {
  const G = (args) => git.git(args)
  if (order.conflict) {
    const { files, mergeBase } = order.conflict
    const marked = files.filter((f) => /^(<{7}|>{7}|={7})( |$)/m.test(git.try(["show", `${tree}:${f}`]).stdout))
    if (marked.length) return { outcome: "conflict", reason: TEXT.conflictMarkers(marked) }
    const ours = new Set(names(G(["diff", "--name-only", "--no-renames", "-z", mergeBase, order.sha])))
    const theirs = names(G(["diff", "--name-only", "--no-renames", "-z", mergeBase, order.baseSha])).filter((f) => !ours.has(f))
    const lost = theirs.filter((f) => git.try(["diff", "--quiet", mergeBase, tree, "--", f]).rc === 0)
    if (lost.length) return { outcome: "conflict", reason: TEXT.conflictLost(config.base, lost) }
  }
  const touched = names(G(["diff", "--name-only", "--no-renames", "-z", order.baseSha, tree]))
  if (!touched.length && !order.pr) return { outcome: "failed", reason: TEXT.noChanges }
  const hits = forbiddenHits(config.risk, touched)
  if (hits.length) return { outcome: "forbidden", reason: TEXT.forbidden(hits) }
  return null
}

// ---------- what every part knows about the run ----------

// opts: { issue, row, pr, dry }, or the same numbers out of a work order.
function context(io, { issue, row, pr, dry = false } = {}) {
  const runId = String(io.env.GITHUB_RUN_ID || "0")
  return {
    io,
    gh: io.gh,
    config: io.config,
    // Whose marks count: the pipeline's own account, when the io layer knows it.
    authors: markAuthors(io.botLogin, io.env?.PIPELINE_BOT),
    issueNo: Number(issue) || 0,
    rowNo: Number(row) || 0,
    prNo: Number(pr) || 0,
    row: Number(row) || 0,
    dry: Boolean(dry),
    run: runId,
    runUrl: io.env.GITHUB_RUN_ID && io.env.GITHUB_REPOSITORY ? `${io.env.GITHUB_SERVER_URL || "https://github.com"}/${io.env.GITHUB_REPOSITORY}/actions/runs/${runId}` : "",
    sha: "",
    usage: null,
    conflict: null,
  }
}

const answer = (c, outcome, extra = {}) => ({ ok: ["pr", "rework", "cannot_fix", "skipped", "dry"].includes(outcome), outcome, issue: c.issueNo, row: c.row, pr: c.prNo || null, ...extra })

function skipped(c, s) {
  c.io.log(`not starting: ${s.text}`)
  postSkip(c, s)
  return answer(c, "skipped", { why: s.why, permanent: s.permanent, reason: s.text, ...(s.until ? { until: s.until } : {}) })
}

function release(c, claim, note) {
  try {
    c.gh.patch(`issues/comments/${claim.id}`, { body: `${releaseClaim(claim.body)}\n\n${note}` })
  } catch (e) {
    c.io.log(`the claim was not released: ${e.message}`)
  }
}

const headMoved = (c) => ({ skip: { why: "head_moved", text: TEXT.headMoved(c.prNo), permanent: false, sha: c.sha } })

// ---------- part one: prepare ----------

// After the claim: where the work starts from and what the agent is told. Fills the order.
// -> null when the agent may start, else { skip } or { outcome: "failed", ... }.
// Git is used to read history only; nothing is checked out and nothing from the repository runs.
function plan(c, pre, order) {
  const { io, config } = c
  const { issue, spec, row, pr } = pre
  const n = c.issueNo
  const base = config.base
  const git = io.makeGit({ cwd: io.repoDir })
  const G = (args, opts) => git.git(args, opts)
  const failed = (reason, detail = "") => ({ outcome: "failed", reason, detail })

  const depth = G(["rev-parse", "--is-shallow-repository"]).trim() === "true" ? [SHALLOW_DEPTH] : []
  git.remote(["fetch", "-q", "--no-tags", ...depth, git.url, `+refs/heads/${base}:refs/remotes/origin/${base}`])
  const baseSha = G(["rev-parse", `refs/remotes/origin/${base}`]).trim()

  let branch
  // new:      a fresh branch from the base
  // plain:    a rework whose branch already contains the base
  // merge:    a rework; the base merges into the branch cleanly, and is merged in first
  // conflict: a rework; the merge stops with conflicts, which the agent is asked to resolve
  let shape = "new"
  if (pr) {
    branch = pr.head.ref
    git.remote(["fetch", "-q", "--no-tags", ...depth, git.url, `+refs/heads/${branch}:refs/pipeline/pr`])
    if (G(["rev-parse", "refs/pipeline/pr"]).trim() !== c.sha) return headMoved(c)
    if (git.try(["merge-base", baseSha, c.sha]).rc !== 0) return failed(TEXT.noMergeBase(c.prNo, base))
    // Bring the base branch in first, so the rework is checked against today's code and the
    // pull request can merge afterwards. `merge-tree` says how that merge will go without
    // touching a working tree.
    if (git.try(["merge-base", "--is-ancestor", baseSha, c.sha]).rc === 0) shape = "plain"
    else {
      const m = git.try(["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", c.sha, baseSha])
      if (m.rc === 0) shape = "merge"
      else {
        const files = m.rc === 1 ? names(m.stdout).slice(1) : []
        if (!files.length) return failed(TEXT.mergeFailed(base), tail(m))
        shape = "conflict"
        c.conflict = { files, mergeBase: G(["merge-base", c.sha, baseSha]).trim() }
      }
    }
  } else {
    branch = branchFor({ prefix: config.branch_prefix, issue: n, row: c.row, title: issue.title })
    if (git.remote(["ls-remote", git.url, `refs/heads/${branch}`]).trim()) branch = `${branch}-${c.run}`
  }

  const prompt = buildExecutorPrompt({
    template: io.fs.read(`${io.home}/prompts/executor.md`),
    config,
    issue,
    comments: pre.comments,
    spec: row ? spec : null,
    row,
    branch,
    base: baseSha,
    nonce: io.nonce(),
    today: io.now().toISOString().slice(0, 10),
    rework: pr ? { pr: c.prNo, attempt: pre.attempt, feedback: collectFeedback(c, pre, shape === "merge"), body: pr.body || "" } : null,
  })
  Object.assign(order, {
    branch,
    baseSha,
    shape,
    conflict: c.conflict,
    prompt,
    pull: pr ? { title: String(pr.title || ""), body: String(pr.body || ""), draft: Boolean(pr.draft) } : null,
    spec: row ? { rows: spec.rows.length, summary: spec.summary } : null,
  })
  return null
}

// opts: { issue, row, pr, dry } as for `run`.
// -> { go: true, order }: the agent part is to run, then the publishing part.
//    { go: false, result }: the run ended here; `result` is what `run` returns.
export function prepare(opts, io) {
  const c = context(io, opts)
  if (!c.issueNo && !c.prNo) throw new Error("fix: give an issue or a pr")
  const stop = (result) => ({ go: false, result })

  const pre = precheck(c)
  if (pre.skip) return stop(skipped(c, pre.skip))
  if (c.dry) return stop(answer(c, "dry", { rework: Boolean(pre.pr), attempt: pre.attempt }))

  // Claim: comment first, then read back. When two runs claim at once, the earliest comment wins.
  const what = pre.pr ? `PR #${c.prNo} (${item(c.issueNo, c.row)})` : item(c.issueNo, c.row)
  const claimBody = `${mark("claim", { run: c.run, row: c.row })}\n${TEXT.claim(what, c.runUrl)}`
  const claim = { id: comment(io.gh, c.issueNo, claimBody).id, body: claimBody }
  const first = activeClaims(commentsOf(c, c.issueNo), { now: io.now() })[0]
  if (first && String(first.id) !== String(claim.id)) {
    release(c, claim, TEXT.lostClaim(first.run))
    return stop(skipped(c, { why: "claimed", text: TEXT.claimed(first.run), permanent: false }))
  }

  const order = { v: 1, role: "fix", run: c.run, runUrl: c.runUrl, issue: c.issueNo, row: c.row, pr: c.prNo, sha: c.sha, attempt: pre.attempt, claim }
  let res
  try {
    res = plan(c, pre, order)
  } catch (e) {
    res = { outcome: "failed", reason: TEXT.crashed(String(e?.message || e).slice(0, 600)) }
  }
  return res ? stop(finish(c, order, res)) : { go: true, order }
}

// ---------- part two: the agent ----------

// order: what `prepare` wrote; bundle: the path of the file the tree is handed over in.
// -> the result for `publish`: { outcome, reason?, detail?, why?, output?, usage }.
//    outcome "staged": the bundle holds the tree to publish. Anything else: no bundle.
// It talks to nothing but git's remote (to read) and the model. On the workflow's machine it
// has no way to write to GitHub; what it returns is checked by `publish` as a stranger's.
export async function agent(order, io, { bundle }) {
  const { config } = io
  const base = config.base
  const git = io.makeGit({ cwd: io.repoDir })
  const G = (args, opts) => git.git(args, opts)
  const failed = (reason, detail = "") => ({ outcome: "failed", reason, detail })
  // Set once the work branch is checked out: where the checkout goes back to when nothing is handed over.
  let start = ""
  let usage = null

  const work = async () => {
    dropStoredCredentials(git)
    const depth = G(["rev-parse", "--is-shallow-repository"]).trim() === "true" ? [SHALLOW_DEPTH] : []
    git.remote(["fetch", "-q", "--no-tags", ...depth, git.url, `+refs/heads/${base}:refs/remotes/origin/${base}`])
    if (git.try(["cat-file", "-e", `${order.baseSha}^{commit}`]).rc !== 0) return failed(TEXT.baseGone(base))
    if (order.pr) {
      git.remote(["fetch", "-q", "--no-tags", ...depth, git.url, `+refs/heads/${order.branch}:refs/pipeline/pr`])
      if (G(["rev-parse", "refs/pipeline/pr"]).trim() !== order.sha) return { outcome: "skipped", why: "head_moved" }
      G(["checkout", "-q", "-B", order.branch, order.sha])
      start = order.sha
      if (order.shape === "merge" || order.shape === "conflict") {
        // A conflict is left in the working tree for the agent to resolve; `publish` then
        // records the result as a real merge commit.
        const m = git.try([...NO_HOOKS, "merge", "-q", "--no-ff", "--no-verify", "-m", TEXT.mergeTitle(base, order.branch), order.baseSha])
        const stopped = m.rc !== 0 && names(git.try(["diff", "--name-only", "--diff-filter=U", "-z"]).stdout).length > 0
        if ((m.rc !== 0 && !stopped) || stopped !== (order.shape === "conflict")) {
          if (m.rc !== 0) git.try(["merge", "--abort"])
          return failed(TEXT.mergeFailed(base), tail(m))
        }
        if (!stopped) start = G(["rev-parse", "HEAD"]).trim()
      }
    } else {
      G(["checkout", "-q", "-B", order.branch, order.baseSha])
      start = order.baseSha
    }

    for (const line of config.stack.setup) {
      io.log(`setup: ${line}`)
      const r = io.proc.shell(line, { cwd: io.repoDir, timeoutMs: SETUP_MS })
      if (r.rc !== 0) return failed(TEXT.setupFailed(line), tail(r))
    }

    const schema = io.fs.read(`${io.home}/prompts/executor.schema.json`)
    // The repository's git config as it is now; put back after the agent, whatever it did to it
    // (a rewritten remote or a credential helper would otherwise be used by our own git calls).
    const gitConfig = `${io.repoDir}/.git/config`
    const savedConfig = io.fs.exists(gitConfig) ? io.fs.read(gitConfig) : null
    const res = await io.claude({ tag: "executor", prompt: order.prompt, cwd: io.repoDir, model: config.models.executor, minutes: config.limits.executor_minutes, schema, tools: "all", maxTurns: MAX_TURNS })
    if (savedConfig !== null) io.fs.write(gitConfig, savedConfig)
    usage = res?.usage || null
    if (usage?.unavailable) return { outcome: "unavailable" }
    const out = res?.output
    if (!out || typeof out !== "object") return failed(TEXT.noOutput(res?.rc ?? "?", res?.note || ""))
    const bad = schemaProblems(out, JSON.parse(schema))
    if (bad.length) return failed(TEXT.badOutput(bad))
    if (String(out.cannot_fix?.reason || "").trim()) return { outcome: "cannot_fix", reason: String(out.cannot_fix.reason).trim() }

    // What is handed over is the tree, not a commit: whatever the agent committed, and whatever
    // it left uncommitted, is in the working tree, and the working tree is what gets staged.
    // An unfinished merge is dropped first (`merge --quit` keeps the files as the agent left
    // them); staging then clears the index's unmerged entries.
    const scratch = (io.claude.scratch || []).map((p) => `:(exclude)${p}`)
    const stage = () => {
      G(["add", "-A", "--", ".", ...scratch])
      return G(["write-tree"]).trim()
    }
    if (order.shape === "conflict") git.try(["merge", "--quit"])
    let tree = stage()
    let problem = treeProblem(git, config, order, tree)
    if (problem) return problem

    for (const line of config.stack.check) {
      io.log(`check: ${line}`)
      const r = io.proc.shell(line, { cwd: io.repoDir, timeoutMs: CHECK_MS })
      if (r.rc !== 0) return { outcome: "checks_failed", reason: TEXT.checkFailed(line), detail: tail(r) }
    }

    // A check may have rewritten files (a formatter): stage again, then judge the final tree.
    tree = stage()
    problem = treeProblem(git, config, order, tree)
    if (problem) return problem
    // A bundle carries commits, so the tree rides in one. `publish` takes the tree out of it
    // and makes its own commit; this one's message and parent are never used.
    const carrier = G(["commit-tree", tree, "-p", order.baseSha, "-m", "the tree handed to the publishing job"]).trim()
    G(["update-ref", OUT_REF, carrier])
    G(["bundle", "create", "-q", bundle, OUT_REF, `^${order.baseSha}`])
    return { outcome: "staged", output: out }
  }

  let res
  try {
    res = await work()
  } catch (e) {
    res = failed(TEXT.crashed(String(e?.message || e).slice(0, 600)))
  }
  io.log(`agent part: ${res.outcome}${res.reason ? ` (${res.reason})` : ""}`)
  // Nothing is handed over: throw the working tree's changes away.
  if (res.outcome !== "staged" && start) {
    git.try(["reset", "-q", "--hard", start])
    git.try(["clean", "-qfd"])
  }
  return { v: 1, order: orderId(order), ...res, usage: usage || { turns: 0, usd: 0, models: [] } }
}

// ---------- part three: publish ----------

// The tree out of the bundle, looked at and committed here, pushed, and the pull request
// opened or updated. `dir` is an empty directory of this part's own: a bare repository is
// made in it, so no file of the change is ever written out, let alone run.
// -> { outcome: "pr" | "rework", ... } or why not.
function land(c, order, out, bundle, dir) {
  const { io, config, gh } = c
  const n = c.issueNo
  const base = config.base
  const { branch, baseSha, pull } = order
  const usage = c.usage
  const failed = (reason, detail = "") => ({ outcome: "failed", reason, detail })
  const git = io.makeGit({ cwd: dir })
  const G = (args, opts) => git.git(args, opts)

  G(["init", "-q", "--bare"])
  git.remote(["fetch", "-q", "--no-tags", SHALLOW_DEPTH, git.url, `+refs/heads/${base}:refs/remotes/origin/${base}`])
  if (git.try(["cat-file", "-e", `${baseSha}^{commit}`]).rc !== 0) return failed(TEXT.baseGone(base))
  if (pull) {
    git.remote(["fetch", "-q", "--no-tags", SHALLOW_DEPTH, git.url, `+refs/heads/${branch}:refs/pipeline/pr`])
    if (G(["rev-parse", "refs/pipeline/pr"]).trim() !== order.sha) return headMoved(c)
  }
  const got = git.try(["-c", "transfer.fsckObjects=true", "fetch", "-q", "--no-tags", bundle, `+${OUT_REF}:${IN_REF}`])
  if (got.rc !== 0) return failed(TEXT.badBundle, tail(got, 600))
  const tree = G(["rev-parse", `${IN_REF}^{tree}`]).trim()
  // The tree is taken through git's index and written out again before it is believed. The
  // index refuses paths no checkout may contain (".git" and its look-alikes, "..", an empty
  // name), and a tree that does not come back as itself was not a well-formed one: the path
  // checks below read names out of it and must be able to rely on what they read.
  const sound = git.try(["-c", "core.protectHFS=true", "-c", "core.protectNTFS=true", "read-tree", tree])
  if (sound.rc !== 0 || G(["write-tree"]).trim() !== tree) return failed(TEXT.badTree, tail(sound, 600))
  const problem = treeProblem(git, config, order, tree)
  if (problem) return problem

  // The commits are made here, from the tree alone. Their parents are the ones the order
  // names, so a pull request can never be handed history the agent's machine made up.
  let start = pull ? order.sha : baseSha
  if (order.shape === "merge") {
    const m = git.try(["merge-tree", "--write-tree", "--no-messages", order.sha, baseSha])
    if (m.rc !== 0) return failed(TEXT.mergeFailed(base), tail(m))
    start = G(["commit-tree", m.stdout.trim().split("\n")[0], "-p", order.sha, "-p", baseSha, "-F", "-"], { input: `${TEXT.mergeTitle(base, branch)}\n` }).trim()
  }
  // A rework that changed no code still gets a commit: the pull request needs a new head for
  // the checks and the reviewer to look at the rewritten description.
  const textOnly = G(["rev-parse", `${start}^{tree}`]).trim() === tree
  const row = order.spec ? c.row : 0
  const title = pull ? pull.title : titleOf(out, n)
  const subject = pull ? TEXT.reworkTitle(order.attempt, textOnly) : title
  const ref = row ? CORE.pr.partOf(n, row, order.spec.rows) : CORE.pr.fixes(n)
  const message = [subject, "", pull ? `${ref} (PR #${c.prNo})` : ref, "", stripMarks(out.summary), "", TEXT.commitNote, ""].join("\n")
  // A resolved conflict is one commit with two parents (the PR head and the base), so the
  // pull request contains the base and GitHub sees no conflict any more.
  const parents = order.shape === "conflict" ? [order.sha, baseSha] : [start]
  const head = G(["commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-F", "-"], { input: message }).trim()
  const files = names(G(["diff", "--name-only", "--no-renames", "-z", baseSha, head]))
  const hits = forbiddenHits(config.risk, files)
  if (hits.length) return { outcome: "forbidden", reason: TEXT.forbidden(hits) }

  // A plain push: never forced, so a branch someone else pushed to in the meantime refuses it.
  const push = git.tryRemote([...NO_HOOKS, "push", "-q", git.url, `${head}:refs/heads/${branch}`])
  if (push.rc !== 0) return failed(TEXT.pushFailed(branch), tail(push, 600))
  io.log(`pushed ${branch} at ${head.slice(0, 9)}`)

  const level = pathLevel(config.risk, files)
  const draft = pull ? pull.draft : level === 3
  const body = prBody(out, {
    issue: n,
    row,
    rows: row ? order.spec.rows : 0,
    brief: row ? order.spec.summary : "",
    files,
    model: usage.models?.[0] || config.models.executor,
    turns: usage.turns,
    usd: usage.usd,
    runUrl: c.runUrl,
    attempt: pull ? order.attempt : 0,
    draft,
  })
  const done = { level, draft, branch, head, files }

  if (pull) {
    try {
      gh.patch(`pulls/${c.prNo}`, { body })
    } catch (e) {
      io.log(`the PR description was not updated: ${e.message}`)
    }
    const fold = `<details><summary>${TEXT.previousBody}</summary>\n\n${cut(stripMarks(pull.body) || "(empty)", BODY_CUT)}\n\n</details>`
    try {
      comment(
        gh,
        c.prNo,
        `${mark("rework", { attempt: order.attempt, sha: c.sha, head, run: c.run, done: true })}\n` +
          `${TEXT.reworked(order.attempt, config.limits.max_rework, safe(titleOf(out, n)))}\n\n${TEXT.reworkedNote}\n\n${fold}`,
      )
    } catch (e) {
      io.log(`the rework comment was not posted: ${e.message}`)
    }
    return { outcome: "rework", pr: c.prNo, ...done }
  }

  let created
  try {
    created = gh.post("pulls", { title, head: branch, base, body, draft })
  } catch (e) {
    return failed(TEXT.prFailed(branch, e.message))
  }
  if (!Number.isInteger(created?.number)) return failed(TEXT.prFailed(branch, "no number came back"))
  io.log(`opened PR #${created.number}${draft ? " (draft)" : ""}`)
  try {
    comment(gh, n, `${mark("result", { outcome: "pr", pr: created.number, row: c.row, run: c.run })}\n${TEXT.opened(created.number, item(n, c.row), draft)}`)
  } catch (e) {
    io.log(`the comment on #${n} was not posted: ${e.message}`)
  }
  return { outcome: "pr", pr: created.number, ...done }
}

// What the agent part reported, read as a stranger's word. -> what `finish` is given.
function judge(c, order, result, bundle) {
  const { io } = c
  const failed = (reason, detail = "") => ({ outcome: "failed", reason, detail })
  const r = cleanResult(result)
  if (!r || r.order !== orderId(order) || !AGENT_OUTCOMES.has(r.outcome)) return failed(TEXT.noResult)
  c.usage = r.usage
  if (r.usage.unavailable) return { outcome: "unavailable", reason: TEXT.unavailable(r.usage.unavailable) }
  if (r.outcome === "unavailable") return failed(TEXT.noResult)
  if (r.outcome === "skipped") return order.pull && r.why === "head_moved" ? headMoved(c) : failed(TEXT.noResult)
  if (r.outcome !== "staged") return { outcome: r.outcome, reason: r.reason || TEXT.noReason, detail: r.detail }

  const out = r.output
  if (!out) return failed(TEXT.noOutput("?", ""))
  const bad = schemaProblems(out, JSON.parse(io.fs.read(`${io.home}/prompts/executor.schema.json`)))
  if (bad.length) return failed(TEXT.badOutput(bad))
  if (String(out.cannot_fix?.reason || "").trim()) return { outcome: "cannot_fix", reason: String(out.cannot_fix.reason).trim() }
  if (!bundle || !io.fs.exists(bundle)) return failed(TEXT.noBundle)
  const dir = io.fs.mkdtemp("pipeline-publish-")
  try {
    return land(c, order, out, bundle, dir)
  } finally {
    // mkdtemp made this directory, nothing else is in it.
    if (String(dir).includes("pipeline-publish-")) io.proc.run("rm", ["-rf", dir])
  }
}

// The end of every run that got as far as a claim: say what happened where people and the
// tick will see it, write the ledger line, release the claim. -> what `run` returns.
function finish(c, order, res) {
  const { io } = c
  const rework = Boolean(order.pr)
  if (res.skip) {
    release(c, order.claim, TEXT.released.skipped)
    return skipped(c, res.skip)
  }
  const { outcome } = res
  const pushed = outcome === "pr" || outcome === "rework"
  io.log(`outcome: ${outcome}${res.reason ? ` (${res.reason})` : ""}`)

  // Nothing was pushed. "unavailable" says nothing: it is not this issue's fault.
  if (!pushed && outcome !== "unavailable") {
    const explain = `${safe(res.reason)}${res.detail ? `\n\n${TEXT.output}\n\n${block(res.detail)}` : ""}`
    try {
      comment(
        io.gh,
        c.issueNo,
        `${mark("result", { outcome, row: c.row, run: c.run, ...(c.prNo ? { pr: c.prNo } : {}) })}\n${TEXT.result[outcome] || TEXT.result.failed}${c.row ? ` (row ${c.row})` : ""}: ${explain}${c.runUrl ? `\n\n${TEXT.run(c.runUrl)}` : ""}`,
      )
    } catch (e) {
      io.log(`the result comment was not posted: ${e.message}`)
    }
    // A rework that pushed nothing still counts for this head: without the mark the tick
    // would see the same rejected head on its next round and dispatch the same rework again.
    if (rework) {
      try {
        comment(
          io.gh,
          c.prNo,
          `${mark("rework", { attempt: order.attempt, sha: c.sha, run: c.run, failed: true, why: outcome })}\n${TEXT.reworkFailed(order.attempt, c.config.limits.max_rework, safe(res.reason))}`,
        )
      } catch (e) {
        io.log(`the rework comment was not posted: ${e.message}`)
      }
    }
  }

  const usage = c.usage || { turns: 0, usd: 0, models: [] }
  // A rework the agent could not be used for is not an attempt, and the head has to be sent
  // back again once the agent works. The tick wrote "rework dispatched for this head" before
  // it started this run and waits for a result; a `skip` mark is the result that says
  // "nothing happened, send it again later". Without it the tick would wait for hours and
  // then report the rework as lost.
  if (outcome === "unavailable" && rework) postSkip(c, { why: "unavailable", text: res.reason, permanent: false, sha: c.sha, ...(usage.resets_at ? { until: usage.resets_at } : {}) })
  const entry = {
    at: iso(io.now()),
    role: "executor",
    issue: c.issueNo,
    row: c.row || null,
    pr: res.pr || c.prNo || null,
    run: c.run,
    outcome,
    turns: usage.turns || 0,
    usd: usage.usd || 0,
    model: usage.models?.[0] || c.config.models.executor || "",
    ...(usage.unavailable ? { unavailable: usage.unavailable, ...(usage.resets_at ? { resets_at: usage.resets_at } : {}) } : {}),
  }
  let ledgerError = ""
  try {
    io.ledger.append(entry)
  } catch (e) {
    ledgerError = String(e?.message || e)
    io.log(`the ledger line was not written: ${ledgerError}`)
  }

  release(c, order.claim, outcome === "pr" ? TEXT.released.pr(res.pr) : outcome === "rework" ? TEXT.released.rework(res.pr) : outcome === "unavailable" ? TEXT.released.unavailable : TEXT.released.other)

  const { skip: _s, detail: _d, files, ...rest } = res
  const result = answer(c, outcome, { ...rest, pr: res.pr || c.prNo || null, usage, ...(rework ? { attempt: order.attempt } : {}), ...(files ? { files } : {}) })
  return ledgerError ? { ...result, ok: false, ledgerError } : result
}

// order: the one `prepare` wrote (the caller has made sure of that: handoff.openOrder);
// result: what the agent part left, as text or parsed, or null when it left nothing;
// bundle: the path of the bundle it left, if any.
// -> what `run` returns.
export function publish(order, result, io, { bundle = "" } = {}) {
  const c = context(io, { issue: order.issue, row: order.row, pr: order.pr })
  Object.assign(c, { run: String(order.run), runUrl: order.runUrl, sha: order.sha })
  let res
  try {
    res = judge(c, order, result, bundle)
  } catch (e) {
    res = { outcome: "failed", reason: TEXT.crashed(String(e?.message || e).slice(0, 600)) }
  }
  return finish(c, order, res)
}

// ---------- run ----------

// opts: { issue, row, pr, dry }. issue: the work issue (may be left out with pr: it is read
// from the branch name); row: the row of a spec issue to do (left out = the next one that can
// be done); pr: rework this open pipeline PR; dry: precheck only, write nothing.
// -> { ok, outcome, issue, row, pr, reason, ... }.
//   outcome: pr | rework | cannot_fix | forbidden | checks_failed | conflict | unavailable | skipped | failed | dry
//   skipped also carries { why, permanent }; ok is true for pr, rework, cannot_fix, skipped and dry.
// The three parts in one process, handing over what the three jobs hand over: the order and
// the result as JSON text, the tree as a bundle file.
export async function run(opts, io) {
  const first = prepare(opts, io)
  if (!first.go) return first.result
  const order = JSON.parse(JSON.stringify(first.order))
  const bundle = `${io.fs.mkdtemp("pipeline-handoff-")}/change.bundle`
  const result = JSON.stringify(await agent(order, io, { bundle }))
  return publish(order, result, io, { bundle })
}
