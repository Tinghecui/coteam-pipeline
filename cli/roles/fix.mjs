// The executor role: take one issue (or one row of a spec issue), let the agent do the work in
// a fresh branch, then inspect the result, run the configured checks, commit, push and open
// the pull request. With `pr` it reworks an open pipeline pull request on its own branch.
//
// What the agent can and cannot do: it works in the checkout with an open shell but holds no
// token for the code host. Everything that needs one (claim, push, pull request, comments,
// ledger) is done here, before it starts or after it has exited, and nothing it wrote is
// believed without a look: the changed paths come from git, not from its report.
//
// Every way out leaves a trace the tick can read:
//   - refused before starting  -> a `skip` mark on the issue (or on the PR in rework mode)
//   - started                  -> a ledger line with the outcome, the claim released, and a
//                                 `result` mark on the issue (plus a `rework` mark on the PR)
import { ciRuns } from "../core/decide.mjs"
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
  return parts.join("\n\n")
}

// ---------- the work ----------

// Credentials a checkout step may have left in the repository's own git config: the agent
// can read that file. Our own git calls carry the token in their environment instead.
function dropStoredCredentials(git) {
  const keys = git.try(["config", "--local", "--name-only", "--get-regexp", "^(http\\..*extraheader|includeif\\..*\\.path)$"])
  for (const key of keys.stdout.split("\n").filter(Boolean)) git.try(["config", "--local", "--unset-all", key])
}

