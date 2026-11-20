// The reviewer role: judge one pipeline PR and write the verdict back to GitHub.
//
//   load the PR -> check out its merge ref (base + PR) into a temp dir -> path level and diff
//   stat -> issue / spec row from the branch name -> prompt -> agent with read-only tools ->
//   validate -> reviewDecision -> one PR comment with the `review` mark, the commit status,
//   the level label -> ledger line.
//
// Security. The agent reads untrusted text (the PR, the issue, the code). It gets read-only
// tools and no GitHub token (io.claude strips them); every write to GitHub happens here,
// after it has exited, from its structured output only. The rules it is judged by are not
// the PR's to change: the config is io.config (read from the base branch) and the prompt
// and schema come from io.home (the engine's checkout), never from the PR's checkout.
import { REVIEW_RETRIES, reviewDecision, validateReview } from "../core/decide.mjs"
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

// opts: { pr: number, dry: no writes to GitHub or the ledger (the reviewer still runs),
//         force: review again a head that already has a verdict }
// -> { ok, pr, sha, outcome: "skipped" | "conflict" | "reviewed" | "failed", ... }
//    skipped:  { reason }
//    conflict: { state: "pending", description }
//    reviewed: { verdict, level, state, waits, description, downgraded, comment, body }
//    failed:   { state: "pending", description, reason, attempt, unavailable, comment, body }
// `ok` is false only when something could not be written to GitHub (`errors` lists what).
export async function run(opts, io) {
  const config = io.config
  const gh = io.gh
  const number = Number(opts?.pr)
  if (!Number.isInteger(number) || number <= 0) throw new Error(`review: pr must be a PR number, got ${JSON.stringify(opts?.pr)}`)
  const dry = Boolean(opts?.dry)
  const skip = (reason, extra = {}) => {
    io.log(`review #${number}: skipped, ${reason}`)
    return { ok: true, pr: number, outcome: "skipped", reason, ...extra }
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
  const runUrl = run && io.env.GITHUB_REPOSITORY ? `${io.env.GITHUB_SERVER_URL || "https://github.com"}/${io.env.GITHUB_REPOSITORY}/actions/runs/${run}` : ""
  const issue = issueOfBranch(ref, config.branch_prefix)
  const row = rowOfBranch(ref, config.branch_prefix)?.row || 0
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
        issue: issue || null,
        row,
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
    const before = findMarks("review", comments).filter((m) => m.failed === true && m.sha === sha && !m.unavailable).length
    const attempt = before + (unavailable ? 0 : 1)
    const d = reviewDecision({ config, out: null, pathLevel: level, failure: reason })
    const body = reviewComment(d, null, { sha, failure: reason, unavailable, attempt, retries: REVIEW_RETRIES, model: usage?.models?.[0] || model, turns: usage?.turns, usd: usage?.usd, run, runUrl })
    io.log(`review #${number}: ${d.description}`)
    const comment = postComment(body)
    setStatus(d.state, d.description, comment)
    return { ok: !errors.length, pr: number, sha, outcome: "failed", state: d.state, description: d.description, reason, attempt, unavailable: unavailable || null, comment, body, errors }
  }

  // The daily limit covers every agent run. If the ledger cannot be read the review goes
  // ahead: a review costs little, and a PR left without one costs a person's time.
  let entries = []
  try {
    entries = io.ledger.read()
  } catch (e) {
    io.log(`review #${number}: ledger not readable (${firstLine(e)}), the daily limit is not checked`)
  }
  const b = budget(entries, { issue: -1, limits: config.limits, now: io.now() })
  if (!b.ok) return fail(TEXT.failure.budget(b.reason), { unavailable: "budget" })

  setStatus("pending", TEXT.status.reviewing)

  const dir = io.fs.mkdtemp("pipeline-review-")
  try {
    // ---- the code: base with the PR merged in, as GitHub merged it ----
    const git = io.makeGit({ cwd: dir })
    let baseSha = ""
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
          setStatus("pending", description)
          return { ok: !errors.length, pr: number, sha, outcome: "conflict", state: "pending", description, errors }
        }
        return fail(TEXT.failure.noMergeRef)
      }
      git.git(["checkout", "-q", "--detach", MERGE_REF])
      baseSha = git.git(["rev-parse", "HEAD^1"]).trim()
      // --no-renames: a rename shows as the old path deleted and the new one added, and both count for the path rules.
      files = git.git(["diff", "--no-color", "--no-renames", "--name-only", "-z", "HEAD^1", "HEAD"]).split("\0").filter(Boolean)
      diffStat = git.git(["diff", "--no-color", "--stat=200", "HEAD^1", "HEAD"]).trimEnd()
      diffBytes = git.git(["diff", "--no-color", "HEAD^1", "HEAD"]).length
    } catch (e) {
      return fail(TEXT.failure.checkout(firstLine(e)))
    }
    const paths = classifyPaths(config.risk, files)
    const byPath = pathLevel(config.risk, files)
    io.log(`review #${number}: head ${short(sha)} on ${config.base} ${short(baseSha)}, ${files.length} files, ${diffBytes} bytes of diff, level ${byPath} by path`)

    // ---- the reviewer ----
    let out = null
    let usage = null
    let ran = false
    const S = TEXT.synthetic
    if (!files.length) out = { verdict: "needs_human", level: 0, problems: [], followups: [], ask: S.emptyAsk, summary: S.empty }
    else if (diffBytes > MAX_DIFF_BYTES) out = { verdict: "needs_human", level: 0, problems: [], followups: [], ask: S.bigAsk, summary: S.big(files.length, diffBytes, MAX_DIFF_BYTES) }
    else {
      // What the PR is checked against: the row of a spec issue, or the issue of a single task.
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
      const prompt = buildReviewPrompt({
        template: io.fs.read(`${io.home}/prompts/reviewer.md`),
        config,
        pr: { number, title: pr.title, body: pr.body, labels: labelNames(pr) },
        issue: issueObj ? { number: issue, title: issueObj.title, body: issueObj.body } : null,
        spec,
        row: specRow,
        diffStat,
        nonce: io.nonce(),
      })
      ran = true
      let res
      try {
        res = await io.claude({
          tag: "reviewer",
          prompt,
          cwd: dir,
          model,
          minutes: config.limits.reviewer_minutes,
          schema: io.fs.read(`${io.home}/prompts/reviewer.schema.json`),
          tools: "readonly",
          maxTurns: MAX_TURNS,
        })
      } catch (e) {
        return fail(TEXT.failure.crashed(firstLine(e)), { level: byPath })
      }
      usage = res?.usage || null
      const structured = res?.output && typeof res.output === "object" && !Array.isArray(res.output) ? res.output : null
      let failure = ""
      if (usage?.unavailable) failure = TEXT.failure.unavailable(usage.unavailable)
      else if (!structured) failure = [124, 137].includes(Number(res?.rc)) ? TEXT.failure.timeout(config.limits.reviewer_minutes) : TEXT.failure.noOutput(res?.rc ?? "?")
      if (failure) {
        const r = fail(failure, { level: byPath, usage, unavailable: usage?.unavailable || "" })
        ledger(usage?.unavailable ? "unavailable" : "failed", usage)
        return { ...r, ok: !errors.length, errors }
      }
      // A result with a non-zero exit (say, the turn limit hit after the answer) is still a result.
      out = structured
    }

    // ---- the verdict ----
    const v = validateReview(out, { pathLevel: byPath, config })
    if (v.downgraded) io.log(`review #${number}: not taken as an approval: ${v.downgraded}`)
    const d = reviewDecision({ config, out: v.out, pathLevel: byPath })
    io.log(`review #${number}: ${d.verdict}, level ${d.level} (path ${d.pathLevel}, reviewer ${d.reviewerLevel}) -> ${d.state}: ${d.description}`)

    // ---- publish: comment, status, label, ledger ----
    const body = reviewComment(d, v.out, {
      sha,
      base: config.base,
      baseSha,
      mode: config.mode,
      approvedLabel: config.labels.approved,
      defaultHours: config.merge.default_after_hours,
      paths,
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
    const have = labelNames(pr)
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
  } finally {
    // The checkout holds a full copy of the repository; mkdtemp made this directory, nothing else is in it.
    if (String(dir).includes("pipeline-review-")) io.proc.run("rm", ["-rf", dir])
  }
}
