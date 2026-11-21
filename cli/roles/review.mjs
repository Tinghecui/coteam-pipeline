// The reviewer role: judge one pipeline PR and write the verdict back to GitHub.
//
// Three parts, each a job of its own on a machine of its own (cli/core/handoff.mjs):
//   prepare  load the PR -> fetch its merge ref (base + PR) into a temp dir -> path level
//            and diff stat -> issue / spec row from the branch name -> prompt. Holds the
//            bot's credential; reads the code with git, runs none of it, starts no agent.
//   agent    check the same merge commit out -> agent with read-only tools -> its
//            structured output. Holds no credential that can write to GitHub.
//   publish  validate -> reviewDecision -> one PR comment with the `review` mark, the
//            commit status, the level label -> ledger line. Holds the bot's credential;
//            no code and no agent.
// `run` does the three in one process (trials on a person's machine, and the tests).
//
// Security. The agent reads untrusted text (the PR, the issue, the code). It gets read-only
// tools, and its job has nothing to write to GitHub with; every write happens in another
// job, from its structured output only, and that output is cleaned and validated first. The
// path level, the changed paths and the base commit named in the verdict are worked out by
// `prepare`, not reported by the agent's job. The rules the PR is judged by are not the PR's
// to change: the config is io.config (read from the base branch) and the prompt and schema
// come from io.home (the engine's checkout), never from the PR's checkout.
import { REVIEW_RETRIES, reviewDecision, validateReview } from "../core/decide.mjs"
import { cleanResult, orderId } from "../core/handoff.mjs"
import { budget } from "../core/ledger.mjs"
import { believedReviews, findMarks, issueOfBranch, latestReview, markAuthors, rowOfBranch, trustedComments } from "../core/marks.mjs"
import { classifyPaths, pathLevel } from "../core/policy.mjs"
import { buildReviewPrompt } from "../core/prompts.mjs"
import { reviewComment, TEXT } from "../core/review-comment.mjs"
import { parseSpec } from "../core/spec.mjs"

// A diff larger than this is not given to the reviewer: it could not read all of it, and a
// verdict on half a diff is worse than none. An owner looks instead.
export const MAX_DIFF_BYTES = 1500000
export const MAX_TURNS = 80
// History the reviewer can look into with git log / git blame.
const FETCH_DEPTH = 200
const MERGE_REF = "refs/pipeline/merge"
const MERGE_TRIES = 4
const LEVEL_COLORS = ["0e8a16", "fbca04", "d93f0b", "b60205"]

const short = (sha) => String(sha || "").slice(0, 9)
const firstLine = (e) => String(e?.message || e).split("\n")[0].slice(0, 300)
const labelNames = (pr) => (pr.labels || []).map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean)

// GitHub builds refs/pull/N/merge in the background and only when the PR merges cleanly.
// The ref counts only if its second parent is the head we are reviewing (it may still be
// the merge of an older head). -> true when it is checked out in git.cwd.
function fetchMerge(io, git, pr) {
  for (let i = 0; i < MERGE_TRIES; i++) {
    const f = git.tryRemote(["fetch", "-q", "--no-tags", `--depth=${FETCH_DEPTH}`, git.url, `+refs/pull/${pr.number}/merge:${MERGE_REF}`])
    if (f.rc === 0 && git.try(["rev-parse", "-q", "--verify", `${MERGE_REF}^2`]).stdout.trim() === pr.head.sha) return true
    if (i === MERGE_TRIES - 1) break
    // Reading the PR asks GitHub to compute mergeability (and the merge ref) again.
    try {
      io.gh.get(`pulls/${pr.number}`)
    } catch {}
    io.proc.run("sleep", ["5"])
  }
  return false
}

// Text from the agent's job that ends up in a comment or a status: one line, and not able to
// write a mark (marks are HTML comments, believed by who posted them).
const plain = (s) => String(s || "").replace(/\s+/g, " ").replace(/<!--/g, "&lt;!--").trim().slice(0, 300)

