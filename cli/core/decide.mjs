// What a review means for a PR (commit status, who it waits for) and whether a PR may be merged.

// User-visible wording: DECIDE_TEXT in cli/core/text.mjs.
import { DECIDE_TEXT as TEXT } from "./text.mjs"
export { TEXT }

// How many times the tick dispatches the reviewer again after a review that did not run.
export const REVIEW_RETRIES = 3

const VERDICTS = ["approve", "reject", "needs_human"]
const cut = (s) => String(s).replace(/\s+/g, " ").trim().slice(0, 140)
// Levels fail closed: a level that was never worked out (the diff could not be fetched, the
// reviewer left it out) is level 3, not level 0. Only a real integer 0..3 is believed.
const levelOr3 = (v) => (Number.isInteger(v) && v >= 0 && v <= 3 ? v : 3)

// config: the loaded config; out: the reviewer's structured output (null if it did not run);
// pathLevel: policy.pathLevel() of the PR's files (null if it could not be computed);
// failure: why the reviewer did not run, if it did not.
// Returns { state, level, waits, description } plus { verdict, pathLevel, reviewerLevel, problems, failed }.
//   waits: "owner" = only a human moves this on, it never defaults; null = nothing to wait
//   for, or a decision item that takes its recommended option after merge.default_after_hours.
// The state does not depend on `mode`: record mode is enforced where merging is decided (mergeable).
export function reviewDecision({ config, out, pathLevel, failure = "" }) {
  const { auto_max_level: autoMax, default_after_hours: hours } = config.merge
  const byPath = levelOr3(pathLevel)
  if (failure || !out || typeof out !== "object") {
    // Not approved and not rejected: the tick dispatches the reviewer again (REVIEW_RETRIES).
    // Nothing merges on the strength of a review that never happened, whatever the path level.
    return {
      state: "pending",
      level: byPath,
      waits: null,
      description: cut(TEXT.reviewFailed(failure || "no output")),
      verdict: null,
      pathLevel: byPath,
      reviewerLevel: null,
      problems: [],
      failed: true,
    }
  }
  const problems = Array.isArray(out.problems) ? out.problems.filter((p) => p && typeof p === "object") : []
  // An unknown verdict is "could not decide", never an approval.
  let verdict = VERDICTS.includes(out.verdict) ? out.verdict : "needs_human"
  // Every problem kind in the schema is a reason to reject (wrong logic, an unmet criterion,
  // a security problem, no tests for a behaviour change). A reviewer that lists one and
  // still says "approve" is sent back all the same: reviewers do forget to flip the verdict,
  // most often for missing tests.
  if (verdict === "approve" && problems.length) verdict = "reject"
  const n = Math.trunc(Number(out.level))
  const reviewerLevel = Number.isFinite(n) && out.level !== null && out.level !== "" ? Math.min(3, Math.max(0, n)) : 3
  // The reviewer can raise the level the paths give, never lower it.
  const level = Math.max(byPath, reviewerLevel)
  let state = "pending"
  let waits = null
  let description
  if (verdict === "reject") [state, description] = ["failure", TEXT.rejected(problems.length)]
  else if (verdict === "needs_human") [waits, description] = ["owner", TEXT.needsHuman]
  else if (level >= 3) [waits, description] = ["owner", TEXT.waitsOwner(level, config.labels.approved)]
  else if (level <= autoMax) [state, description] = ["success", TEXT.approved(level)]
  else if (hours > 0) description = TEXT.waitsDefault(level, hours)
  // default_after_hours 0 = wait forever, which is the same as waiting for an owner.
  else [waits, description] = ["owner", TEXT.waitsDecision(level)]
  return { state, level, waits, description: cut(description), verdict, pathLevel: byPath, reviewerLevel, problems, failed: false }
}

const filledText = (v) => typeof v === "string" && v.trim() !== ""

// Check the parts of the reviewer's output that the JSON schema cannot tie together.
// An approval whose level puts a choice in front of an owner (above merge.auto_max_level,
// below 3) becomes a decision item, and that item is built from `ask`, `options` (two or
// more, each saying what it is) and `recommend` (1-based, one of the options). Without
// them there is nothing to ask and nothing that could apply by default, so the approval
// is turned into `needs_human`: an owner looks at the PR, and it never defaults.
//   pathLevel: policy.pathLevel() of the PR's files, when known; the level that counts is
//              the higher of it and the reviewer's own (as in reviewDecision)
//   config:    the loaded config (for merge.auto_max_level); without it, 1
// Returns { out, downgraded }: `out` unchanged and `downgraded: null` when there is nothing
// to object to; otherwise a copy with verdict "needs_human" and the reason as text.
// Anything that is not an approval is returned as it is: reviewDecision already fails closed on it.
export function validateReview(out, { pathLevel = 0, config = null } = {}) {
  if (!out || typeof out !== "object" || Array.isArray(out)) return { out, downgraded: null }
  const problems = Array.isArray(out.problems) ? out.problems.filter((p) => p && typeof p === "object") : []
  if (out.verdict !== "approve" || problems.length) return { out, downgraded: null }
  const n = Math.trunc(Number(out.level))
  const reviewerLevel = Number.isFinite(n) && out.level !== null && out.level !== "" ? Math.min(3, Math.max(0, n)) : 3
  const level = Math.max(levelOr3(pathLevel), reviewerLevel)
  const autoMax = Number.isInteger(config?.merge?.auto_max_level) ? config.merge.auto_max_level : 1
  if (level <= autoMax || level >= 3) return { out, downgraded: null }
  const options = Array.isArray(out.options) ? out.options : []
  const missing = []
  if (!filledText(out.ask)) missing.push(TEXT.invalid.ask)
  const optionsOk = options.length >= 2 && options.every((o) => o && typeof o === "object" && filledText(o.what))
  if (!optionsOk) missing.push(TEXT.invalid.options)
  // Only a real integer counts: "1" or 1.5 is not a choice the pipeline may apply by default.
  else if (!Number.isInteger(out.recommend) || out.recommend < 1 || out.recommend > options.length) missing.push(TEXT.invalid.recommend)
  if (!missing.length) return { out, downgraded: null }
  return { out: { ...out, verdict: "needs_human" }, downgraded: `${TEXT.invalid.intro(level)} ${TEXT.invalid.join(missing)}` }
}

