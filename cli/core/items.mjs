// Decision items: the questions the pipeline puts in front of an owner. One item is one issue
// carrying `labels.decide`; its body starts with a hidden `item` mark holding everything a
// script needs (what it is about, the options and what each one does), followed by the same
// thing in plain language for the person who has to answer.
//
// Pure: no network, no clock (callers pass `now`). The tick (core/plan.mjs) decides when an
// item is opened, answered, applied by default or closed; this file only knows the format.
//
// meta (the `item` mark):
//   { kind, pr | issue, row, level, sha, cause, options: [{ key, what, pros, cons, action, needsText }],
//     recommend: key | null, due: ISO time | null }
//   kind:   "pr-ask"     an approved PR with a product trade-off (level 2): A = the reviewer's
//                        recommended option ... last = close the PR; may apply A by default at `due`
//           "pr-release" a PR only an owner can let through, or one the pipeline cannot move on
//                        its own: A = release as is, B = rework with the text after `B:`, C = close
//           "stuck"      the executor gave up on an issue or ran out of budget: A = try again
//                        (counts restart), B = drop (the work label is removed)
//   cause:  why it was opened (CAUSES); an item is only kept open while its cause still holds
//   sha:    head of the PR when the item was opened; a new head makes the item stale
//   action: what choosing the option does (ACTIONS); the tick turns it into concrete steps
import { mark, parseMark } from "./marks.mjs"
import { ITEMS_TEXT as TEXT } from "./text.mjs"

export const KINDS = ["pr-ask", "pr-release", "stuck"]
export const ACTIONS = ["merge", "rework", "close", "review", "retry", "drop"]
export const CAUSES = {
  "pr-ask": ["level2"],
  "pr-release": ["level3", "needs_human", "draft", "review-failed", "rework-cap", "rework-failed"],
  stuck: ["budget", "gave-up", "refused"],
}
const LETTERS = "ABCDEFGH"
const TITLE_MAX = 110
const BACKGROUND_MAX = 3000

const oneLine = (s, n = 0) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim()
  return n && t.length > n ? `${t.slice(0, n - 1)}…` : t
}
const filled = (v) => typeof v === "string" && v.trim() !== ""
// "2026-11-21 04:00 UTC"
export const fmtTime = (t) => {
  const d = new Date(t)
  return Number.isFinite(d.getTime()) ? `${d.toISOString().slice(0, 16).replace("T", " ")} UTC` : String(t)
}

// User-visible wording: ITEMS_TEXT in cli/core/text.mjs.
export { TEXT }

// ---------- render / parse ----------

const cell = (s) => oneLine(s).replace(/\|/g, "\\|") || TEXT.none
const quote = (text) =>
  String(text)
    .split("\n")
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n")

