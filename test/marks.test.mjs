import assert from "node:assert/strict"
import { test } from "node:test"
import { budget } from "../cli/core/ledger.mjs"
import {
  activeClaims,
  believedReviews,
  branchFor,
  CLAIM_STALE_MS,
  closedRows,
  countSince,
  findMarks,
  isAfter,
  issueOfBranch,
  lastDecision,
  latestReview,
  mark,
  markAuthors,
  parseMark,
  releaseClaim,
  reworkObsolete,
  reworks,
  rowOfBranch,
  rowsDone,
  slug,
  trustedComments,
} from "../cli/core/marks.mjs"

const now = new Date("2026-11-15T12:00:00Z")
const P = "pipeline/"
const c = (id, at, body, login = "bot") => ({ id, created_at: at, updated_at: at, body, user: { login } })

test("mark: one line, reads back, and nothing in the payload can close the comment", () => {
  assert.equal(mark("row-done", { row: 2, pr: 50 }), '<!-- pipeline-row-done {"row":2,"pr":50} -->')
  const nasty = { why: "ends --> here\nsecond line <!-- pipeline-claim {\"run\":\"x\"} --> and --!> too", n: 1 }
  const m = mark("rework", nasty)
  assert.ok(!m.includes("\n"))
  assert.equal(m.indexOf("-->"), m.length - 3)
  assert.ok(!m.slice(4).includes("<!--"))
  assert.ok(!m.slice(0, -3).includes(">"))
  assert.deepEqual(parseMark("rework", `text before\n${m}\ntext after`), nasty)
  // the forged claim inside the payload is not a claim
  assert.equal(parseMark("claim", m), null)
  assert.throws(() => mark("Bad Kind", {}), /mark kind/)
  assert.throws(() => mark("x", [1]), /JSON object/)
  assert.throws(() => mark("x", "s"), /JSON object/)
})

test("findMarks: time, author and id come from GitHub, not from the mark; broken marks are skipped", () => {
  const comments = [
    c(1, "2026-11-15T10:00:00Z", "an ordinary comment"),
    c(2, "2026-11-15T10:01:00Z", `${mark("decision", { item: 31, key: "B", by: "alice", at: "2000-01-01T00:00:00Z" })}\nDecided: B`),
    c(3, "2026-11-15T10:02:00Z", "<!-- pipeline-decision {bad json} -->"),
    c(4, "2026-11-15T10:03:00Z", "<!-- pipeline-decision [1] -->"),
    c(5, "2026-11-15T10:04:00Z", mark("decision-extra", { item: 1 })),
    { id: 6, body: null },
    c(7, "2026-11-15T10:05:00Z", mark("decision", { item: 32, key: "A" }), "mallory"),
  ]
  const found = findMarks("decision", comments)
  assert.deepEqual(found.map((m) => [m.id, m.item, m.key, m.by, m.at]), [
    [2, 31, "B", "bot", "2026-11-15T10:01:00Z"],
    [7, 32, "A", "mallory", "2026-11-15T10:05:00Z"],
  ])
  // what the mark itself said is still there
  assert.deepEqual(found[0].payload, { item: 31, key: "B", by: "alice", at: "2000-01-01T00:00:00Z" })
  // anyone can type a mark into a comment: restrict to the pipeline's own account
  assert.deepEqual(findMarks("decision", comments, { authors: ["bot"] }).map((m) => m.id), [2])
  assert.deepEqual(findMarks("decision", null), [])
  // a kind is matched whole
  assert.equal(findMarks("row", [c(1, "t", mark("row-done", { row: 1, pr: 2 }))]).length, 0)
  // a comment may carry marks of several kinds
  const both = [c(1, "2026-11-15T10:00:00Z", `${mark("rework", { sha: "a", attempt: 1 })}\n${mark("decision", { item: 5, key: "A" })}`)]
  assert.equal(findMarks("rework", both).length, 1)
  assert.equal(findMarks("decision", both).length, 1)
})