const GREEN = ["success", "neutral", "skipped"]

// The pipeline's own jobs. The reusable workflows name their one job pipeline-tick,
// pipeline-fix and pipeline-review, and GitHub shows the check run of a called job as
// "<caller job> / <job name>". The dispatcher is started by pull request events, so its check
// run sits on pull request heads next to the repository's CI: a round that failed, was
// cancelled or is still going (the very round that is reading the checks) says nothing about
// the change. This is the one place that knows the names; everything that reads check runs
// (the tick's gather, mergeable, the plan's failed check, the executor's rework feedback, the
// doctor) goes through it. .github/workflows/*.yml must keep the job names (test/workflows.test.mjs).
export const OWN_CHECK = /(^|\/ )pipeline-(tick|fix|review)$/
export const isOwnCheck = (name) => OWN_CHECK.test(String(name || ""))
// The check runs that are the repository's CI: not the pipeline's own jobs, and not a check
// that carries the name of the pipeline's own status (`context`).
export const ciRuns = (runs, context = "") => (runs || []).filter((r) => r && !isOwnCheck(r.name) && (!context || r.name !== context))

// May the tick merge this PR now? -> { ok, why } (why = the first thing in the way, "" when ok).
//   pr:     REST pull request ({ state, draft, head: { sha }, mergeable, mergeable_state })
//   review: { sha, state, released } - the head the reviewer judged, the resulting state
//           (reviewDecision), and whether a human `decision` released this PR
//   checks: { runs: [{ name, status, conclusion }], statuses: [{ context, state }], repoHasChecks }
//           for the head commit; runs as returned with filter=latest, statuses one per
//           context or with created_at/updated_at so the newest per context can be picked.
// Our own status (config.status_context) is left out of the check: it is `review.state`.
// So are the check runs of the pipeline's own jobs (ciRuns).
export function mergeable({ config, pr, review, checks }) {
  const no = (why) => ({ ok: false, why })
  if (config.mode !== "on") return no(TEXT.why.mode(config.mode))
  if (pr?.state && pr.state !== "open") return no(TEXT.why.closed)
  if (pr?.draft) return no(TEXT.why.draft)
  const head = pr?.head?.sha
  if (!review?.sha) return no(TEXT.why.notReviewed)
  if (!head || review.sha !== head) return no(TEXT.why.stale)
  // A human release stands in for a successful review of this head, and only for that: the
  // checks below still apply.
  if (review.state !== "success" && review.released !== true) return no(TEXT.why.state(review.state || "missing"))
  if (pr.mergeable === false || pr.mergeable_state === "dirty") return no(TEXT.why.conflict)
  // null = GitHub is still computing it; the next tick asks again.
  if (pr.mergeable !== true) return no(TEXT.why.unknownMergeable)

  const runs = ciRuns(checks?.runs, config.status_context)
  const newest = new Map()
  for (const s of checks?.statuses || []) {
    if (s.context === config.status_context) continue
    const cur = newest.get(s.context)
    const t = (x) => String(x.updated_at || x.created_at || "")
    // Without timestamps the first one wins: the REST list is newest first.
    if (!cur || t(s) > t(cur)) newest.set(s.context, s)
  }
  // Nothing reported: green only if the repo is known to have no checks. Right after a push
  // the checks of a repo that has them have simply not started, and merging in that gap
  // would skip CI altogether.
  if (!runs.length && !newest.size) return checks?.repoHasChecks === false ? { ok: true, why: "" } : no(TEXT.why.noChecks)
  for (const r of runs) {
    if (r.status !== "completed") return no(TEXT.why.checkPending(r.name))
    if (!GREEN.includes(r.conclusion)) return no(TEXT.why.checkFailed(r.name, r.conclusion || "unknown"))
  }
  for (const s of newest.values()) {
    if (s.state === "pending") return no(TEXT.why.checkPending(s.context))
    if (s.state !== "success") return no(TEXT.why.checkFailed(s.context, s.state || "unknown"))
  }
  return { ok: true, why: "" }
}
