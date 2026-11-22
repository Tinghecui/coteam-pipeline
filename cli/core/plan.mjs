// One round of the scheduler, as a pure function: planTick(state, config, now) -> plan.
// The role (cli/roles/tick.mjs) gathers `state` from GitHub, calls planTick and carries the
// plan out. Nothing here talks to the network or reads a clock.
//
// Everything is derived from what is in `state` (marks in comments, open items, commit
// statuses, workflow runs): the scheduler remembers nothing between rounds, so running it
// twice on the same state plans the same thing, and an action that already left its mark is
// not planned again.
//
// ---------------------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------------------
//   comment = { id, body, created_at, updated_at, user: { login } }          (REST issue comment)
//   run     = { id, status, conclusion, created_at, display_title, html_url, jobs? }
//             status: queued | in_progress | completed ...; display_title carries "#<issue>"
//             (fix runs) / "PR #<n>" (review runs) once the run has started; jobs = number of
//             jobs, when the role looked it up (it does for runs queued for a long time)
//
//   state = {
//     issues:    [{ number, title, body, labels: [name], state_reason, created_at, comments: [comment] }]
//                open issues carrying labels.work
//     prs:       [{ number, title, body, draft, node_id, labels: [name], head: { ref, sha },
//                   mergeable: true | false | null, mergeable_state,
//                   comments: [comment],
//                   statuses:  [{ context, state, description, target_url, created_at, updated_at }]   commit statuses of the head
//                   checkRuns: [{ name, status, conclusion }]                              check runs of the head (latest per name),
//                                                                                          without the pipeline's own jobs
//                   approved:  { by, at } | null }]   who put labels.approved on the PR and when (null: not labelled)
//                open PRs whose head branch is <branch_prefix><issue>-..., from this repository (not a fork)
//     otherPrs:  [{ number, title, body, head: { ref } }]
//                every other open PR (a person's own branch, a fork). Read for one thing: a PR that
//                says it closes a work issue ("Fixes #n") means a person has taken that issue
//     closedPrs: [{ number, title, head: { ref, sha }, merged_at, closed_at, labels: [name] }]
//                PRs on the prefix closed in the last 7 days, merged or not
//     items:     [{ number, title, body, state, created_at, user: { login }, comments: [comment] }]
//                decision items (labels.decide): every open one with its comments, plus the ones
//                closed in the last 7 days (comments not needed)
//     ledger:    [entry]                         core/ledger.mjs
//     runs:      { fix: [run] | null, review: [run] | null }
//                recent runs of pipeline-fix.yml / pipeline-review.yml (running and finished);
//                null = could not be read, and then nothing of that kind is dispatched
//     maintainers: [login]                       admins / maintainers; used when config.owners is empty
//     markAuthors: [login] | null                logins whose marks count (the pipeline's bot); null = not known:
//                                                marks are read whoever wrote them, except that a review
//                                                comment counts only when the commit status names it
//     repoHasChecks: true | false | null         does the repo run checks on PRs; null = work it out from timing
//     refsDone:  { <number>: true }              "#123" dependencies of spec rows that are closed / merged
//   }
//
// ---------------------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------------------
// Every entry says what is done and carries `actions`: the concrete steps, in the order they
// must run, each one of
//   { do: "comment", on, body }             { do: "status", sha, state, context, description }
//   { do: "label", on, add | remove }       { do: "ready", pr, node }
//   { do: "closePr", pr }                   { do: "closeIssue", issue, reason }
//   { do: "openIssue", title, body, labels } { do: "dispatch", workflow, inputs }
//   { do: "merge", pr, sha, method }
// Inside one entry the steps that make the entry idempotent (marks, labels, statuses) come
// first and plain comments last; when a step fails the rest of that entry is skipped.
//
//   plan = {
//     mode,
//     markRows:       [{ issue, row, pr, kind: "done" | "closed", redo, actions }]
//     applyAnswers:   [{ item, key, text, by, how: "answer" | "label", effect, pr | issue, actions }]
//     applyDefaults:  [{ item, key, effect, pr, actions }]            skipped by the role in record mode
//     nudges:         [{ item, comment, key, actions }]               an answer that needs a sentence and has none
//     closeItems:     [{ item, why, actions }]                        stale items
//     refreshItems:   [{ item, kind, cause, pr, actions }]            an open item rewritten in place: the PR got new
//                     commits and the question to ask about them is of the same kind
//     notices:        [{ on, day, actions }]                          said once a day where work waits for the daily budget
//     closeIssues:    [{ issue, rows: [{ row, pr }], actions }]        every row merged
//     openItems:      [{ kind, cause, pr | issue, row, title, actions }]
//     dispatchReview: [{ pr, attempt, actions }]
//     dispatchRework: [{ pr, issue, row, sha, attempt, why, send?, skipped?, item?, actions }]
//                     send / skipped: this head was dispatched before and the executor did not start
//                     (why it said so); this is dispatch number `send` of the same head
//     dispatchFix:    [{ issue, row, actions }]
//     merge:          [{ pr, sha, method, issue, row, by: "review" | "answer" | "label" | "default", item?, actions }]
//                     skipped by the role in record mode (a `notes` line says what would have been merged)
//     labels:         [{ on, remove, actions }]                       a one-time request label that has nothing left to do
//     waiting:        [{ item, kind, pr | issue, due }]                open items nobody has answered yet
//     notes:          [string]                                        why something was not done; for the job log
//     running:        [run]   cooldown: core/ledger.mjs claudeCooldown | null   spentToday: number   runsToday: number
//     held:           why nothing new starts this round ("" = it may)
//     board:          [{ pr?, issue, row, state, text, item? }]   where every piece of work is and what it waits for,
//                     one entry per open pipeline PR and per work issue (core/board.mjs renders it)
//                     state: working | queued | checks | owner | stuck | merging | idle
//   }
// An entry that follows from an answer (`item` set on a merge or a rework) must be skipped by
// the role when applying that answer failed.
import { ciRuns, mergeable, REVIEW_RETRIES } from "./decide.mjs"
import { appliedWords, decisionComment, fmtTime, parseAnswer, parseItem, prAskItem, prReleaseItem, stuckItem, TEXT as ITEM_TEXT } from "./items.mjs"
import { budget, claudeCooldown, countedRuns, NOT_AN_ATTEMPT } from "./ledger.mjs"
import { activeClaims, believedReviews, closedRows, countSince, findMarks, hasMark, isAfter, issueOfBranch, latestReview, mark, reworkObsolete, reworks, rowOfBranch, takesIssue, trustedComments } from "./marks.mjs"
import { parseSpec, specProgress } from "./spec.mjs"
import { PLAN_TEXT as TEXT } from "./text.mjs"