test("claims: the earliest counts, by GitHub's time; released and stale ones do not", () => {
  const claim = (id, at, run, extra = {}) => c(id, at, `${mark("claim", { run, at: "2000-01-01T00:00:00Z", ...extra })}\nThe executor took this issue.`)
  const comments = [
    c(1, "2026-11-15T11:00:00Z", "an ordinary comment"),
    claim(5, "2026-11-15T11:30:02Z", "b"),
    claim(4, "2026-11-15T11:30:01Z", "a"),
    claim(3, "2026-11-15T11:20:00Z", "old", { released: true }),
    // more than 3 h old: left behind by a run that died
    claim(2, "2026-11-15T07:00:00Z", "stale"),
    claim(6, "garbage", "no-time"),
  ]
  assert.deepEqual(activeClaims(comments, { now }).map((x) => x.run), ["a", "b"])
  assert.equal(CLAIM_STALE_MS, 3 * 3600 * 1000)
  // exactly at the limit still counts; one millisecond later it does not
  const edge = [claim(1, "2026-11-15T09:00:00Z", "edge")]
  assert.equal(activeClaims(edge, { now }).length, 1)
  assert.equal(activeClaims(edge, { now: new Date(now.getTime() + 1) }).length, 0)
  assert.equal(activeClaims(edge, { now, staleMs: 60000 }).length, 0)
  // the same second: lower comment id first
  const same = activeClaims([claim(9, "2026-11-15T11:30:00Z", "late"), claim(8, "2026-11-15T11:30:00Z", "early")], { now })
  assert.equal(same[0].run, "early")
  // the run id is a string whatever was written
  assert.equal(activeClaims([claim(1, "2026-11-15T11:00:00Z", 123)], { now })[0].run, "123")
})

test("claims: per row, and releasing one", () => {
  const body = `${mark("claim", { run: "7", row: 2 })}\nThe executor took row 2.`
  const comments = [c(1, "2026-11-15T11:00:00Z", body), c(2, "2026-11-15T11:01:00Z", mark("claim", { run: "8" }))]
  assert.deepEqual(activeClaims(comments, { now, row: 2 }).map((x) => x.run), ["7"])
  assert.deepEqual(activeClaims(comments, { now, row: 0 }).map((x) => x.run), ["8"])
  assert.deepEqual(activeClaims(comments, { now }).map((x) => [x.run, x.row]), [["7", 2], ["8", 0]])
  const released = releaseClaim(body)
  assert.equal(released, '<!-- pipeline-claim {"run":"7","row":2,"released":true} -->\nThe executor took row 2.')
  assert.equal(activeClaims([c(1, "2026-11-15T11:00:00Z", released)], { now }).length, 0)
  assert.equal(releaseClaim("no claim here"), "no claim here")
  // a claim typed by someone else does not block the pipeline when authors are given
  assert.equal(activeClaims([c(1, "2026-11-15T11:00:00Z", body, "mallory")], { now, authors: ["bot"] }).length, 0)
})

test("reworks: attempt, head and reason read back; broken ones are skipped", () => {
  const r = reworks([
    c(1, "t1", `${mark("rework", { attempt: 1, sha: "aaa", why: "review: 2 problems" })}\nReworked`),
    c(2, "t2", "<!-- pipeline-rework {bad} -->"),
    c(3, "t3", mark("rework", { attempt: 2, sha: "bbb", failed: true })),
  ])
  assert.deepEqual(r, [
    { id: 1, attempt: 1, sha: "aaa", why: "review: 2 problems", failed: false, at: "t1" },
    { id: 3, attempt: 2, sha: "bbb", why: "", failed: true, at: "t3" },
  ])
})