// Everything that writes: the status, the comment, the ledger line, and the two ways a
// review ends (`fail`: it did not happen; `conclude`: there is a verdict).
// o: { pr, sha, issue, row, dry, run, runUrl, failedBefore } — the same fields an order carries.
function writer(io, o) {
  const config = io.config
  const gh = io.gh
  const { pr: number, sha, dry, run, runUrl } = o
  const model = config.models?.reviewer || ""
  const errors = []
  const write = (what, fn) => {
    if (dry) return null
    try {
      return fn()
    } catch (e) {
      errors.push(`${what}: ${firstLine(e)}`)
      io.log(`review #${number}: ${what} failed: ${firstLine(e)}`)
      return null
    }
  }
  const setStatus = (state, description, url) =>
    write("commit status", () => gh.post(`statuses/${sha}`, { state, context: config.status_context, description: String(description).slice(0, 140), ...(url ? { target_url: url } : {}) }))
  const postComment = (body) => {
    if (dry) io.log(body)
    return write("comment", () => gh.post(`issues/${number}/comments`, { body }))?.html_url || ""
  }
  const ledger = (outcome, usage) =>
    write("ledger", () =>
      io.ledger.append({
        at: io.now().toISOString(),
        role: "reviewer",
        issue: o.issue || null,
        row: o.row,
        pr: number,
        sha,
        run,
        outcome,
        turns: usage?.turns ?? 0,
        usd: usage?.usd ?? 0,
        model: usage?.models?.[0] || model,
        ...(usage?.unavailable ? { unavailable: usage.unavailable, ...(usage.resets_at ? { resets_at: usage.resets_at } : {}) } : {}),
      }),
    )

  // The review did not happen. Pending, never success: nothing merges on a review that did
  // not run. The mark carries no verdict, so this head still counts as not reviewed, and
  // `attempt` lets the tick stop after REVIEW_RETRIES retries. A run where the agent itself
  // was unavailable is not the PR's fault and is not counted.
  const fail = (reason, { level = null, usage = null, unavailable = "" } = {}) => {
    const attempt = o.failedBefore + (unavailable ? 0 : 1)
    const d = reviewDecision({ config, out: null, pathLevel: level, failure: reason })
    const body = reviewComment(d, null, { sha, failure: reason, unavailable, attempt, retries: REVIEW_RETRIES, model: usage?.models?.[0] || model, turns: usage?.turns, usd: usage?.usd, run, runUrl })
    io.log(`review #${number}: ${d.description}`)
    const comment = postComment(body)
    setStatus(d.state, d.description, comment)
    return { ok: !errors.length, pr: number, sha, outcome: "failed", state: d.state, description: d.description, reason, attempt, unavailable: unavailable || null, comment, body, errors }
  }

  // code: { baseSha, paths, byPath, have } as `prepare` measured them; out: the reviewer's
  // output (or one made up here when the reviewer was not asked); ran: the reviewer ran.
  const conclude = (code, { out, usage = null, ran }) => {
    const { byPath } = code
    const v = validateReview(out, { pathLevel: byPath, config })
    if (v.downgraded) io.log(`review #${number}: not taken as an approval: ${v.downgraded}`)
    const d = reviewDecision({ config, out: v.out, pathLevel: byPath })
    io.log(`review #${number}: ${d.verdict}, level ${d.level} (path ${d.pathLevel}, reviewer ${d.reviewerLevel}) -> ${d.state}: ${d.description}`)

    // comment, status, label, ledger
    const body = reviewComment(d, v.out, {
      sha,
      base: config.base,
      baseSha: code.baseSha,
      mode: config.mode,
      approvedLabel: config.labels.approved,
      defaultHours: config.merge.default_after_hours,
      paths: code.paths,
      downgraded: v.downgraded,
      model: usage?.models?.[0] || (ran ? model : ""),
      turns: usage?.turns,
      usd: usage?.usd,
      run,
      runUrl,
    })
    const comment = postComment(body)
    setStatus(d.state, d.description, comment)
    const prefix = config.labels.level_prefix
    const label = `${prefix}${d.level}`
    const have = code.have
    write("label", () => {
      try {
        gh.get(`labels/${encodeURIComponent(label)}`)
      } catch {
        // Not there yet (or just created by a parallel run, which the next call survives).
        try {
          gh.post("labels", { name: label, color: LEVEL_COLORS[d.level], description: TEXT.label(d.level) })
        } catch {}
      }
      if (!have.includes(label)) gh.post(`issues/${number}/labels`, { labels: [label] })
      for (const old of have) if (old.startsWith(prefix) && old !== label) gh.del(`issues/${number}/labels/${encodeURIComponent(old)}`)
    })
    if (ran) ledger(d.verdict, usage)
    return {
      ok: !errors.length,
      pr: number,
      sha,
      outcome: "reviewed",
      verdict: d.verdict,
      level: d.level,
      state: d.state,
      waits: d.waits,
      description: d.description,
      downgraded: v.downgraded,
      comment,
      body,
      errors,
    }
  }
  return { errors, setStatus, ledger, fail, conclude, model }
}