export const FIX_WORKFLOW = "pipeline-fix.yml"
export const REVIEW_WORKFLOW = "pipeline-review.yml"
// A run that has been queued this long without a single job is a ghost: GitHub sometimes
// leaves such runs behind (they never start and cannot be cancelled). It takes no slot.
export const GHOST_RUN_MS = 15 * 60000
// A run that is queued or running but whose title does not name an issue yet could be for any
// issue, so nothing is dispatched while it is there (the source pipeline dispatched the same
// row twice when a slot freed up). After this long it no longer blocks.
export const UNATTRIBUTED_BLOCK_MS = 60 * 60000
// After a cooldown one probe run is sent; once it has run this long the agent is taken to work again.
export const PROBE_OK_MS = 20 * 60000
// A rework was recorded for a head, no run is going, and nothing came of it for this long
// past the executor's time limit: the run was lost. Treated like a rework that failed.
export const REWORK_LOST_GRACE_MS = 30 * 60000
// No check has reported on a head this long after its review: the repository runs no checks on PRs.
export const NO_CHECKS_GRACE_MS = 10 * 60000
// Ledger outcomes of an executor run that mean "I looked and cannot do this".
export const GAVE_UP_OUTCOMES = ["cannot_fix"]
// The executor refused to start for a reason that passes by itself (a `skip` mark that is not
// permanent, e.g. another run held the claim): the same run is not dispatched again for this long.
export const SKIP_BACKOFF_MS = 30 * 60000
const FAILED_CONCLUSIONS = ["failure", "timed_out", "startup_failure"]

// User-visible wording: PLAN_TEXT in cli/core/text.mjs.
export { TEXT }

const lower = (s) => String(s || "").toLowerCase()
const namesOf = (labels) => (labels || []).map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean)
const ms = (t) => Date.parse(t)
const oneLine = (s, n = 0) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim()
  return n && t.length > n ? `${t.slice(0, n - 1)}…` : t
}
const laterIso = (...ts) => ts.filter((t) => Number.isFinite(ms(t))).sort().pop() || ""
const levelOr3 = (v) => (Number.isInteger(v) && v >= 0 && v <= 3 ? v : 3)
// Until when a refusal that passes by itself holds the same run back: SKIP_BACKOFF_MS after
// the comment was last written (the executor renews some of them in place), or the time the
// mark itself names when that is later.
const skipUntil = (skip) => Math.max(ms(laterIso(skip.at, skip.updatedAt)) + SKIP_BACKOFF_MS, Number.isFinite(ms(skip.until)) ? ms(skip.until) : 0)

export function emptyPlan(mode) {
  return {
    mode,
    markRows: [],
    applyAnswers: [],
    applyDefaults: [],
    nudges: [],
    closeItems: [],
    refreshItems: [],
    notices: [],
    closeIssues: [],
    openItems: [],
    dispatchReview: [],
    dispatchRework: [],
    dispatchFix: [],
    merge: [],
    labels: [],
    waiting: [],
    notes: [],
    running: [],
    cooldown: null,
    spentToday: 0,
    runsToday: 0,
    held: "",
    board: [],
  }
}

// The newest status per context is the one that counts (the REST list is newest first).
function ownStatusOf(pr, context) {
  const t = (x) => String(x.updated_at || x.created_at || "")
  let cur = null
  for (const s of pr.statuses || []) if (s.context === context && (!cur || t(s) > t(cur))) cur = s
  return cur
}
const ownStatus = (pr, context) => String(ownStatusOf(pr, context)?.state || "")

// The first check on the head that failed for good: { name, result } | null. A cancelled or
// skipped run is not a failure of the change (mergeable() still waits for it to be green).
// The pipeline's own jobs are not checks of the change at all (decide.mjs ciRuns).
function failedCheck(pr, context) {
  for (const r of ciRuns(pr.checkRuns, context)) if (r.status === "completed" && FAILED_CONCLUSIONS.includes(r.conclusion)) return { name: r.name, result: r.conclusion === "failure" ? "failed" : r.conclusion.replace(/_/g, " ") }
  const newest = new Map()
  const t = (x) => String(x.updated_at || x.created_at || "")
  for (const s of pr.statuses || []) {
    if (s.context === context) continue
    const cur = newest.get(s.context)
    if (!cur || t(s) > t(cur)) newest.set(s.context, s)
  }
  for (const s of newest.values()) if (s.state === "failure" || s.state === "error") return { name: s.context, result: "failed" }
  return null
}