test("latestReview: the most recently written verdict; an edited comment counts by its edit time", () => {
  const first = { ...c(1, "2026-11-15T08:00:00Z", mark("review", { sha: "h1", verdict: "reject", level: 1, by: "model-x" })), updated_at: "2026-11-15T10:00:00Z" }
  const second = c(2, "2026-11-15T09:00:00Z", mark("review", { sha: "h0", verdict: "approve", level: 0 }))
  assert.deepEqual(latestReview([first, second]), { sha: "h1", verdict: "reject", level: 1, by: "bot", at: "2026-11-15T10:00:00Z", id: 1 })
  assert.equal(latestReview([second]).sha, "h0")
  assert.equal(latestReview([]), null)
  // a mark without a verdict (review still running) is not a review; a missing level is unknown, not 0
  assert.equal(latestReview([c(1, "t", mark("review", { sha: "h1" }))]), null)
  assert.equal(latestReview([c(1, "t", mark("review", { sha: "h1", verdict: "approve" }))]).level, null)
})

test("reworkObsolete: the same head was approved after the rework was recorded", () => {
  const pr = (sha) => ({ number: 5, head: { sha } })
  const rework = c(1, "2026-11-15T08:00:00Z", mark("rework", { attempt: 1, sha: "h1", failed: true }))
  const review = (sha, verdict, at) => c(2, at, mark("review", { sha, verdict, level: 0 }))
  const [r] = reworks([rework])
  assert.equal(reworkObsolete(r, pr("h1"), [rework, review("h1", "approve", "2026-11-15T09:00:00Z")]), true)
  // approved before the rework, rejected, another head, or the PR has moved on: still stands
  assert.equal(reworkObsolete(r, pr("h1"), [rework, review("h1", "approve", "2026-11-15T07:00:00Z")]), false)
  assert.equal(reworkObsolete(r, pr("h1"), [rework, review("h1", "reject", "2026-11-15T09:00:00Z")]), false)
  assert.equal(reworkObsolete(r, pr("h1"), [rework, review("h0", "approve", "2026-11-15T09:00:00Z")]), false)
  assert.equal(reworkObsolete(r, pr("h2"), [rework, review("h1", "approve", "2026-11-15T09:00:00Z")]), false)
  assert.equal(reworkObsolete(r, pr("h1"), [rework]), false)
  assert.equal(reworkObsolete(null, pr("h1"), []), false)
})

test("countSince: rework and run counts start again after the latest decision", () => {
  const decision = (id, at, item) => c(id, at, `${mark("decision", { item, key: "A", by: "alice", at: "1999-01-01T00:00:00Z" })}\nDecided: rework once more`)
  const rework = (id, at, attempt) => c(id, at, mark("rework", { attempt, sha: `s${attempt}` }))
  const prComments = [
    rework(1, "2026-11-14T01:00:00Z", 1),
    rework(2, "2026-11-14T02:00:00Z", 2),
    decision(3, "2026-11-14T08:00:00Z", 40),
    rework(4, "2026-11-14T09:00:00Z", 1),
    c(5, "2026-11-14T10:00:00Z", "I think we decided this already"),
  ]
  assert.equal(countSince([]), "")
  assert.equal(countSince(), "")
  assert.equal(countSince(prComments), "2026-11-14T08:00:00Z")
  const since = countSince(prComments)
  assert.deepEqual(reworks(prComments).filter((r) => r.at > since).map((r) => r.id), [4])
  // a decision on the issue counts too; the later of the two wins
  const issueComments = [decision(9, "2026-11-15T08:00:00Z", 41)]
  assert.equal(countSince(prComments, issueComments), "2026-11-15T08:00:00Z")
  assert.equal(countSince(issueComments, prComments), "2026-11-15T08:00:00Z")
  assert.equal(countSince(prComments, null), "2026-11-14T08:00:00Z")
  // the executor's precheck counts from the same moment as the tick
  const e = (at) => ({ at, role: "executor", issue: 7, usd: 1 })
  const entries = ["2026-11-13T01:00:00Z", "2026-11-13T02:00:00Z", "2026-11-13T03:00:00Z", "2026-11-13T04:00:00Z", "2026-11-13T05:00:00Z", "2026-11-14T09:00:00Z"].map(e)
  const limits = { daily_usd: 100, issue_max_runs: 5, issue_max_usd: 20 }
  assert.equal(budget(entries, { issue: 7, limits, now }).capped, true)
  assert.deepEqual([budget(entries, { issue: 7, limits, now, since }).issueRuns, budget(entries, { issue: 7, limits, now, since }).ok], [1, true])
})