// ---------- part one: prepare ----------

// opts: as for `run`.
// -> { go: true, order }: the reviewer is to run, then `publish`.
//    { go: false, result }: the run ended here; `result` is what `run` returns.
export function prepare(opts, io) {
  const config = io.config
  const gh = io.gh
  const number = Number(opts?.pr)
  if (!Number.isInteger(number) || number <= 0) throw new Error(`review: pr must be a PR number, got ${JSON.stringify(opts?.pr)}`)
  const dry = Boolean(opts?.dry)
  const stop = (result) => ({ go: false, result })
  const skip = (reason, extra = {}) => {
    io.log(`review #${number}: skipped, ${reason}`)
    return stop({ ok: true, pr: number, outcome: "skipped", reason, ...extra })
  }

  if (config.mode === "off") return skip(TEXT.skip.off)
  const pr = gh.get(`pulls/${number}`)
  const sha = String(pr.head?.sha || "")
  const ref = String(pr.head?.ref || "")
  if (pr.state !== "open") return skip(TEXT.skip.notOpen(pr.merged_at ? "merged" : pr.state))
  if (!ref.startsWith(config.branch_prefix)) return skip(TEXT.skip.notOurs(ref, config.branch_prefix))
  // A fork can name its branch anything. Only branches of this repository are the pipeline's.
  const [headRepo, baseRepo] = [pr.head?.repo?.full_name, pr.base?.repo?.full_name]
  const same = (x, y) => String(x).toLowerCase() === String(y).toLowerCase()
  if (!headRepo || (baseRepo && !same(headRepo, baseRepo)) || (gh.repo && !same(headRepo, gh.repo))) return skip(TEXT.skip.fork(headRepo || "deleted"))
  if (pr.base?.ref !== config.base) return skip(TEXT.skip.base(pr.base?.ref, config.base))

  // Only marks posted by the pipeline's own account count, when the io layer knows which
  // that is. When it does not, an earlier verdict on this head is believed only if the commit
  // status names its comment (marks.believedReviews): a comment anyone could have typed must
  // not be able to keep the real review from running. The tick reads it the same way.
  const authors = markAuthors(io.botLogin, io.env?.PIPELINE_BOT)
  const comments = trustedComments(gh.list(`issues/${number}/comments?per_page=100`), authors)
  let believed = comments
  if (!authors) {
    let status = null
    try {
      status = (gh.get(`commits/${sha}/status?per_page=100`)?.statuses || []).find((s) => s.context === config.status_context) || null
    } catch {
      // not readable: no earlier verdict is believed, the review runs
    }
    believed = believedReviews(comments, { authors: null, status })
  }
  const done = latestReview(believed)
  if (done && done.sha === sha && !opts?.force) return skip(TEXT.skip.reviewed(short(sha), done.verdict), { sha, verdict: done.verdict })

  const run = String(io.env.GITHUB_RUN_ID || "")
  const order = {
    v: 1,
    role: "review",
    pr: number,
    sha,
    issue: issueOfBranch(ref, config.branch_prefix),
    row: rowOfBranch(ref, config.branch_prefix)?.row || 0,
    dry,
    run,
    runUrl: run && io.env.GITHUB_REPOSITORY ? `${io.env.GITHUB_SERVER_URL || "https://github.com"}/${io.env.GITHUB_REPOSITORY}/actions/runs/${run}` : "",
    failedBefore: findMarks("review", comments).filter((m) => m.failed === true && m.sha === sha && !m.unavailable).length,
    have: labelNames(pr),
  }
  const { issue, row } = order
  const x = writer(io, order)

  // The daily limit covers every agent run. If the ledger cannot be read the review goes
  // ahead: a review costs little, and a PR left without one costs a person's time.
  let entries = []
  try {
    entries = io.ledger.read()
  } catch (e) {
    io.log(`review #${number}: ledger not readable (${firstLine(e)}), the daily limit is not checked`)
  }
  const b = budget(entries, { issue: -1, limits: config.limits, now: io.now() })
  if (!b.ok) return stop(x.fail(TEXT.failure.budget(b.reason), { unavailable: "budget" }))

  x.setStatus("pending", TEXT.status.reviewing)

  const dir = io.fs.mkdtemp("pipeline-review-")
  try {
    // ---- the code: base with the PR merged in, as GitHub merged it ----
    const git = io.makeGit({ cwd: dir })
    let files = []
    let diffStat = ""
    let diffBytes = 0
    try {
      git.git(["init", "-q"])
      if (!fetchMerge(io, git, pr)) {
        const fresh = gh.get(`pulls/${number}`)
        if (fresh.head?.sha !== sha) return skip(TEXT.skip.moved(short(sha), short(fresh.head?.sha)), { sha })
        if (fresh.mergeable === false || fresh.mergeable_state === "dirty") {
          // No verdict and no mark: the head is not reviewed, and reworking the conflict is the tick's call.
          const description = TEXT.status.conflict(config.base)
          io.log(`review #${number}: ${description}`)
          x.setStatus("pending", description)
          return stop({ ok: !x.errors.length, pr: number, sha, outcome: "conflict", state: "pending", description, errors: x.errors })
        }
        return stop(x.fail(TEXT.failure.noMergeRef))
      }
      // Nothing is checked out here: the commits are read as git holds them.
      order.mergeSha = git.git(["rev-parse", MERGE_REF]).trim()
      order.baseSha = git.git(["rev-parse", `${MERGE_REF}^1`]).trim()
      // --no-renames: a rename shows as the old path deleted and the new one added, and both count for the path rules.
      files = git.git(["diff", "--no-color", "--no-renames", "--name-only", "-z", `${MERGE_REF}^1`, MERGE_REF]).split("\0").filter(Boolean)
      diffStat = git.git(["diff", "--no-color", "--stat=200", `${MERGE_REF}^1`, MERGE_REF]).trimEnd()
      diffBytes = git.git(["diff", "--no-color", `${MERGE_REF}^1`, MERGE_REF]).length
    } catch (e) {
      return stop(x.fail(TEXT.failure.checkout(firstLine(e))))
    }
    order.paths = classifyPaths(config.risk, files)
    order.byPath = pathLevel(config.risk, files)
    io.log(`review #${number}: head ${short(sha)} on ${config.base} ${short(order.baseSha)}, ${files.length} files, ${diffBytes} bytes of diff, level ${order.byPath} by path`)

    // ---- nothing for a reviewer to read: the verdict is made here ----
    const S = TEXT.synthetic
    if (!files.length) return stop(x.conclude(order, { out: { verdict: "needs_human", level: 0, problems: [], followups: [], ask: S.emptyAsk, summary: S.empty }, ran: false }))
    if (diffBytes > MAX_DIFF_BYTES)
      return stop(x.conclude(order, { out: { verdict: "needs_human", level: 0, problems: [], followups: [], ask: S.bigAsk, summary: S.big(files.length, diffBytes, MAX_DIFF_BYTES) }, ran: false }))

    // ---- the prompt. What the PR is checked against: the row of a spec issue, or the issue of a single task.
    let issueObj = null
    let spec = null
    let specRow = null
    if (issue) {
      try {
        issueObj = gh.get(`issues/${issue}`)
        const parsed = row ? parseSpec(issueObj.body) : null
        specRow = parsed?.isSpec ? parsed.rows.find((r) => r.n === row) || null : null
        spec = specRow ? parsed : null
      } catch (e) {
        io.log(`review #${number}: issue #${issue} not readable (${firstLine(e)}), reviewing without it`)
      }
    }
    order.prompt = buildReviewPrompt({
      template: io.fs.read(`${io.home}/prompts/reviewer.md`),
      config,
      pr: { number, title: pr.title, body: pr.body, labels: labelNames(pr) },
      issue: issueObj ? { number: issue, title: issueObj.title, body: issueObj.body } : null,
      spec,
      row: specRow,
      diffStat,
      nonce: io.nonce(),
    })
    return { go: true, order }
  } finally {
    // The directory holds a copy of the repository; mkdtemp made it, nothing else is in it.
    if (String(dir).includes("pipeline-review-")) io.proc.run("rm", ["-rf", dir])
  }
}

