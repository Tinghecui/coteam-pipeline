// The comment the reviewer role leaves on a PR: a part for people, then the hidden `review`
// mark the tick reads. Pure: decision and reviewer output in, text out.
import { REVIEW_RETRIES } from "./decide.mjs"
import { mark } from "./marks.mjs"
import { REVIEW_TEXT as TEXT } from "./text.mjs"

const money = (n) => `$${(Math.round(Number(n) * 100) / 100).toFixed(2)}`
const short = (sha) => String(sha || "").slice(0, 7)

// User-visible wording: REVIEW_TEXT in cli/core/text.mjs.
export { TEXT }

// Limits that keep the comment well under GitHub's 65536 characters whatever the model wrote.
export const MAX_ITEMS = 30
export const MAX_TEXT = 1500
const MAX_PATHS = 20
export const MAX_BODY = 60000

// Text written by a model (which read untrusted PR text) on its way into a comment: it must
// not be able to close or open an HTML comment (and so forge a mark), nor mention people.
export const safeText = (t, max = MAX_TEXT) => {
  const s = String(t ?? "")
    .replace(/\r/g, "")
    .replace(/<!--/g, "&lt;!--")
    .replace(/-->/g, "--&gt;")
    .replace(/@(?=[A-Za-z0-9_-])/g, "@\u200b")
    .trim()
  return s.length > max ? `${s.slice(0, max)}${TEXT.cut}` : s
}
const oneLine = (t, max = MAX_TEXT) => safeText(String(t ?? "").replace(/\s+/g, " "), max)
// Inside `code`: no backticks either.
const code = (t) => `\`${oneLine(t, 300).replace(/`/g, "'")}\``
const list = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : [])

// The JSON the tick reads back (marks.findMarks("review", comments)).
//   a review that ran:  { sha, verdict, level, by, state, waits, pathLevel, reviewerLevel, run,
//                         problems: [{kind, where, what}], followups: [{kind, what}],
//                         ask?, options?: [{what, pros, cons}], recommend?, downgraded? }
//   one that did not:   { sha, failed: true, attempt, reason, by, run, unavailable? }   (no verdict)
// `by` says which role wrote it; who posted the comment is GitHub's to say (findMarks overrides it).
export function reviewMark(decision, out, meta) {
  const base = { sha: String(meta.sha || ""), by: "reviewer", run: String(meta.run || "") }
  if (decision.failed) {
    return { ...base, failed: true, attempt: Number(meta.attempt) || 0, reason: oneLine(meta.failure, 300), ...(meta.unavailable ? { unavailable: String(meta.unavailable) } : {}) }
  }
  const o = out && typeof out === "object" ? out : {}
  const human = decision.state === "pending"
  const options = list(o.options).slice(0, MAX_ITEMS).map((x) => ({ what: oneLine(x.what), pros: oneLine(x.pros), cons: oneLine(x.cons) }))
  return {
    ...base,
    verdict: decision.verdict,
    level: decision.level,
    state: decision.state,
    waits: decision.waits,
    pathLevel: decision.pathLevel,
    reviewerLevel: decision.reviewerLevel,
    problems: list(decision.problems).slice(0, MAX_ITEMS).map((p) => ({ kind: String(p.kind || ""), where: oneLine(p.where, 300), what: oneLine(p.what) })),
    followups: list(o.followups).slice(0, MAX_ITEMS).map((f) => ({ kind: String(f.kind || "other"), what: oneLine(f.what) })),
    // What a decision item is built from; only when a human is asked.
    ...(human && oneLine(o.ask) ? { ask: oneLine(o.ask) } : {}),
    ...(human && !meta.downgraded && decision.verdict === "approve" && options.length >= 2 ? { options, recommend: Number(o.recommend) } : {}),
    ...(meta.downgraded ? { downgraded: oneLine(meta.downgraded, 300) } : {}),
  }
}

function footer(meta, reviewed) {
  const F = TEXT.footer
  const parts = [reviewed ? F.reviewed(short(meta.sha), meta.base || "the base branch", short(meta.baseSha)) : F.notReviewed(short(meta.sha))]
  if (meta.model) parts.push(F.model(oneLine(meta.model, 80)))
  if (meta.turns != null && Number.isFinite(Number(meta.usd))) parts.push(F.cost(meta.turns, money(meta.usd)))
  if (meta.runUrl) parts.push(F.run(meta.runUrl))
  return `<sub>${parts.join("; ")}. ${F.again}</sub>`
}

// decision: reviewDecision() of this review; out: the reviewer's structured output as it was
// judged (after validateReview; null when the review did not run);
// meta: { sha, base, baseSha, mode, approvedLabel, defaultHours, paths, downgraded, failure,
//         unavailable, attempt, retries, model, turns, usd, run, runUrl }
//   paths:    policy.classifyPaths() of the changed files (the ones above level 0 are listed)
//   failure:  why the review did not run; attempt: which failed attempt on this head this is
// The people's part comes first; the mark is the last line.
export function reviewComment(decision, out, meta = {}) {
  // Whatever the model wrote, the comment has to be accepted by GitHub: every piece is cut
  // shorter until the whole fits. Normal reviews fit at the first try.
  for (let max = MAX_TEXT; ; max = Math.floor(max / 2)) {
    const cutText = (t) => (typeof t === "string" && t.length > max ? `${t.slice(0, max)}${TEXT.cut}` : t)
    const cutAll = (items) => (Array.isArray(items) ? items.map((x) => (x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, cutText(v)])) : x)) : items)
    const o = out && typeof out === "object" ? { ...out, summary: cutText(out.summary), ask: cutText(out.ask), followups: cutAll(out.followups), options: cutAll(out.options) } : out
    const body = render({ ...decision, problems: cutAll(decision.problems) }, o, meta)
    if (body.length <= MAX_BODY || max < 50) return body
  }
}