test("slug and branch names", () => {
  assert.equal(slug("Worktree Alias: clear!"), "worktree-alias-clear")
  assert.equal(slug("!!!"), "task")
  assert.equal(slug(""), "task")
  assert.equal(slug("a".repeat(60)).length, 40)
  assert.equal(slug(`${"a".repeat(39)} b`), "a".repeat(39))
  assert.equal(branchFor({ prefix: P, issue: 438, title: "Settings load error" }), "pipeline/438-settings-load-error")
  assert.equal(branchFor({ prefix: P, issue: 9, row: 2, title: "Switch UI" }), "pipeline/9-r2-switch-ui")
  assert.equal(branchFor({ prefix: "bot-", issue: "9", title: "x" }), "bot-9-x")
  // a single task whose title starts like a row marker must not read back as a row
  const tricky = branchFor({ prefix: P, issue: 9, title: "r2 d2 sound" })
  assert.equal(tricky, "pipeline/9-task-r2-d2-sound")
  assert.equal(rowOfBranch(tricky, P), null)
  assert.equal(issueOfBranch(tricky, P), 9)
})

test("rowOfBranch / issueOfBranch use the configured prefix", () => {
  assert.deepEqual(rowOfBranch("pipeline/9-r2-switch-ui", P), { issue: 9, row: 2 })
  assert.equal(rowOfBranch("pipeline/9-switch-ui", P), null)
  assert.equal(rowOfBranch("other/9-r2-x", P), null)
  assert.deepEqual(rowOfBranch("other/9-r2-x", "other/"), { issue: 9, row: 2 })
  assert.equal(issueOfBranch("pipeline/438-settings-load-error", P), 438)
  assert.equal(issueOfBranch("pipeline/386-r3-proc-watch", P), 386)
  assert.equal(issueOfBranch("feature/x", P), 0)
  assert.equal(issueOfBranch("pipeline/ledger", P), 0)
  assert.equal(issueOfBranch("pipeline/rules-1", P), 0)
  assert.equal(issueOfBranch("xpipeline/5-a", P), 0)
  assert.equal(issueOfBranch(null, P), 0)
  // the prefix is literal text, not a pattern
  assert.equal(issueOfBranch("aXb/5-x", "a.b/"), 0)
  assert.equal(issueOfBranch("a.b/5-x", "a.b/"), 5)
})

test("rowsDone: rows recorded as merged on the issue", () => {
  const done = (row, pr) => c(row, "t", `${mark("row-done", { row, pr })}\nRow ${row} merged.`)
  assert.deepEqual([...rowsDone([done(1, 50), c(9, "t", "something else"), c(8, "t", "<!-- pipeline-row-done {bad} -->"), done(3, 52)])], [[1, 50], [3, 52]])
  // pr 0 = verified as already on the base branch
  assert.deepEqual([...rowsDone([c(1, "t", mark("row-done", { row: 2, pr: 0, commits: ["abc1234"] }))])], [[2, 0]])
  assert.deepEqual([...rowsDone([c(1, "t", mark("row-done", { row: 0, pr: 5 }))])], [])
  assert.deepEqual([...rowsDone(null)], [])
})