// ---------- part two: the agent ----------

// order: what `prepare` wrote. -> the result for `publish`: { rc, output, usage }, or
// { error: "checkout" | "crashed", reason } when the reviewer never ran.
// The merge commit is fetched by its id, so this is the very code `prepare` measured.
export async function agent(order, io) {
  const config = io.config
  const dir = io.fs.mkdtemp("pipeline-review-")
  try {
    const git = io.makeGit({ cwd: dir })
    try {
      if (!/^[0-9a-f]{40,64}$/.test(String(order.mergeSha || ""))) throw new Error("the order names no merge commit")
      git.git(["init", "-q"])
      git.remote(["fetch", "-q", "--no-tags", `--depth=${FETCH_DEPTH}`, git.url, `+${order.mergeSha}:${MERGE_REF}`])
      git.git(["checkout", "-q", "--detach", MERGE_REF])
    } catch (e) {
      return { v: 1, order: orderId(order), error: "checkout", reason: firstLine(e) }
    }
    let res
    try {
      res = await io.claude({
        tag: "reviewer",
        prompt: order.prompt,
        cwd: dir,
        model: config.models?.reviewer || "",
        minutes: config.limits.reviewer_minutes,
        schema: io.fs.read(`${io.home}/prompts/reviewer.schema.json`),
        tools: "readonly",
        maxTurns: MAX_TURNS,
      })
    } catch (e) {
      return { v: 1, order: orderId(order), error: "crashed", reason: firstLine(e) }
    }
    return { v: 1, order: orderId(order), rc: Number.isInteger(res?.rc) ? res.rc : null, output: res?.output && typeof res.output === "object" && !Array.isArray(res.output) ? res.output : null, usage: res?.usage || null }
  } finally {
    if (String(dir).includes("pipeline-review-")) io.proc.run("rm", ["-rf", dir])
  }
}