function render(decision, out, meta) {
  const lines = []
  const hidden = mark("review", reviewMark(decision, out, meta))
  if (decision.failed) {
    const retries = meta.retries ?? REVIEW_RETRIES
    const attempt = Number(meta.attempt) || 0
    lines.push(`### ${TEXT.title}: ${TEXT.failedHeading}`, "", safeText(meta.failure) || TEXT.failure.noOutput("?"), "")
    if (meta.unavailable) lines.push(TEXT.failed.unavailable)
    else lines.push(`${TEXT.failed.attempt(attempt)} ${attempt <= retries ? TEXT.failed.retry(retries) : TEXT.failed.noRetry(retries)}`)
    lines.push("", footer(meta, false), "", hidden)
    return lines.join("\n")
  }
  const o = out && typeof out === "object" ? out : {}
  const N = TEXT.next
  lines.push(`### ${TEXT.title}: ${TEXT.heading(TEXT.verdict[decision.verdict] || String(decision.verdict), decision.level)}`, "")
  lines.push(...(safeText(o.summary) || TEXT.noSummary).split("\n").map((l) => `> ${l}`), "")
  if (meta.downgraded) lines.push(TEXT.downgraded(oneLine(meta.downgraded, 400)), "")

  lines.push(TEXT.level(decision.level, decision.pathLevel, decision.reviewerLevel))
  const raised = list(meta.paths).filter((p) => p.level > 0).sort((a, b) => b.level - a.level)
  for (const p of raised.slice(0, MAX_PATHS)) lines.push(`- ${TEXT.pathRule(oneLine(p.path, 300).replace(/`/g, "'"), p.level, String(p.match).replace(/`/g, "'"))}`)
  if (raised.length > MAX_PATHS) lines.push(`- ${TEXT.morePaths(raised.length - MAX_PATHS)}`)
  lines.push("")

  // A human is asked: what about, and between what.
  if (decision.state === "pending") {
    lines.push(`${TEXT.ask}: ${oneLine(o.ask) || TEXT.noAsk}`, "")
    const options = decision.verdict === "approve" && !meta.downgraded ? list(o.options).slice(0, MAX_ITEMS) : []
    if (options.length >= 2) {
      lines.push(`${TEXT.options}:`, "")
      options.forEach((x, k) => {
        lines.push(`${k + 1}. ${oneLine(x.what) || TEXT.notWritten}${Number(o.recommend) === k + 1 ? TEXT.recommended : ""}`)
        lines.push(`   - ${TEXT.pros}: ${oneLine(x.pros) || TEXT.notWritten}`, `   - ${TEXT.cons}: ${oneLine(x.cons) || TEXT.notWritten}`)
      })
      lines.push("")
    }
  }

  const problems = list(decision.problems)
  if (problems.length) {
    lines.push(`${TEXT.problems}:`, "")
    problems.slice(0, MAX_ITEMS).forEach((p, k) => {
      const where = oneLine(p.where, 300)
      lines.push(`${k + 1}. [${TEXT.problemKind[p.kind] || oneLine(p.kind, 40) || TEXT.followupKind.other}]${where ? ` ${code(where)}:` : ""} ${oneLine(p.what) || TEXT.notWritten}`)
    })
    if (problems.length > MAX_ITEMS) lines.push("", TEXT.more(problems.length - MAX_ITEMS))
    lines.push("")
  }

  const followups = list(o.followups)
  if (followups.length) {
    lines.push(`${TEXT.followups}:`, "")
    followups.slice(0, MAX_ITEMS).forEach((f) => lines.push(`- [${TEXT.followupKind[f.kind] || TEXT.followupKind.other}] ${oneLine(f.what) || TEXT.notWritten}`))
    if (followups.length > MAX_ITEMS) lines.push("", TEXT.more(followups.length - MAX_ITEMS))
    lines.push("")
  }

  let next
  if (decision.state === "failure") next = N.failure
  else if (decision.state === "success") next = meta.mode && meta.mode !== "on" ? N.record(meta.mode) : N.success
  else if (decision.waits === "owner") next = decision.verdict === "approve" && decision.level < 3 ? N.decision : N.owner(meta.approvedLabel || "")
  // Defaults are applied only in mode "on"; in record mode the item simply waits.
  else next = meta.mode && meta.mode !== "on" ? N.decision : N.defaults(meta.defaultHours)
  lines.push(`${N.title}: ${next}`, "", footer(meta, true), "", hidden)
  return lines.join("\n")
}