test("closedRows: PRs closed without merging stop their row until the redo label", () => {
  const opts = { prefix: P, redoLabel: "pipeline:redo" }
  const pr = (number, ref, o = {}) => ({ number, head: { ref }, merged_at: null, labels: [], ...o })
  // a single task has no rows: row 0
  assert.deepEqual([...closedRows(7, { ...opts, closedPrs: [pr(70, "pipeline/7-fix-x", { labels: [{ name: "pipeline" }] })] })], [[0, { pr: 70, redo: false, marked: false, markedRedo: false }]])
  // merged PRs, other issues' PRs and branches outside the prefix are not ours
  assert.equal(closedRows(7, { ...opts, closedPrs: [pr(71, "pipeline/7-r1-a", { merged_at: "2026-11-15T00:00:00Z" }), pr(72, "pipeline/70-r1-a"), pr(73, "feature/7-r1-a")] }).size, 0)
  // per row the newest PR counts; the redo label asks for another attempt; head may be a plain string
  const rows = closedRows(7, {
    ...opts,
    closedPrs: [pr(80, "pipeline/7-r2-a"), pr(85, "pipeline/7-r2-a-2", { labels: ["pipeline:redo"] }), { number: 82, head: "pipeline/7-r3-b", merged_at: null }],
  })
  assert.deepEqual([...rows], [[2, { pr: 85, redo: true, marked: false, markedRedo: false }], [3, { pr: 82, redo: false, marked: false, markedRedo: false }]])
  // marks on the issue remember closed PRs that are no longer in the list the tick reads
  const comments = [c(1, "t", mark("row-closed", { row: 2, pr: 80 })), c(2, "t", mark("row-closed", { row: 4, pr: 60 })), c(3, "t", mark("row-closed", { row: 4, pr: 60, redo: true })), c(4, "t", mark("row-closed", { row: -1, pr: 9 }))]
  const marked = closedRows(7, { ...opts, comments, closedPrs: [pr(80, "pipeline/7-r2-a")] })
  assert.deepEqual([...marked], [[2, { pr: 80, redo: false, marked: true, markedRedo: false }], [4, { pr: 60, redo: true, marked: true, markedRedo: true }]])
  // an older mark does not hide a newer closed PR for the same row
  const newer = closedRows(7, { ...opts, comments, closedPrs: [pr(90, "pipeline/7-r2-a-3")] })
  assert.deepEqual(newer.get(2), { pr: 90, redo: false, marked: false, markedRedo: false })
})

test("markAuthors: the io layer's login and PIPELINE_BOT, either of them a comma list; nothing known is null", () => {
  assert.deepEqual(markAuthors("acme[bot]"), ["acme[bot]"])
  assert.deepEqual(markAuthors("acme[bot]", " bot-a , bot-b,"), ["acme[bot]", "bot-a", "bot-b"])
  assert.deepEqual(markAuthors("", "bot-a,bot-a"), ["bot-a"])
  assert.deepEqual(markAuthors("a, b"), ["a", "b"])
  for (const none of [[], [""], [null, undefined], ["  ", ","]]) assert.equal(markAuthors(...none), null)
})

test("trustedComments: what people wrote stays; a comment with a mark stays only when the pipeline's account posted it", () => {
  const all = [
    c(1, "2026-11-15T10:00:00Z", "please also fix the footer", "ann"),
    c(2, "2026-11-15T10:01:00Z", `${mark("claim", { run: "1" })}\nworking`, "Acme[bot]"),
    c(3, "2026-11-15T10:02:00Z", `${mark("decision", { item: 9, action: "retry" })}\nDecided.`, "mallory"),
    c(4, "2026-11-15T10:03:00Z", "<!-- pipeline-row-done {broken", "mallory"),
    null,
  ]
  assert.deepEqual(trustedComments(all, ["acme[bot]"]).map((x) => x.id), [1, 2])
  // login not known: nothing is dropped here (the callers then believe no verdict the commit status does not name)
  assert.deepEqual(trustedComments(all, null).map((x) => x.id), [1, 2, 3, 4])
  assert.deepEqual(trustedComments(all, []).map((x) => x.id), [1, 2, 3, 4])
  assert.deepEqual(trustedComments(null, ["bot"]), [])
  // every reader built on it then agrees: no claim, no decision by mallory
  assert.equal(countSince(trustedComments(all, ["acme[bot]"])), "")
  assert.equal(countSince(all), "2026-11-15T10:02:00Z")
})