// ---------- part three: publish ----------

// order: the one `prepare` wrote (the caller has made sure of that: handoff.openOrder);
// result: what the agent part left, as text or parsed, or null when it left nothing.
// -> what `run` returns.
export function publish(order, result, io) {
  const config = io.config
  const x = writer(io, order)
  const level = order.byPath
  const r = cleanResult(result)
  if (!r || r.order !== orderId(order)) return x.fail(TEXT.failure.noResult, { level })
  if (r.error === "checkout") return x.fail(TEXT.failure.checkout(plain(r.reason)))
  if (r.error) return x.fail(TEXT.failure.crashed(plain(r.reason)), { level })
  const usage = r.usage
  let failure = ""
  if (usage.unavailable) failure = TEXT.failure.unavailable(usage.unavailable)
  else if (!r.output) failure = [124, 137].includes(Number(r.rc)) ? TEXT.failure.timeout(config.limits.reviewer_minutes) : TEXT.failure.noOutput(r.rc ?? "?")
  if (failure) {
    const res = x.fail(failure, { level, usage, unavailable: usage.unavailable || "" })
    x.ledger(usage.unavailable ? "unavailable" : "failed", usage)
    return { ...res, ok: !x.errors.length, errors: x.errors }
  }
  // A result with a non-zero exit (say, the turn limit hit after the answer) is still a result.
  return x.conclude(order, { out: r.output, usage, ran: true })
}

// ---------- run ----------

// opts: { pr: number, dry: no writes to GitHub or the ledger (the reviewer still runs),
//         force: review again a head that already has a verdict }
// -> { ok, pr, sha, outcome: "skipped" | "conflict" | "reviewed" | "failed", ... }
//    skipped:  { reason }
//    conflict: { state: "pending", description }
//    reviewed: { verdict, level, state, waits, description, downgraded, comment, body }
//    failed:   { state: "pending", description, reason, attempt, unavailable, comment, body }
// `ok` is false only when something could not be written to GitHub (`errors` lists what).
// The three parts in one process, handing over what the three jobs hand over, as JSON text.
export async function run(opts, io) {
  const first = prepare(opts, io)
  if (!first.go) return first.result
  const order = JSON.parse(JSON.stringify(first.order))
  return publish(order, JSON.stringify(await agent(order, io)), io)
}