// After the claim. -> { outcome, reason, detail?, pr?, usage?, skip? }. `c.start` is set once
// the work branch is checked out: everything after that commit is this run's.
async function work(c, pre) {
  const { io, config, gh } = c
  const { issue, spec, row, pr } = pre
  const n = c.issueNo
  const base = config.base
  const git = io.makeGit({ cwd: io.repoDir })
  c.git = git
  const G = (args, opts) => git.git(args, opts)
  // Hooks are not run for the role's own commit, merge and push: the agent could have written one.
  const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"]
  const failed = (reason, detail = "") => ({ outcome: "failed", reason, detail })

  dropStoredCredentials(git)
  const depth = G(["rev-parse", "--is-shallow-repository"]).trim() === "true" ? [SHALLOW_DEPTH] : []
  git.remote(["fetch", "-q", "--no-tags", ...depth, git.url, `+refs/heads/${base}:refs/remotes/origin/${base}`])
  const baseSha = G(["rev-parse", `refs/remotes/origin/${base}`]).trim()

  let branch
  let mergedBase = false
  if (pr) {
    branch = pr.head.ref
    git.remote(["fetch", "-q", "--no-tags", ...depth, git.url, `+refs/heads/${branch}:refs/pipeline/pr`])
    if (G(["rev-parse", "refs/pipeline/pr"]).trim() !== c.sha) return { skip: { why: "head_moved", text: TEXT.headMoved(c.prNo), permanent: false, sha: c.sha } }
    G(["checkout", "-q", "-B", branch, c.sha])
    c.start = c.sha
    if (git.try(["merge-base", baseSha, "HEAD"]).rc !== 0) return failed(TEXT.noMergeBase(c.prNo, base))
    // Bring the base branch in first, so the rework is checked against today's code and the
    // pull request can merge afterwards. A conflict is not for the agent to resolve in 0.1.
    if (git.try(["merge-base", "--is-ancestor", baseSha, "HEAD"]).rc !== 0) {
      const m = git.try([...NO_HOOKS, "merge", "-q", "--no-ff", "--no-verify", "-m", TEXT.mergeTitle(base, branch), baseSha])
      if (m.rc !== 0) {
        const files = names(git.try(["diff", "--name-only", "--diff-filter=U", "-z"]).stdout)
        git.try(["merge", "--abort"])
        return { outcome: "conflict", reason: TEXT.conflict(base, files) }
      }
      mergedBase = true
      c.start = G(["rev-parse", "HEAD"]).trim()
    }
  } else {
    branch = branchFor({ prefix: config.branch_prefix, issue: n, row: c.row, title: issue.title })
    if (git.remote(["ls-remote", git.url, `refs/heads/${branch}`]).trim()) branch = `${branch}-${c.run}`
    G(["checkout", "-q", "-B", branch, baseSha])
    c.start = baseSha
  }
  c.branch = branch

  for (const line of config.stack.setup) {
    io.log(`setup: ${line}`)
    const r = io.proc.shell(line, { cwd: io.repoDir, timeoutMs: SETUP_MS })
    if (r.rc !== 0) return failed(TEXT.setupFailed(line), tail(r))
  }

  const schema = io.fs.read(`${io.home}/prompts/executor.schema.json`)
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
    rework: pr ? { pr: c.prNo, attempt: pre.attempt, feedback: collectFeedback(c, pre, mergedBase), body: pr.body || "" } : null,
  })

  // The repository's git config as it is now; put back after the agent, whatever it did to it
  // (a rewritten remote or a credential helper would otherwise be used by our push).
  const gitConfig = `${io.repoDir}/.git/config`
  const savedConfig = io.fs.exists(gitConfig) ? io.fs.read(gitConfig) : null
  const res = await io.claude({ tag: "executor", prompt, cwd: io.repoDir, model: config.models.executor, minutes: config.limits.executor_minutes, schema, tools: "all", maxTurns: MAX_TURNS })
  if (savedConfig !== null) io.fs.write(gitConfig, savedConfig)
  const usage = res?.usage || { turns: 0, usd: 0, models: [] }
  c.usage = usage
  if (usage.unavailable) return { outcome: "unavailable", reason: TEXT.unavailable(usage.unavailable) }
  const out = res?.output
  if (!out || typeof out !== "object") return failed(TEXT.noOutput(res?.rc ?? "?", res?.note || ""))
  const bad = schemaProblems(out, JSON.parse(schema))
  if (bad.length) return failed(TEXT.badOutput(bad))
  if (String(out.cannot_fix?.reason || "").trim()) return { outcome: "cannot_fix", reason: String(out.cannot_fix.reason).trim() }

  // The commit is ours, not the agent's: if it committed anyway, its commits are folded into
  // the index, and what counts is the tree compared with the base branch.
  const scratch = (io.claude.scratch || []).map((p) => `:(exclude)${p}`)
  const stage = () => G(["add", "-A", "--", ".", ...scratch])
  G(["reset", "-q", "--soft", c.start])
  stage()
  const touched = names(G(["diff", "--cached", "--name-only", "--no-renames", "-z", baseSha]))
  const thisRound = names(G(["diff", "--cached", "--name-only", "--no-renames", "-z", c.start]))
  if (!thisRound.length && !pr) return failed(TEXT.noChanges)
  let hits = forbiddenHits(config.risk, touched)
  if (hits.length) return { outcome: "forbidden", reason: TEXT.forbidden(hits) }

  for (const line of config.stack.check) {
    io.log(`check: ${line}`)
    const r = io.proc.shell(line, { cwd: io.repoDir, timeoutMs: CHECK_MS })
    if (r.rc !== 0) return { outcome: "checks_failed", reason: TEXT.checkFailed(line), detail: tail(r) }
  }

  // A check may have rewritten files (a formatter): stage again, then judge the final tree.
  stage()
  const textOnly = git.try(["diff", "--cached", "--quiet", c.start]).rc === 0
  if (textOnly && !pr) return failed(TEXT.noChanges)
  const title = pr ? pr.title : titleOf(out, n)
  const subject = pr ? TEXT.reworkTitle(pre.attempt, textOnly) : title
  const ref = row ? CORE.pr.partOf(n, row.n, spec.rows.length) : CORE.pr.fixes(n)
  const message = [subject, "", pr ? `${ref} (PR #${c.prNo})` : ref, "", stripMarks(out.summary), "", TEXT.commitNote, ""].join("\n")
  // A rework that changed no code still gets a commit: the pull request needs a new head for
  // the checks and the reviewer to look at the rewritten description.
  G([...NO_HOOKS, "commit", "-q", "--no-verify", ...(pr ? ["--allow-empty"] : []), "-F", "-"], { input: message })
  const files = names(G(["diff", "--name-only", "--no-renames", "-z", baseSha, "HEAD"]))
  hits = forbiddenHits(config.risk, files)
  if (hits.length) return { outcome: "forbidden", reason: TEXT.forbidden(hits) }
  const head = G(["rev-parse", "HEAD"]).trim()

  // A plain push: never forced, so a branch someone else pushed to in the meantime refuses it.
  const push = git.tryRemote([...NO_HOOKS, "push", "-q", git.url, `HEAD:refs/heads/${branch}`])
  if (push.rc !== 0) return failed(TEXT.pushFailed(branch), tail(push, 600))
  io.log(`pushed ${branch} at ${head.slice(0, 9)}`)

  const level = pathLevel(config.risk, files)
  const draft = pr ? Boolean(pr.draft) : level === 3
  const body = prBody(out, {
    issue: n,
    row: row ? row.n : 0,
    rows: row ? spec.rows.length : 0,
    brief: row ? spec.summary : "",
    files,
    model: usage.models?.[0] || config.models.executor,
    turns: usage.turns,
    usd: usage.usd,
    runUrl: c.runUrl,
    attempt: pr ? pre.attempt : 0,
    draft,
  })
  const done = { level, draft, branch, head, files }

  if (pr) {
    try {
      gh.patch(`pulls/${c.prNo}`, { body })
    } catch (e) {
      io.log(`the PR description was not updated: ${e.message}`)
    }
    const fold = `<details><summary>${TEXT.previousBody}</summary>\n\n${cut(stripMarks(pr.body) || "(empty)", BODY_CUT)}\n\n</details>`
    try {
      comment(
        gh,
        c.prNo,
        `${mark("rework", { attempt: pre.attempt, sha: c.sha, head, run: c.run, done: true })}\n` +
          `${TEXT.reworked(pre.attempt, config.limits.max_rework, safe(titleOf(out, n)))}\n\n${TEXT.reworkedNote}\n\n${fold}`,
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

// ---------- run ----------

// opts: { issue, row, pr, dry }. issue: the work issue (may be left out with pr: it is read
// from the branch name); row: the row of a spec issue to do (left out = the next one that can
// be done); pr: rework this open pipeline PR; dry: precheck only, write nothing.
// -> { ok, outcome, issue, row, pr, reason, ... }.
//   outcome: pr | rework | cannot_fix | forbidden | checks_failed | conflict | unavailable | skipped | failed | dry
//   skipped also carries { why, permanent }; ok is true for pr, rework, cannot_fix, skipped and dry.
export async function run(opts, io) {
  const { issue, row, pr, dry = false } = opts || {}
  const runId = String(io.env.GITHUB_RUN_ID || "0")
  const c = {
    io,
    gh: io.gh,
    config: io.config,
    // Whose marks count: the pipeline's own account, when the io layer knows it.
    authors: markAuthors(io.botLogin, io.env?.PIPELINE_BOT),
    issueNo: Number(issue) || 0,
    rowNo: Number(row) || 0,
    prNo: Number(pr) || 0,
    row: Number(row) || 0,
    dry,
    run: runId,
    runUrl: io.env.GITHUB_RUN_ID && io.env.GITHUB_REPOSITORY ? `${io.env.GITHUB_SERVER_URL || "https://github.com"}/${io.env.GITHUB_REPOSITORY}/actions/runs/${runId}` : "",
    sha: "",
    start: "",
    usage: null,
  }
  if (!c.issueNo && !c.prNo) throw new Error("fix: give an issue or a pr")
  const answer = (outcome, extra = {}) => ({ ok: ["pr", "rework", "cannot_fix", "skipped", "dry"].includes(outcome), outcome, issue: c.issueNo, row: c.row, pr: c.prNo || null, ...extra })
  const skipped = (s) => {
    io.log(`not starting: ${s.text}`)
    postSkip(c, s)
    return answer("skipped", { why: s.why, permanent: s.permanent, reason: s.text, ...(s.until ? { until: s.until } : {}) })
  }

  const pre = precheck(c)
  if (pre.skip) return skipped(pre.skip)
  if (dry) return answer("dry", { rework: Boolean(pre.pr), attempt: pre.attempt })

  // Claim: comment first, then read back. When two runs claim at once, the earliest comment wins.
  const what = pre.pr ? `PR #${c.prNo} (${item(c.issueNo, c.row)})` : item(c.issueNo, c.row)
  const claimBody = `${mark("claim", { run: runId, row: c.row })}\n${TEXT.claim(what, c.runUrl)}`
  const claim = comment(io.gh, c.issueNo, claimBody)
  const release = (note) => {
    try {
      io.gh.patch(`issues/comments/${claim.id}`, { body: `${releaseClaim(claimBody)}\n\n${note}` })
    } catch (e) {
      io.log(`the claim was not released: ${e.message}`)
    }
  }
  const first = activeClaims(commentsOf(c, c.issueNo), { now: io.now() })[0]
  if (first && String(first.id) !== String(claim.id)) {
    release(TEXT.lostClaim(first.run))
    return skipped({ why: "claimed", text: TEXT.claimed(first.run), permanent: false })
  }

  let res
  try {
    res = await work(c, pre)
  } catch (e) {
    res = { outcome: "failed", reason: TEXT.crashed(String(e?.message || e).slice(0, 600)) }
  }
  if (res.skip) {
    release(TEXT.released.skipped)
    return skipped(res.skip)
  }
  const { outcome } = res
  const pushed = outcome === "pr" || outcome === "rework"
  io.log(`outcome: ${outcome}${res.reason ? ` (${res.reason})` : ""}`)

  // Nothing was pushed: throw the working tree's changes away, then say what happened where
  // people and the tick will see it. "unavailable" says nothing: it is not this issue's fault.
  if (!pushed && c.start && c.git) {
    c.git.try(["reset", "-q", "--hard", c.start])
    c.git.try(["clean", "-qfd"])
  }
  if (!pushed && outcome !== "unavailable") {
    const explain = `${safe(res.reason)}${res.detail ? `\n\n${TEXT.output}\n\n${block(res.detail)}` : ""}`
    try {
      comment(
        io.gh,
        c.issueNo,
        `${mark("result", { outcome, row: c.row, run: runId, ...(c.prNo ? { pr: c.prNo } : {}) })}\n${TEXT.result[outcome] || TEXT.result.failed}${c.row ? ` (row ${c.row})` : ""}: ${explain}${c.runUrl ? `\n\n${TEXT.run(c.runUrl)}` : ""}`,
      )
    } catch (e) {
      io.log(`the result comment was not posted: ${e.message}`)
    }
    // A rework that pushed nothing still counts for this head: without the mark the tick
    // would see the same rejected head on its next round and dispatch the same rework again.
    if (pre.pr) {
      try {
        comment(
          io.gh,
          c.prNo,
          `${mark("rework", { attempt: pre.attempt, sha: c.sha, run: runId, failed: true, why: outcome })}\n${TEXT.reworkFailed(pre.attempt, c.config.limits.max_rework, safe(res.reason))}`,
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
  if (outcome === "unavailable" && pre.pr) postSkip(c, { why: "unavailable", text: res.reason, permanent: false, sha: c.sha, ...(usage.resets_at ? { until: usage.resets_at } : {}) })
  const entry = {
    at: iso(io.now()),
    role: "executor",
    issue: c.issueNo,
    row: c.row || null,
    pr: res.pr || c.prNo || null,
    run: runId,
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

  release(outcome === "pr" ? TEXT.released.pr(res.pr) : outcome === "rework" ? TEXT.released.rework(res.pr) : outcome === "unavailable" ? TEXT.released.unavailable : TEXT.released.other)

  const { skip: _s, detail: _d, files, ...rest } = res
  const result = answer(outcome, { ...rest, pr: res.pr || c.prNo || null, usage, ...(pre.pr ? { attempt: pre.attempt } : {}), ...(files ? { files } : {}) })
  return ledgerError ? { ...result, ok: false, ledgerError } : result
}