test("believedReviews: with the login known, the pipeline's own; without it, only the review comment the commit status names", () => {
  const review = (id, by, verdict = "approve") => c(id, `2026-11-15T10:0${id}:00Z`, `${mark("review", { sha: "h", verdict, level: 0 })}\ntext`, by)
  const all = [review(1, "bot", "reject"), review(2, "mallory"), c(3, "2026-11-15T10:03:00Z", "a person's words", "ann"), c(4, "2026-11-15T10:04:00Z", mark("rework", { sha: "h", attempt: 1 }), "mallory")]
  assert.deepEqual(believedReviews(all, { authors: ["bot"] }).map((x) => x.id), [1, 3])
  // not known: review comments need the status; everything else is left as it is
  const status = (target_url) => ({ context: "pipeline/review", state: "failure", target_url })
  assert.deepEqual(believedReviews(all, {}).map((x) => x.id), [3, 4])
  assert.deepEqual(believedReviews(all, { status: status("") }).map((x) => x.id), [3, 4])
  assert.deepEqual(believedReviews(all, { status: status("https://github.test/o/r/pull/7#issuecomment-1") }).map((x) => x.id), [1, 3, 4])
  assert.deepEqual(believedReviews(all, { status: status("https://github.test/o/r/pull/7#issuecomment-2") }).map((x) => x.id), [2, 3, 4])
  // the address has to end with the comment's id: "…-12" does not name comment 1, a run page names nothing
  assert.deepEqual(believedReviews(all, { status: status("https://github.test/o/r/pull/7#issuecomment-12") }).map((x) => x.id), [3, 4])
  assert.deepEqual(believedReviews(all, { status: status("https://github.test/o/r/actions/runs/1") }).map((x) => x.id), [3, 4])
  assert.equal(latestReview(believedReviews(all, { status: status("https://x/#issuecomment-1") })).verdict, "reject")
})

test("lastDecision / isAfter: one order of comments for every role, by time and then by comment id", () => {
  const d = (id, at) => c(id, at, mark("decision", { item: id, action: "rework" }))
  const pr = [d(10, "2026-11-15T10:00:00Z"), d(12, "2026-11-15T11:00:00Z")]
  const issue = [d(11, "2026-11-15T11:00:00Z"), c(13, "bad time", mark("decision", { item: 13 }))]
  assert.equal(lastDecision(issue, pr).id, 12)
  assert.equal(lastDecision(pr, issue).id, 12)
  assert.equal(lastDecision([], null), null)
  assert.equal(countSince(issue, pr), "2026-11-15T11:00:00Z")
  const last = lastDecision(pr)
  // a mark the tick writes in the same second as the decision, right after it, is after it
  assert.equal(isAfter({ at: "2026-11-15T11:00:00Z", id: 13 }, last), true)
  assert.equal(isAfter({ at: "2026-11-15T11:00:00Z", id: 11 }, last), false)
  assert.equal(isAfter({ at: "2026-11-15T11:00:01Z", id: 1 }, last), true)
  assert.equal(isAfter({ at: "2026-11-15T10:59:59Z", id: 99 }, last), false)
})

test("closedRows without an issue: the list is taken to hold one issue's PRs; branches off the prefix never count", () => {
  const prs = [{ number: 50, head: "pipeline/9-r1-a", merged_at: null }, { number: 51, head: { ref: "feature/9-r2-a" }, merged_at: null }, { number: 52, head: "pipeline/8-task", merged_at: null }]
  assert.deepEqual([...closedRows(null, { closedPrs: prs, prefix: P, redoLabel: "pipeline:redo" }).keys()], [1, 0])
  assert.deepEqual([...closedRows(9, { closedPrs: prs, prefix: P, redoLabel: "pipeline:redo" }).keys()], [1])
})