// meta: see the top of this file. parts (all plain language, no code):
//   subject     one line for the issue title
//   ask         what is being asked (one or two sentences)
//   why         why a person has to decide
//   ifNothing   what happens when nobody answers (default: derived from meta.due)
//   look        where to look (optional)
//   background  longer context, shown folded (optional)
//   owners      logins whose answer counts ([] = repository admins and maintainers)
//   draft       the PR is a draft (changes the wording of "merge")
// -> { title, body }
export function renderItem(meta, parts = {}) {
  const options = meta.options || []
  const when = meta.due ? fmtTime(meta.due) : ""
  const defaults = Boolean(when && meta.recommend)
  const target = meta.kind === "stuck" ? TEXT.ifNothing.issue(meta.issue) : TEXT.ifNothing.pr(meta.pr)
  const rows = options.map((o) => {
    const rec = o.key === meta.recommend
    const label = `${rec ? `**${o.key}** (${TEXT.recommended})` : o.key}`
    const what = `${cell(o.what)}${o.needsText ? ` (${TEXT.needsTextNote}: \`${o.key}: …\`)` : ""}`
    const does = typeof TEXT.does[o.action] === "function" ? TEXT.does[o.action](Boolean(parts.draft)) : TEXT.does[o.action] || TEXT.none
    return `| ${label} | ${what} | ${does} | ${cell(o.pros)} | ${cell(o.cons)} |`
  })
  const background = String(parts.background || "").trim()
  const body = [
    mark("item", meta),
    defaults ? TEXT.heading.defaults(meta.recommend, when) : TEXT.heading.waits,
    "",
    `${TEXT.ask} ${oneLine(parts.ask)}`,
    "",
    `${TEXT.why} ${oneLine(parts.why)}`,
    "",
    TEXT.optionsTitle,
    "",
    TEXT.table.head,
    TEXT.table.sep,
    ...rows,
    "",
    meta.recommend ? TEXT.recommendLine(meta.recommend) : TEXT.noRecommend,
    "",
    `${TEXT.howTitle} ${TEXT.how(TEXT.owners(parts.owners || []))}`,
    "",
    `${TEXT.ifNothingTitle} ${oneLine(parts.ifNothing) || (defaults ? TEXT.ifNothing.defaults(meta.recommend, when) : target)}`,
    ...(parts.look ? ["", `${TEXT.whereTitle} ${oneLine(parts.look)}`] : []),
    ...(background
      ? ["", "<details>", `<summary>${TEXT.background}</summary>`, "", quote(background.length > BACKGROUND_MAX ? `${background.slice(0, BACKGROUND_MAX)}\n${TEXT.backgroundCut}` : background), "", "</details>"]
      : []),
    "",
    TEXT.footer,
  ].join("\n")
  return { title: oneLine(`${TEXT.titlePrefix} ${oneLine(parts.subject)}`, TITLE_MAX), body }
}

// issue: a REST issue ({ number, state, title, body, created_at }). -> the meta plus
// { number, state, title, created_at }, or null when the issue is not a readable decision item.
export function parseItem(issue) {
  const meta = parseMark("item", issue?.body)
  if (!meta || !KINDS.includes(meta.kind) || !Array.isArray(meta.options)) return null
  const options = meta.options.filter((o) => o && typeof o === "object" && /^[A-Z]$/.test(String(o.key)) && ACTIONS.includes(o.action))
  if (!options.length) return null
  const target = Number(meta.kind === "stuck" ? meta.issue : meta.pr)
  if (!Number.isInteger(target) || target <= 0) return null
  return {
    ...meta,
    options,
    recommend: options.some((o) => o.key === meta.recommend) ? meta.recommend : null,
    due: Number.isFinite(Date.parse(meta.due)) ? meta.due : null,
    row: Number(meta.row) || 0,
    sha: String(meta.sha || ""),
    cause: String(meta.cause || ""),
    // Set when the item was rewritten for a new commit: answers older than this were about the old one.
    asked: Number.isFinite(Date.parse(meta.asked)) ? meta.asked : "",
    number: issue.number,
    state: issue.state || "open",
    title: issue.title || "",
    created_at: issue.created_at || "",
  }
}

// Is this comment an answer to the item? An answer is a comment that is an option letter and
// nothing else (`A`, `b.`), or an option letter, a colon and free text (`B: keep the old
// default`). Lower case is accepted. Anything else is not an answer, on purpose: "A good
// idea, but ..." or "I think B" must never be applied as a choice.
//   comment: a REST comment ({ body }) or the text itself
// -> { key, text } | null
export function parseAnswer(comment, item) {
  const body = String((comment && typeof comment === "object" ? comment.body : comment) ?? "")
  const m = /^\s*([A-Za-z])\s*(?:[.!]?\s*$|[:：]\s*([\s\S]*)$)/.exec(body)
  if (!m) return null
  const key = m[1].toUpperCase()
  if (!(item?.options || []).some((o) => o.key === key)) return null
  return { key, text: String(m[2] || "").trim() }
}

// ---------- builders ----------

const letter = (options) => options.map((o, k) => ({ key: LETTERS[k], ...o }))
const dueAt = (config, now) => {
  const hours = Number(config?.merge?.default_after_hours) || 0
  return hours > 0 ? new Date(now.getTime() + hours * 3600000).toISOString() : null
}

// The reviewer's options as it wrote them: [{ what, pros, cons }] with a valid 1-based recommend, or null.
function reviewerOptions(review) {
  const list = Array.isArray(review?.options) ? review.options.filter((o) => o && typeof o === "object" && filled(o.what)) : []
  const rec = review?.recommend
  if (list.length < 2 || list.length !== (review.options || []).length || !Number.isInteger(rec) || rec < 1 || rec > list.length) return null
  return { list: list.slice(0, LETTERS.length - 1), rec: Math.min(rec, LETTERS.length - 1) }
}

// A level-2 approval: the reviewer's question and its options. Option 1 of the reviewer is
// "what the PR does now" (merge); every other one is an instruction for a rework. The
// recommended option comes first (A), closing the PR is always last.
//   pr: { number, title, draft, head: { sha } }; review: the `review` mark of the head, which
//   may carry { ask, options, recommend, summary } as the reviewer wrote them
//   issue, row: what the PR's branch belongs to; owners: whose answer counts; background: the PR's plain summary
export function prAskItem({ pr, review = {}, config, now, issue = 0, row = 0, owners = [], background = "", asked = "" }) {
  const T = TEXT.prAsk
  const ro = reviewerOptions(review)
  let options
  if (ro) {
    const all = ro.list.map((o, k) => ({
      what: k === 0 ? T.keep(oneLine(o.what, 300)) : T.change(oneLine(o.what, 300)),
      pros: oneLine(o.pros, 300) || T.notSaid,
      cons: oneLine(o.cons, 300) || T.notSaid,
      action: k === 0 ? "merge" : "rework",
      needsText: false,
      // what the executor is told when this option is chosen
      ...(k === 0 ? {} : { instruction: oneLine(o.what, 600) }),
    }))
    options = [all[ro.rec - 1], ...all.filter((_, k) => k !== ro.rec - 1)]
  } else {
    options = [
      { what: T.mergeAsIs, pros: TEXT.prRelease.releasePros, cons: T.notSaid, action: "merge", needsText: false },
      { what: T.reworkText, pros: TEXT.prRelease.reworkPros, cons: TEXT.prRelease.reworkCons, action: "rework", needsText: true },
    ]
  }
  options.push({ what: T.close(pr.number), pros: T.closePros, cons: T.closeCons, action: "close", needsText: false })
  const meta = {
    kind: "pr-ask",
    pr: pr.number,
    issue: Number(issue) || 0,
    row: Number(row) || 0,
    level: Number.isInteger(review.level) ? review.level : 2,
    sha: pr.head?.sha || "",
    cause: "level2",
    options: letter(options),
    recommend: "A",
    due: dueAt(config, now),
    ...(asked ? { asked } : {}),
  }
  return {
    meta,
    ...renderItem(meta, {
      subject: TEXT.subject.prAsk(pr.number, oneLine(pr.title, 70)),
      ask: filled(review.ask) ? oneLine(review.ask, 500) : T.askFallback(pr.number),
      why: T.why,
      look: TEXT.prRelease.look(pr.number),
      background: [filled(review.summary) ? oneLine(review.summary, 600) : "", background].filter(Boolean).join("\n\n"),
      owners,
      draft: Boolean(pr.draft),
    }),
  }
}

// A PR that only an owner can move: level 3, needs_human, a draft, a review that never ran,
// or a rework loop that hit its limit. Never applies anything by default.
//   cause: one of CAUSES["pr-release"]; reason: one line saying what happened (shown as is)
export function prReleaseItem({ pr, cause, reason = "", review = {}, issue = 0, row = 0, owners = [], background = "", asked = "" }) {
  const T = TEXT.prRelease
  const C = T.cause[cause] || T.cause.needs_human
  const stuck = cause === "rework-cap" || cause === "rework-failed"
  const options = [
    { what: T.release(Boolean(pr.draft)), pros: T.releasePros, cons: C.releaseCons, action: "merge", needsText: false },
    // After a rejected review there is feedback to follow, so the sentence is optional; otherwise the executor would have nothing to go by.
    { what: T.rework, pros: T.reworkPros, cons: T.reworkCons, action: "rework", needsText: !stuck },
    { what: T.close(pr.number), pros: T.closePros, cons: T.closeCons, action: "close", needsText: false },
    ...(cause === "review-failed" ? [{ what: T.reReview, pros: T.reReviewPros, cons: T.reReviewCons, action: "review", needsText: false }] : []),
  ]
  const meta = {
    kind: "pr-release",
    pr: pr.number,
    issue: Number(issue) || 0,
    row: Number(row) || 0,
    level: Number.isInteger(review?.level) ? review.level : 3,
    sha: pr.head?.sha || "",
    cause,
    options: letter(options),
    recommend: null,
    due: null,
    ...(asked ? { asked } : {}),
  }
  const ask = (cause === "level3" || cause === "needs_human") && filled(review?.ask) ? oneLine(review.ask, 500) : C.ask(pr.number)
  return {
    meta,
    ...renderItem(meta, {
      subject: (stuck || cause === "review-failed" ? TEXT.subject.prStuck : TEXT.subject.prRelease)(pr.number, oneLine(pr.title, 70)),
      ask,
      why: `${C.why}${reason ? ` ${T.reasonLine(oneLine(reason, 400))}` : ""}`,
      look: T.look(pr.number),
      background: [filled(review?.summary) ? oneLine(review.summary, 600) : "", background].filter(Boolean).join("\n\n"),
      owners,
      draft: Boolean(pr.draft),
    }),
  }
}

// The executor gave up on an issue (or a row of a spec issue), or used up its allowance.
//   issue: { number, title }; cause: "budget" | "gave-up"; reason: one line (shown as is)
export function stuckItem({ issue, row = 0, cause = "budget", reason = "", owners = [] }) {
  const T = TEXT.stuck
  const options = [
    { what: T.retry, pros: T.retryPros, cons: T.retryCons, action: "retry", needsText: false },
    { what: T.drop, pros: T.dropPros, cons: T.dropCons, action: "drop", needsText: false },
  ]
  const meta = { kind: "stuck", issue: issue.number, row: Number(row) || 0, level: 2, sha: "", cause, options: letter(options), recommend: null, due: null }
  return {
    meta,
    ...renderItem(meta, {
      subject: TEXT.subject.stuck(issue.number, Number(row) || 0, oneLine(issue.title, 70)),
      ask: T.ask(issue.number, Number(row) || 0),
      why: `${T.why[cause] || T.why.budget}${reason ? ` ${TEXT.prRelease.reasonLine(oneLine(reason, 400))}` : ""}`,
      look: T.look(issue.number),
      owners,
    }),
  }
}

// ---------- comments that record what was decided ----------

// The comment left on the PR (or the issue) when an option is applied. It carries the
// `decision` mark (rework and run counts restart after it) and says in words what was
// decided: the executor reads this text on its next run.
//   how: "answer" | "default" | "label"; text: the owner's free text, or the option's own instruction
export function decisionComment({ item = null, key = null, by = "", action, text = "", sha = "", row = 0, how = "answer", label = "" }) {
  const S = TEXT.decision.said
  const words = action === "rework" ? S.rework(oneLine(text) || TEXT.decision.reworkAsReviewed) : action === "retry" ? S.retry(oneLine(text)) : S[action] || ""
  const who = how === "default" ? TEXT.decision.by.default(item) : how === "label" ? TEXT.decision.by.label(by, label) : TEXT.decision.by.answer(by, item)
  return [mark("decision", { item, key, by: by || null, how, action, ...(sha ? { sha } : {}), ...(row ? { row } : {}), ...(oneLine(text) ? { text: oneLine(text, 300) } : {}) }), `${TEXT.decision.title(key)} ${words}`, "", `<sub>${who}</sub>`].join("\n")
}

// One line saying what applying an option did, for the receipt on the item.
export function appliedWords(action, text = "") {
  const S = TEXT.decision.said
  const w = action === "rework" ? S.rework(oneLine(text) || TEXT.decision.reworkAsReviewed) : action === "retry" ? S.retry(oneLine(text)) : S[action] || ""
  return w ? w[0].toUpperCase() + w.slice(1) : ""
}