export function planTick(state, config, now = new Date()) {
  const plan = emptyPlan(config.mode)
  if (config.mode === "off") {
    plan.notes.push(TEXT.off)
    return plan
  }
  const L = config.labels
  const lim = config.limits
  const prefix = config.branch_prefix
  const context = config.status_context
  const nowMs = now.getTime()
  const nowIso = now.toISOString()
  const note = (line) => {
    if (!plan.notes.includes(line)) plan.notes.push(line)
  }
  // The status board: the last word on a piece of work wins.
  const board = new Map()
  const show = (key, entry) => board.set(key, entry)
  const B = TEXT.board

  // ---- who and what is believed ----
  // Anyone who can comment can type a mark. When the pipeline's own login is known, a comment
  // that carries a mark counts only if that login wrote it.
  const authors = Array.isArray(state.markAuthors) && state.markAuthors.length ? state.markAuthors.map(lower) : null
  const trusted = (comments) => trustedComments(comments, authors)
  const ownerList = ((config.owners || []).length ? config.owners : state.maintainers || []).map(lower)
  const isOwner = (login) => Boolean(login) && ownerList.includes(lower(login))
  const ownerNames = (config.owners || []).length ? config.owners : []
  if (!ownerList.length) note(TEXT.note.noOwners)

  const issues = (state.issues || []).map((i) => ({ ...i, labels: namesOf(i.labels), comments: trusted(i.comments) })).filter((i) => i.labels.includes(L.work) && !i.labels.includes(L.decide))
  const prs = (state.prs || []).filter((p) => issueOfBranch(p.head?.ref, prefix) > 0).map((p) => ({ ...p, labels: namesOf(p.labels), comments: trusted(p.comments) }))
  // Open pull requests that are not the pipeline's: only looked at for "who has taken this issue".
  const otherPrs = (state.otherPrs || []).filter((p) => !prs.some((x) => x.number === p.number)).sort((a, b) => a.number - b.number)
  const closedPrs = (state.closedPrs || []).filter((p) => issueOfBranch(p.head?.ref, prefix) > 0).map((p) => ({ ...p, labels: namesOf(p.labels) }))
  const ledger = state.ledger || []
  const issuesByNo = new Map(issues.map((i) => [i.number, i]))
  const prsByNo = new Map(prs.map((p) => [p.number, p]))
  const issueOf = (pr) => issueOfBranch(pr.head?.ref, prefix)
  const rowOf = (pr) => rowOfBranch(pr.head?.ref, prefix)?.row || 0

  // ---- decisions already recorded ----
  const decisionsOf = (comments) => findMarks("decision", comments).filter((d) => Number.isFinite(ms(d.at))).sort((a, b) => (isAfter(a, b) ? 1 : -1))
  const lastDecision = (comments) => decisionsOf(comments).pop() || null
  // marks written after the latest decision (all of them when there is none; none when the decision is being made this round)
  const sinceDecision = (d) => (m) => !d || (!d.virtual && isAfter(m, d))

  // ---- workflow runs ----
  const age = (r) => nowMs - ms(r.created_at)
  const classify = (runs, attributed) => {
    const active = (runs || []).filter((r) => r.status !== "completed")
    const ghosts = active.filter((r) => r.status === "queued" && age(r) > GHOST_RUN_MS && (r.jobs === 0 || (r.jobs == null && !attributed(r))))
    const live = active.filter((r) => !ghosts.includes(r))
    return { ghosts, live, unknown: live.filter((r) => !attributed(r) && !(age(r) > UNATTRIBUTED_BLOCK_MS)) }
  }
  const title = (r) => String(r.display_title || r.name || "")
  const fix = classify(state.runs?.fix, (r) => /#\d+/.test(title(r)))
  const rev = classify(state.runs?.review, (r) => /#\d+/.test(title(r)))
  for (const g of [...fix.ghosts, ...rev.ghosts]) note(TEXT.note.ghost(g.id, Math.round(age(g) / 60000)))
  plan.running = fix.live
  // every number a live fix run names: the issue it works on and, for a rework, the PR
  const fixNumbers = new Set(fix.live.flatMap((r) => [...title(r).matchAll(/#(\d+)/g)].map((m) => Number(m[1]))))
  const reviewRunsOf = (n) => (state.runs?.review || []).filter((r) => new RegExp(`#${n}(?!\\d)`).test(title(r)))

  const fixKnown = Array.isArray(state.runs?.fix)
  const reviewKnown = Array.isArray(state.runs?.review)
  let slots = fixKnown ? Math.max(0, lim.max_parallel - fix.live.length) : 0
  if (!fixKnown) note(TEXT.note.runsUnknown("executor"))
  if (!reviewKnown) note(TEXT.note.runsUnknown("review"))
  if (fix.unknown.length) {
    slots = 0
    note(TEXT.note.unattributed(fix.unknown.map((r) => r.id)))
  }
  let reviewsOk = reviewKnown
  if (rev.unknown.length) {
    reviewsOk = false
    note(TEXT.note.unattributed(rev.unknown.map((r) => r.id)))
  }

  // ---- the agent cannot be used (quota, overload, login): everything waits; afterwards one probe first ----
  let cool = claudeCooldown(ledger, now)
  if (cool?.cooling) {
    slots = 0
    reviewsOk = false
    note(TEXT.note.cooling(cool.reason, cool.until))
  } else if (cool) {
    const probes = fix.live.filter((r) => ms(r.created_at) >= ms(cool.until))
    const long = probes.find((r) => age(r) >= PROBE_OK_MS)
    if (long) {
      note(TEXT.note.probeOk(long.id, Math.round(age(long) / 60000)))
      cool = null
    } else if (probes.length) {
      slots = 0
      note(TEXT.note.probeWait(probes.map((r) => r.id)))
    } else {
      slots = Math.min(slots, 1)
      if (slots) note(TEXT.note.probe)
    }
  }
  plan.cooldown = cool

  // ---- today's spend ----
  const spend = budget(ledger, { issue: -1, limits: lim, now })
  plan.spentToday = spend.today
  plan.runsToday = spend.runsToday || 0
  const overDaily = !spend.ok && !spend.capped
  if (overDaily) {
    slots = 0
    reviewsOk = false
  }

  // ---- decision items ----
  const items = (state.items || [])
    .filter((i) => !authors || authors.includes(lower(i.user?.login)))
    .map((i) => {
      const meta = parseItem(i)
      return meta ? { ...meta, comments: trusted(i.comments) } : null
    })
    .filter(Boolean)
    .sort((a, b) => a.number - b.number)
  // Closed first, receipt second: if the receipt cannot be written the item is closed all the same and nothing repeats.
  const closeItemActions = (item, text, reason = "completed") => [
    { do: "closeIssue", issue: item, reason },
    { do: "comment", on: item, body: `${mark("receipt", { item })}\n${text}` },
  ]
  const closeStale = (it, why) => plan.closeItems.push({ item: it.number, why, actions: closeItemActions(it.number, ITEM_TEXT.receipt.stale(why), "not_planned") })

  // The newest answer by an owner on an open item: { key, text, by, comment } | { nudge } | null.
  const answerOf = (it) => {
    const nudged = new Set(findMarks("nudge", it.comments).map((m) => String(m.comment)))
    for (const c of [...it.comments].reverse()) {
      if (hasMark(c.body)) continue
      // The item was rewritten for a new commit since: what was answered before was about the old one.
      if (it.asked && !(String(c.created_at || "") > it.asked)) continue
      const a = parseAnswer(c, it)
      if (!a) continue
      const login = c.user?.login || ""
      if (!isOwner(login)) {
        note(TEXT.note.notOwner(it.number, login))
        continue
      }
      const opt = it.options.find((o) => o.key === a.key)
      if (opt.needsText && !a.text) {
        note(TEXT.note.needsText(it.number, a.key))
        return { nudge: !nudged.has(String(c.id)), key: a.key, comment: c.id }
      }
      return { ...a, by: login, comment: c.id }
    }
    return null
  }

  // Turn "option `key` of item `it`" into the steps that record it. The dispatch or merge
  // that follows is planned by the ordinary rules below, which see the decision as made.
  const applyEntry = (it, { key, text = "", by = "", how }) => {
    const opt = it.options.find((o) => o.key === key)
    const action = opt.action
    const pr = it.kind === "stuck" ? null : prsByNo.get(it.pr)
    const said = action === "rework" ? [opt.instruction, text].filter(Boolean).join(" ") : text
    const decision = decisionComment({ item: it.number, key, by, action, text: said, sha: pr?.head?.sha || "", row: it.row, how })
    const target = it.kind === "stuck" ? it.issue : it.pr
    const first =
      action === "merge"
        ? [{ do: "status", sha: pr.head.sha, state: "success", context, description: TEXT.status.released(how === "default" ? "" : by, it.number).slice(0, 140) }, ...(pr.draft ? [{ do: "ready", pr: pr.number, node: pr.node_id || "" }] : [])]
        : action === "close"
          ? [{ do: "closePr", pr: it.pr }]
          : action === "drop"
            ? [{ do: "label", on: it.issue, remove: L.work }]
            : []
    return {
      item: it.number,
      key,
      text,
      by,
      how,
      effect: action,
      ...(it.kind === "stuck" ? { issue: it.issue } : { pr: it.pr }),
      actions: [...first, { do: "comment", on: target, body: decision }, ...closeItemActions(it.number, ITEM_TEXT.receipt.applied(key, appliedWords(action, said)))],
      virtual: { virtual: true, at: nowIso, id: Infinity, payload: { item: it.number, action, sha: pr?.head?.sha || "" }, text: said, by, how, item: it.number },
    }
  }
  const strip = ({ virtual, ...entry }) => entry

  // Does the item ask about the change itself (and not about trouble the pipeline ran into)?
  // Such a question usually comes back after a rework, and is then kept in the same item.
  const aboutChange = (it) => it.kind === "pr-ask" || (it.kind === "pr-release" && ["level3", "needs_human", "draft"].includes(it.cause))
  // Open items by what they are about. Items that can be settled without looking further are settled here.
  const openByPr = new Map()
  const openByIssue = new Map()
  const answers = new Map() // item number -> answer
  for (const it of items.filter((i) => i.state === "open")) {
    const map = it.kind === "stuck" ? openByIssue : openByPr
    const target = it.kind === "stuck" ? it.issue : it.pr
    if (it.kind === "stuck") {
      const issue = issuesByNo.get(target)
      if (!issue) {
        closeStale(it, TEXT.stale.issueGone(target, L.work))
        continue
      }
      if (decisionsOf(issue.comments).some((d) => Number(d.payload.item) === it.number)) {
        closeStale(it, TEXT.stale.applied)
        continue
      }
    } else {
      const pr = prsByNo.get(target)
      if (!pr) {
        const gone = closedPrs.find((p) => p.number === target)
        closeStale(it, gone ? TEXT.stale.prGone(target, Boolean(gone.merged_at)) : TEXT.stale.prMissing(target))
        continue
      }
      if (decisionsOf(pr.comments).some((d) => Number(d.payload.item) === it.number)) {
        closeStale(it, TEXT.stale.applied)
        continue
      }
      // New commits since it was opened: what it asks is about a commit that is gone. It is
      // kept, unanswerable, until the new head has been looked at: the same kind of question
      // is then written into this item (one issue per question, however many commits), any
      // other outcome closes it.
      // An item about the process (a rework that failed, a review that never ran) is simply
      // closed, as it always was: a new commit means that trouble is over.
      if (it.sha && it.sha !== pr.head?.sha) {
        if (!aboutChange(it)) {
          closeStale(it, TEXT.stale.newHead(target))
          continue
        }
        it.outdated = true
      }
    }
    if (map.has(target)) {
      closeStale(it, TEXT.stale.duplicate(map.get(target).number))
      continue
    }
    map.set(target, it)
    if (it.outdated) continue
    const a = answerOf(it)
    if (a && "nudge" in a) {
      // An option that needs a sentence, answered without one: said once, then the item goes on waiting.
      if (a.nudge) plan.nudges.push({ item: it.number, comment: a.comment, key: a.key, actions: [{ do: "comment", on: it.number, body: `${mark("nudge", { comment: a.comment })}\n${ITEM_TEXT.receipt.needsText(a.key)}` }] })
    } else if (a) answers.set(it.number, a)
  }
  // Was this already asked? (an item, open or closed, opened after the latest decision for the same thing)
  const askedBefore = (want, target, lastD) =>
    items.some(
      (i) =>
        i.kind === want.kind &&
        (i.kind === "stuck" ? i.issue === target && i.row === (want.row || 0) : i.pr === target && i.sha === want.sha) &&
        i.cause === want.cause &&
        i.state !== "open" &&
        (!lastD || lastD.virtual || i.created_at > lastD.at),
    )
  const sameAsk = (it, want) => it.kind === want.kind && it.cause === want.cause && (it.kind !== "stuck" || it.row === (want.row || 0))

  // ---- pull requests ----
  // What one PR needs now, given a decision that is being made this round (`v`) or none.
  // Nothing is written to the plan here: the caller may evaluate a PR twice.
  const evalPr = (pr, v) => {
    const out = { want: null, rework: null, review: null, merge: null, settled: false, notes: [] }
    const n = pr.number
    const head = pr.head?.sha || ""
    const issueNo = issueOf(pr)
    const row = rowOf(pr)
    const cs = pr.comments
    if (!head || v?.payload.action === "close") return out
    const issueComments = issuesByNo.get(issueNo)?.comments || []
    // The latest decision on the PR itself (what an owner said about this PR) ...
    const lastD = v || lastDecision(cs)
    // ... and the latest one on the PR or its issue: rework and review counts start again after
    // it, the same way the executor counts (marks.countSince over both comment lists).
    const after = sinceDecision(v || lastDecision([...cs, ...issueComments]))
    const released = v?.payload.action === "merge"
    // A verdict counts only together with the commit status the reviewer sets with it: a
    // comment can be typed by anyone, the status cannot. When the pipeline's own login is
    // known, its comment is trusted as it is, and says itself which status it stands for.
    // When it is not, a review comment counts only if the status names that very comment;
    // one that the status does not name is a review that did not finish (or was typed by
    // someone), and the review is run again.
    const believed = believedReviews(cs, { authors, status: ownStatusOf(pr, context) })
    const latest = latestReview(believed)
    const latestMark = latest && latest.sha === head ? findMarks("review", believed).find((m) => m.id === latest.id)?.payload || {} : null
    const st = released ? "success" : ownStatus(pr, context) || (authors && latestMark ? String(latestMark.state || "") : "")
    const reviewed = latestMark && st ? latest : null
    // The full mark of that review: the reviewer's question and options ride along in it.
    const reviewMark = reviewed ? { ...latestMark, ...reviewed } : null
    const draft = Boolean(pr.draft) && !released
    const fixRunning = fixNumbers.has(issueNo) || fixNumbers.has(n)
    const base = { pr, issue: issueNo, row, owners: ownerNames, background: "" }

    // -- does it have to go back to the executor? --
    // An owner asked for a change to this very head. `asked` = and it has not been sent back
    // yet; once it has, the rework is waited for (or found failed) like any other.
    const ownerWants = Boolean(lastD) && lastD.payload.action === "rework" && (Boolean(lastD.virtual) || lastD.payload.sha === head)
    const asked = ownerWants && (Boolean(lastD.virtual) || !reworks(cs).some((r) => isAfter(r, lastD)))
    const check = failedCheck(pr, context)
    const why = ownerWants
      ? TEXT.why.owner(oneLine(lastD.virtual ? lastD.text : lastD.payload.text, 300) || ITEM_TEXT.decision.reworkAsReviewed)
      : reviewed?.verdict === "reject" && st !== "success"
        ? TEXT.why.rejected
        : check
          ? TEXT.why.check(check.name, check.result)
          : pr.mergeable === false || pr.mergeable_state === "dirty"
            ? TEXT.why.conflict
            : ""
    if (why) {
      if (fixRunning) {
        out.notes.push(TEXT.note.fixRunning(`PR #${n}`))
        out.show = { state: "working", text: B.reworking }
        return out
      }
      const rounds = reworks(cs).filter(after)
      // One attempt per earlier head that was sent back, whoever wrote the marks (the tick when
      // it dispatches, the executor when it is done). The current head's own marks are not an
      // earlier attempt; the executor's precheck counts the same way.
      const attempts = new Set(rounds.filter((r) => r.sha !== head).map((r) => r.sha)).size
      let again = {}
      if (!asked) {
        const here = rounds.filter((r) => r.sha === head && !reworkObsolete(r, pr, believed))
        const failed = here.filter((r) => r.failed).pop()
        const pending = here.pop()
        if (failed) {
          out.want = { kind: "pr-release", cause: "rework-failed", sha: head, build: (extra) => prReleaseItem({ ...extra, ...base, cause: "rework-failed", review: reviewMark, reason: TEXT.reason.failed(failed.attempt || attempts, oneLine(failed.why, 200), why) }) }
          return out
        }
        // The executor says in a `skip` mark when it refused to start.
        const skip = pending ? findMarks("skip", cs).filter((k) => isAfter(k, pending) && (!k.sha || k.sha === head)).pop() : null
        if (skip?.permanent === true) {
          out.want = { kind: "pr-release", cause: "rework-failed", sha: head, build: (extra) => prReleaseItem({ ...extra, ...base, cause: "rework-failed", review: reviewMark, reason: `${TEXT.reason.refused(oneLine(skip.why, 60))} Still: ${why}.` }) }
          return out
        }
        if (skip) {
          // It passes by itself: send the same head again, but not every round.
          const until = skipUntil(skip)
          if (nowMs < until) {
            out.notes.push(TEXT.note.skipWait(`PR #${n}`, oneLine(skip.why, 60)))
            out.show = { state: "queued", text: B.skipWait(oneLine(skip.why, 60), new Date(until).toISOString()) }
            return out
          }
          again = { send: rounds.filter((r) => r.sha === head).length + 1, skipped: oneLine(skip.why, 60) }
        } else if (pending) {
          // Dispatched for this very head: wait for the new commit. A run that died without a trace must not leave the PR hanging for ever.
          const lostAfter = lim.executor_minutes * 60000 + REWORK_LOST_GRACE_MS
          if (nowMs - ms(pending.at) <= lostAfter) {
            out.notes.push(TEXT.note.reworkPending(n))
            out.show = { state: "working", text: B.reworkWaits(oneLine(why, 200)) }
            return out
          }
          out.want = { kind: "pr-release", cause: "rework-failed", sha: head, build: (extra) => prReleaseItem({ ...extra, ...base, cause: "rework-failed", review: reviewMark, reason: TEXT.reason.lost(pending.attempt || attempts, Math.round((nowMs - ms(pending.at)) / 60000), why) }) }
          return out
        }
        if (attempts >= lim.max_rework) {
          out.want = { kind: "pr-release", cause: "rework-cap", sha: head, build: (extra) => prReleaseItem({ ...extra, ...base, cause: "rework-cap", review: reviewMark, reason: TEXT.reason.cap(attempts, lim.max_rework, why) }) }
          return out
        }
      }
      const claim = activeClaims(issueComments, { now })[0]
      if (claim) {
        out.notes.push(TEXT.note.claimed(issueNo, claim.run))
        out.show = { state: "working", text: B.claimed(claim.run) }
        return out
      }
      // The executor refuses to start once its own allowance for the issue (or row) is used up;
      // dispatching it anyway would repeat every round and leave no trace. Both sides count
      // from the latest decision on the PR or on the issue.
      const since = v ? nowIso : countSince(cs, issueComments)
      const b = budget(ledger, { issue: issueNo, row: row || null, limits: lim, now, since })
      if (b.capped) {
        out.want = { kind: "pr-release", cause: "rework-cap", sha: head, build: (extra) => prReleaseItem({ ...extra, ...base, cause: "rework-cap", review: reviewMark, reason: TEXT.reason.budget(b.reason, why) }) }
        return out
      }
      out.rework = { pr: n, issue: issueNo, row, sha: head, attempt: attempts + 1, why, ...again }
      return out
    }

    // -- has the head been reviewed? --
    if (!reviewed && st !== "success") {
      if (fixRunning) {
        out.notes.push(TEXT.note.fixRunning(`PR #${n}`))
        out.show = { state: "working", text: B.reworking }
        return out
      }
      const mine = reviewRunsOf(n)
      if (mine.some((r) => r.status !== "completed" && !rev.ghosts.includes(r))) {
        out.notes.push(TEXT.note.reviewRunning(n))
        out.show = { state: "working", text: B.reviewing }
        return out
      }
      const all = findMarks("review", cs)
      // A review that failed because the agent itself was unavailable is not counted: that is not this PR's fault.
      // A verdict on this head that is not believed (login not known, and the status does not
      // name it) is counted: each one is a review that ran and could not vouch for itself, and
      // without a count the reviewer would be started again every round for ever.
      const unbound = all.filter((m) => m.verdict && m.sha === head && after(m) && !believed.some((c) => c.id === m.id)).length
      const failedMarks = unbound + all.filter((m) => m.failed === true && !m.unavailable && m.sha === head && after(m)).length
      // Runs that ended without leaving any mark (the workflow itself broke): counted too, or
      // the review would be dispatched again every round for ever.
      const lastWord = laterIso(...all.map((m) => m.updatedAt), lastD && !lastD.virtual ? lastD.at : "")
      const lost = lastD?.virtual ? 0 : mine.filter((r) => r.status === "completed" && (!lastWord || r.created_at > lastWord)).length
      const tries = failedMarks + lost
      if (tries > REVIEW_RETRIES) {
        out.want = { kind: "pr-release", cause: "review-failed", sha: head, build: (extra) => prReleaseItem({ ...extra, ...base, cause: "review-failed", reason: TEXT.reason.review(tries) }) }
        return out
      }
      out.review = { pr: n, attempt: tries + 1 }
      return out
    }

    // -- reviewed (or released by an owner): merge, or wait for a person --
    const level = reviewed ? levelOr3(reviewed.level) : 3
    if (st === "success" && !draft) {
      // No check at all on the head: green only when the repository runs none. Without being
      // told, that is assumed once the head has been quiet for a while after its review.
      const quiet = released ? 0 : nowMs - ms(reviewed?.at || lastD?.at || nowIso)
      const repoHasChecks = typeof state.repoHasChecks === "boolean" ? state.repoHasChecks : quiet >= NO_CHECKS_GRACE_MS ? false : null
      const m = mergeable({
        config: { ...config, mode: "on" },
        pr: { ...pr, state: "open", draft: false },
        review: { sha: head, state: "success" },
        checks: { runs: ciRuns(pr.checkRuns, context), statuses: pr.statuses || [], repoHasChecks },
      })
      // Approved (or released) with nothing left to ask: only the merge is still to come.
      out.settled = true
      if (m.ok) out.merge = { pr: n, sha: head, method: config.merge.method, issue: issueNo, row, level }
      else {
        out.notes.push(TEXT.note.notMerged(n, m.why))
        out.show = { state: "checks", text: B.notMerged(m.why) }
      }
      return out
    }
    const verdict = reviewed?.verdict || ""
    // The comment says one thing, the status (which only the pipeline can set) another: believe the status and wait.
    if (verdict === "approve" && (st === "failure" || st === "error" || (!draft && level <= config.merge.auto_max_level))) {
      out.notes.push(TEXT.note.statusLag(n, { context, state: st }))
      out.show = { state: "checks", text: B.statusLag }
      return out
    }
    if (!draft && verdict === "approve" && level < 3) {
      out.want = { kind: "pr-ask", cause: "level2", sha: head, build: (extra) => prAskItem({ ...extra, ...base, review: reviewMark, config, now }) }
      return out
    }
    const cause = draft ? "draft" : verdict === "needs_human" ? "needs_human" : "level3"
    out.want = { kind: "pr-release", cause, sha: head, build: (extra) => prReleaseItem({ ...extra, ...base, cause, review: reviewMark }) }
    return out
  }

  const reworkCands = []
  const reviewCands = []
  // Where work is due: if today's budget keeps it from starting, that is said there (once a day).
  const held = []
  // The PR is between two states (a rework or a review is due or going): there is nothing to
  // ask right now, and what will have to be asked is not known yet.
  const inFlux = (res) => !res.want && !res.settled && Boolean(res.rework || res.review || res.notes.length)
  const openItem = (built, extra) => plan.openItems.push({ kind: built.meta.kind, cause: built.meta.cause, ...extra, title: built.title, actions: [{ do: "openIssue", title: built.title, body: built.body, labels: [L.decide] }] })

  for (const pr of prs) {
    const n = pr.number
    const head = pr.head?.sha || ""
    let it = openByPr.get(n) || null
    let v = null
    let by = "review"
    let a = it && answers.get(it.number)
    // An answer given while the PR is on its way to another commit is not applied to the old
    // one; it counts again if the PR comes back to the same question without a new commit.
    if (a && aboutChange(it) && inFlux(evalPr(pr, null))) {
      note(TEXT.note.heldAnswer(it.number, n))
      a = null
    }
    if (a) {
      const entry = applyEntry(it, { ...a, how: "answer" })
      plan.applyAnswers.push(strip(entry))
      v = entry.virtual
      by = "answer"
    } else if (pr.labels.includes(L.approved) && head && ownStatus(pr, context) !== "success") {
      // The owner put the release label on: the same as answering "release as is". The label
      // must be newer than the last word on this head, or a label left on from an earlier
      // commit would release every later one unseen.
      const who = pr.approved?.by || ""
      const judged = laterIso(...findMarks("review", pr.comments).filter((m) => m.sha === head).map((m) => m.updatedAt))
      if (!isOwner(who)) note(TEXT.note.labelNotOwner(n, who, L.approved))
      else if (!judged || !(pr.approved.at > judged)) note(TEXT.note.labelOld(n, L.approved))
      else {
        const body = decisionComment({ item: it?.number ?? null, by: who, action: "merge", sha: head, row: rowOf(pr), how: "label", label: L.approved })
        plan.applyAnswers.push({
          item: it?.number ?? null,
          key: null,
          text: "",
          by: who,
          how: "label",
          effect: "merge",
          pr: n,
          actions: [
            { do: "status", sha: head, state: "success", context, description: TEXT.status.released(who, 0).slice(0, 140) },
            ...(pr.draft ? [{ do: "ready", pr: n, node: pr.node_id || "" }] : []),
            { do: "comment", on: n, body },
            ...(it ? closeItemActions(it.number, ITEM_TEXT.receipt.applied("A", appliedWords("merge"))) : []),
          ],
        })
        v = { virtual: true, at: nowIso, id: Infinity, payload: { item: it?.number ?? null, action: "merge", sha: head }, text: "", by: who, how: "label", item: it?.number ?? null }
        by = "label"
      }
    }
    let res = evalPr(pr, v)
    // Past its time and still the question to ask: the recommended option applies (pr-ask only).
    if (!v && it && !it.outdated && it.kind === "pr-ask" && it.due && it.recommend && config.merge.default_after_hours > 0 && nowMs >= ms(it.due) && res.want && sameAsk(it, res.want)) {
      const entry = applyEntry(it, { key: it.recommend, how: "default" })
      plan.applyDefaults.push(strip(entry))
      if (config.mode === "on") {
        v = entry.virtual
        by = "default"
        res = evalPr(pr, v)
      } else note(TEXT.record.default(it.number, it.recommend))
    }
    for (const line of res.notes) note(line)
    if (v) it = null
    let shown = res.show || null
    const asking = (number, due) => ({ state: "owner", text: B.item(number, due ? fmtTime(due) : ""), item: number })
    if (res.want && !v) {
      if (it && sameAsk(it, res.want) && !it.outdated) {
        plan.waiting.push({ item: it.number, kind: it.kind, pr: n, due: it.due })
        shown = asking(it.number, it.due)
      } else if (it && sameAsk(it, res.want)) {
        // The same kind of question about the new commit: the item is rewritten, not replaced.
        // The body first: it carries the new commit and since when the question stands, which
        // is what keeps this from being done twice and an old answer from being applied.
        const built = res.want.build({ asked: nowIso })
        plan.refreshItems.push({
          item: it.number,
          kind: it.kind,
          cause: it.cause,
          pr: n,
          actions: [
            { do: "editIssue", issue: it.number, title: built.title, body: built.body },
            { do: "comment", on: it.number, body: `${mark("refresh", { sha: head })}\n${ITEM_TEXT.receipt.refreshed(n, head.slice(0, 7), built.meta.due ? fmtTime(built.meta.due) : "")}` },
          ],
        })
        plan.waiting.push({ item: it.number, kind: it.kind, pr: n, due: built.meta.due })
        shown = asking(it.number, built.meta.due)
      } else {
        // The open item asks about something that is no longer the question: it goes, the new one comes.
        if (it) closeStale(it, TEXT.stale.changed(n))
        if (askedBefore(res.want, n, lastDecision(pr.comments))) {
          note(TEXT.note.asked(`PR #${n}`))
          shown = { state: "stuck", text: B.asked }
        } else {
          openItem(res.want.build(), { pr: n, row: rowOf(pr) })
          shown = { state: "owner", text: B.itemOpened }
        }
      }
    } else if (it && aboutChange(it) && inFlux(res)) plan.waiting.push({ item: it.number, kind: it.kind, pr: n, due: null, hold: true })
    else if (it) closeStale(it, TEXT.stale.notNeeded(n))
    const tie = v?.item ? { item: v.item } : {}
    if (res.merge) {
      plan.merge.push({ ...res.merge, by, ...tie, actions: [{ do: "merge", pr: n, sha: res.merge.sha, method: res.merge.method }] })
      if (config.mode !== "on") note(TEXT.record.merge(n, res.merge.level))
    }
    if (res.rework) reworkCands.push({ ...res.rework, ...tie })
    if (res.review) reviewCands.push(res.review)
    if (res.rework || res.review) held.push({ on: n, comments: pr.comments })
    if (res.merge) shown = config.mode === "on" ? { state: "merging", text: B.merging(by === "review" ? "" : v?.by || "") } : { state: "idle", text: B.recordMerge }
    else if (!shown && v) shown = { state: "working", text: B.answered(v.by) }
    // A rework or a review that is due: where it stands is known once the slots are handed out.
    show(`pr:${n}`, { pr: n, issue: issueOf(pr), row: rowOf(pr), ...(shown || { state: "idle", text: B.nothing }) })
  }

  // ---- work issues ----
  const fixCands = []
  for (const issue of [...issues].sort((a, b) => a.number - b.number)) {
    const n = issue.number
    const shownAs = (state, text, row = 0, extra = {}) => show(`issue:${n}`, { issue: n, row, state, text, ...extra })
    let cs = issue.comments
    let it = openByIssue.get(n) || null
    let v = null
    const a = it && answers.get(it.number)
    if (a) {
      const entry = applyEntry(it, { ...a, how: "answer" })
      plan.applyAnswers.push(strip(entry))
      v = entry.virtual
      it = null
      if (entry.effect === "drop") {
        shownAs("idle", B.dropped(entry.by))
        continue
      }
    }
    const spec = parseSpec(issue.body)
    if (spec.problems.length) {
      note(TEXT.note.specProblem(n, spec.problems[0]))
      if (it) plan.waiting.push({ item: it.number, kind: it.kind, issue: n, due: null })
      shownAs("stuck", B.specProblem(spec.problems[0]))
      continue
    }
    const myOpen = prs.filter((p) => issueOf(p) === n)
    const myClosed = closedPrs.filter((p) => issueOf(p) === n)
    const redoAsked = issue.labels.includes(L.redo)
    const markClosed = (c) => {
      const redo = c.redo || redoAsked
      if (c.marked && (!redo || c.markedRedo)) return
      plan.markRows.push({
        issue: n,
        row: c.row,
        pr: c.pr,
        kind: "closed",
        redo,
        actions: [
          // The label is a one-time request: taken off first, so the comment is not written again next round.
          ...(redoAsked ? [{ do: "label", on: n, remove: L.redo }] : []),
          { do: "comment", on: n, body: `${mark("row-closed", { row: c.row, pr: c.pr, ...(redo ? { redo: true } : {}) })}\n${redo ? TEXT.comment.rowRedo(c.row, c.pr) : TEXT.comment.rowClosed(c.row, c.pr, L.redo)}` },
        ],
      })
    }
    const marksBefore = plan.markRows.length
    let row = 0
    if (spec.isSpec) {
      const progress = (comments) => specProgress(spec, { issue: n, branchPrefix: prefix, redoLabel: L.redo, openPrs: myOpen, closedPrs: myClosed, comments, refsDone: state.refsDone || {} })
      let prog = progress(cs)
      for (const u of prog.unmarked)
        plan.markRows.push({ issue: n, row: u.row, pr: u.pr, kind: "done", redo: false, actions: [{ do: "comment", on: n, body: `${mark("row-done", { row: u.row, pr: u.pr })}\n${TEXT.comment.rowDone(u.row, u.pr)}` }] })
      for (const c of prog.closed) markClosed(c)
      if (redoAsked && prog.stopped.length) {
        // The redo label on the issue releases every stopped row: read the progress again as if that were already recorded.
        cs = [...cs, ...prog.stopped.map((c) => ({ id: 0, body: mark("row-closed", { row: c.row, pr: c.pr, redo: true }), created_at: nowIso, user: { login: "" } }))]
        prog = progress(cs)
      }
      if (prog.done) {
        if (issue.state_reason === "reopened" && !prog.unmarked.length) note(TEXT.note.reopened(n))
        else plan.closeIssues.push({ issue: n, rows: prog.merged, actions: [{ do: "closeIssue", issue: n, reason: "completed" }, { do: "comment", on: n, body: `${mark("finished", { rows: prog.merged.length })}\n${TEXT.comment.finished(prog.merged)}` }] })
        shownAs(plan.closeIssues.some((c) => c.issue === n) ? "merging" : "idle", plan.closeIssues.some((c) => c.issue === n) ? B.finished : B.reopened)
        if (it) closeStale(it, TEXT.stale.issueNotNeeded(n))
        continue
      }
      const open = prog.open[0] || (myOpen[0] ? { row: rowOf(myOpen[0]), pr: myOpen[0].number, draft: Boolean(myOpen[0].draft) } : null)
      if (open) {
        note(TEXT.note.inProgress(n, open.row, open.pr, open.draft))
        shownAs("working", B.inProgress(open.pr), open.row, { inPr: open.pr })
        if (it) closeStale(it, TEXT.stale.issueNotNeeded(n))
        continue
      }
      if (!prog.next) {
        note(TEXT.note.blocked(n, prog.blocked || TEXT.note.noRow))
        if (it) plan.waiting.push({ item: it.number, kind: it.kind, issue: n, due: null })
        shownAs(it ? "owner" : "queued", it ? B.item(it.number, "") : B.blocked(prog.blocked || TEXT.note.noRow), 0, it ? { item: it.number } : {})
        continue
      }
      row = prog.next.n
    } else {
      // A single task: one PR. A merged PR that is not recorded yet finishes the issue; one that
      // is recorded belongs to an earlier round of an issue that was reopened since.
      const recorded = new Set(findMarks("row-done", cs).filter((m) => Number(m.row || 0) === 0).map((m) => Number(m.pr)))
      const merged = myClosed.filter((p) => p.merged_at && !rowOfBranch(p.head?.ref, prefix) && !recorded.has(p.number)).sort((x, y) => x.number - y.number).pop()
      if (merged) {
        shownAs("merging", B.finished)
        plan.markRows.push({ issue: n, row: 0, pr: merged.number, kind: "done", redo: false, actions: [{ do: "comment", on: n, body: `${mark("row-done", { row: 0, pr: merged.number })}\n${TEXT.comment.taskDone(merged.number)}` }] })
        plan.closeIssues.push({ issue: n, rows: [{ row: 0, pr: merged.number }], actions: [{ do: "closeIssue", issue: n, reason: "completed" }, { do: "comment", on: n, body: `${mark("finished", { rows: 1 })}\n${TEXT.comment.finishedTask(merged.number)}` }] })
        if (it) closeStale(it, TEXT.stale.issueNotNeeded(n))
        continue
      }
      if (myOpen.length) {
        note(TEXT.note.inProgress(n, 0, myOpen[0].number, Boolean(myOpen[0].draft)))
        shownAs("working", B.inProgress(myOpen[0].number), 0, { inPr: myOpen[0].number })
        if (it) closeStale(it, TEXT.stale.issueNotNeeded(n))
        continue
      }
      const gone = closedRows(n, { closedPrs: myClosed, comments: cs, prefix, redoLabel: L.redo }).get(0)
      // A closed PR older than a merged one is history, not a stop.
      if (gone && gone.pr > Math.max(0, ...recorded)) {
        markClosed({ row: 0, ...gone })
        if (!gone.redo && !redoAsked) {
          note(TEXT.note.closedNotRedone(n, gone.pr, L.redo))
          if (it) plan.waiting.push({ item: it.number, kind: it.kind, issue: n, due: null })
          shownAs("stuck", B.closedNotRedone(gone.pr, L.redo))
          continue
        }
      }
    }
    if (redoAsked && !plan.markRows.slice(marksBefore).some((m) => m.kind === "closed")) {
      plan.labels.push({ on: n, remove: L.redo, actions: [{ do: "label", on: n, remove: L.redo }] })
      note(TEXT.note.redoNothing(n, L.redo))
    }
    // A person opened a pull request of their own that says it closes this issue: they have
    // taken it. Nothing is dispatched (the executor would only refuse and say so) and nobody
    // is asked anything while that pull request is open; one note per round says why.
    const taken = otherPrs.find((p) => takesIssue(p, n, prefix))
    if (taken) {
      note(TEXT.note.taken(n, taken.number))
      if (it) plan.waiting.push({ item: it.number, kind: it.kind, issue: n, due: null })
      shownAs("idle", B.taken(taken.number), row)
      continue
    }
    if (fixNumbers.has(n)) {
      note(TEXT.note.fixRunning(`#${n}`))
      shownAs("working", B.working, row)
      continue
    }
    const claim = activeClaims(cs, { now })[0]
    if (claim) {
      note(TEXT.note.claimed(n, claim.run))
      shownAs("working", B.claimed(claim.run), row)
      continue
    }
    const lastD = v || lastDecision(cs)
    const since = v ? nowIso : countSince(cs)
    const b = budget(ledger, { issue: n, row: spec.isSpec ? row : null, limits: lim, now, since })
    const mine = countedRuns(ledger, { issue: n, row: spec.isSpec ? row : null, since })
    // The executor also says on the issue how every run that opened a PR or pushed nothing
    // ended (`result` marks). More of those than ledger lines means the ledger is not being
    // written (its branch cannot be pushed to, say). Then the marks are what is counted: a
    // run that fails would otherwise be dispatched again every round, outside every budget.
    const results = findMarks("result", cs).filter((k) => sinceDecision(lastD)(k) && Number(k.row || 0) === row && !NOT_AN_ATTEMPT.includes(k.outcome))
    const unrecorded = results.length > mine.length
    const last = unrecorded ? results[results.length - 1] : mine[mine.length - 1]
    const gaveUp = GAVE_UP_OUTCOMES.includes(last?.outcome)
    // The executor's own refusals (`skip` marks): a permanent one needs a person, the others pass.
    const skip = findMarks("skip", cs).filter((k) => sinceDecision(lastD)(k) && Number(k.row || 0) === row).pop()
    let want = null
    if (b.capped) want = { kind: "stuck", cause: "budget", row, reason: b.reason }
    else if (unrecorded && results.length >= lim.issue_max_runs) want = { kind: "stuck", cause: "budget", row, reason: TEXT.reason.unrecorded(results.length, lim.issue_max_runs) }
    else if (gaveUp) want = { kind: "stuck", cause: "gave-up", row, reason: TEXT.reason.gaveUp }
    else if (skip?.permanent === true) want = { kind: "stuck", cause: "refused", row, reason: TEXT.reason.refused(oneLine(skip.why, 60)) }
    if (want) {
      if (it && sameAsk(it, want)) {
        plan.waiting.push({ item: it.number, kind: it.kind, issue: n, due: null })
        shownAs("owner", B.item(it.number, ""), row, { item: it.number })
      } else {
        if (it) closeStale(it, TEXT.stale.issueNotNeeded(n))
        if (askedBefore(want, n, lastD)) {
          note(TEXT.note.asked(`#${n}`))
          shownAs("stuck", B.asked, row)
        } else {
          openItem(stuckItem({ issue, row, cause: want.cause, reason: want.reason, owners: ownerNames }), { issue: n, row })
          shownAs("owner", B.itemOpened, row)
        }
      }
      continue
    }
    if (it) closeStale(it, TEXT.stale.issueNotNeeded(n))
    if (skip && nowMs < skipUntil(skip)) {
      note(TEXT.note.skipWait(`#${n}${row ? ` row ${row}` : ""}`, oneLine(skip.why, 60)))
      shownAs("queued", B.skipWait(oneLine(skip.why, 60), new Date(skipUntil(skip)).toISOString()), row)
      continue
    }
    fixCands.push({ issue: n, row })
    held.push({ on: n, comments: cs })
  }

  // ---- hand out what may run ----
  if (overDaily && (reworkCands.length || fixCands.length || reviewCands.length)) note(TEXT.note.daily(spend.reason))
  // The log is not where an owner looks. Without a word on the issue itself, work that waits
  // for tomorrow's budget looks like a pipeline that stopped.
  const day = nowIso.slice(0, 10)
  if (overDaily)
    for (const h of held) {
      if (findMarks("budget-wait", h.comments).some((k) => k.day === day)) continue
      plan.notices.push({ on: h.on, day, actions: [{ do: "comment", on: h.on, body: `${mark("budget-wait", { day })}\n${TEXT.comment.budgetWait(spend.reason)}` }] })
    }
  // Why nothing new starts this round, for the board ("" = things may start).
  const heldWhy = (forReview) =>
    overDaily
      ? B.budget(spend.reason)
      : cool?.cooling
        ? B.cooling(cool.reason, cool.until)
        : (forReview ? !reviewKnown : !fixKnown)
          ? B.runsUnknown
          : (forReview ? rev.unknown.length : fix.unknown.length)
            ? B.unattributed
            : cool && slots <= 0
              ? B.probe
              : ""
  plan.held = heldWhy(false)
  const prEntry = (n) => board.get(`pr:${n}`) || { pr: n }
  for (const r of reviewCands) {
    if (!reviewsOk) {
      if (!overDaily) note(TEXT.note.reviewBlocked(r.pr))
      show(`pr:${r.pr}`, { ...prEntry(r.pr), state: "queued", text: B.reviewHeld(heldWhy(true) || B.probe) })
      continue
    }
    plan.dispatchReview.push({ ...r, actions: [{ do: "dispatch", workflow: REVIEW_WORKFLOW, inputs: { pr: String(r.pr) } }] })
    show(`pr:${r.pr}`, { ...prEntry(r.pr), state: "working", text: B.reviewSent(r.attempt) })
  }
  const full = !overDaily && !cool?.cooling && fixKnown && !fix.unknown.length
  // Reworks first: the PR is already open, and the longer it waits the likelier it conflicts.
  for (const r of reworkCands) {
    if (slots <= 0) {
      if (full) note(TEXT.note.queued(`the rework of PR #${r.pr}`, lim.max_parallel))
      show(`pr:${r.pr}`, { ...prEntry(r.pr), state: "queued", text: B.reworkHeld(oneLine(r.why, 200), full ? B.slot(lim.max_parallel) : heldWhy(false) || B.slot(lim.max_parallel)) })
      continue
    }
    slots -= 1
    show(`pr:${r.pr}`, { ...prEntry(r.pr), state: "working", text: B.reworkSent(r.attempt, lim.max_rework, oneLine(r.why, 200)) })
    plan.dispatchRework.push({
      ...r,
      actions: [
        // The mark first: it is what keeps the same head from being sent back twice.
        {
          do: "comment",
          on: r.pr,
          body: `${mark("rework", { sha: r.sha, attempt: r.attempt, why: oneLine(r.why, 300), ...(r.send ? { send: r.send } : {}) })}\n${r.send ? TEXT.comment.reworkAgain(r.attempt, lim.max_rework, oneLine(r.why, 300), r.send, r.skipped) : TEXT.comment.rework(r.attempt, lim.max_rework, oneLine(r.why, 300))}`,
        },
        { do: "dispatch", workflow: FIX_WORKFLOW, inputs: { issue: String(r.issue), row: r.row ? String(r.row) : "", pr: String(r.pr) } },
      ],
    })
  }
  for (const c of fixCands) {
    if (slots <= 0) {
      if (full) note(TEXT.note.queued(`#${c.issue}${c.row ? ` row ${c.row}` : ""}`, lim.max_parallel))
      show(`issue:${c.issue}`, { issue: c.issue, row: c.row, state: "queued", text: full ? B.slot(lim.max_parallel) : heldWhy(false) || B.slot(lim.max_parallel) })
      continue
    }
    slots -= 1
    show(`issue:${c.issue}`, { issue: c.issue, row: c.row, state: "working", text: B.started })
    plan.dispatchFix.push({ ...c, actions: [{ do: "dispatch", workflow: FIX_WORKFLOW, inputs: { issue: String(c.issue), row: c.row ? String(c.row) : "", pr: "" } }] })
  }
  // The title of the issue (a pull request's own, when its issue is not open) says what it is.
  const titles = new Map((state.issues || []).map((i) => [`issue:${i.number}`, i.title]))
  for (const p of state.prs || []) titles.set(`pr:${p.number}`, p.title)
  const titleOf = (e) => titles.get(`issue:${e.issue}`) || (e.pr && titles.get(`pr:${e.pr}`)) || ""
  plan.board = [...board.values()].map((e) => ({ ...e, title: titleOf(e) })).sort((a, b) => (a.pr ? 0 : 1) - (b.pr ? 0 : 1) || (a.pr || a.issue) - (b.pr || b.issue))
  return plan
}
