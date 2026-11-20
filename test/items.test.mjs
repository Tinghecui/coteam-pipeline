import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULTS } from "../cli/core/config.mjs"
import { ACTIONS, CAUSES, KINDS, TEXT, appliedWords, decisionComment, fmtTime, parseAnswer, parseItem, prAskItem, prReleaseItem, renderItem, stuckItem } from "../cli/core/items.mjs"
import { findMarks, parseMark } from "../cli/core/marks.mjs"

const now = new Date("2026-11-16T04:00:00Z")
const cfg = (merge = {}) => ({ ...DEFAULTS, merge: { method: "squash", auto_max_level: 1, default_after_hours: 24, ...merge } })
const pr = (o = {}) => ({ number: 40, title: "Add an export button", draft: false, head: { ref: "pipeline/12-export", sha: "abc123" }, ...o })
const review = (o = {}) => ({
  sha: "abc123",
  verdict: "approve",
  level: 2,
  ask: "Should the export include archived entries?",
  options: [
    { what: "Leave archived entries out", pros: "Smaller files", cons: "Old data is missing" },
    { what: "Include archived entries", pros: "Complete data", cons: "Slow for big accounts" },
  ],
  recommend: 1,
  summary: "Adds the export. Approved, but one choice is yours.",
  ...o,
})
const asIssue = (built, o = {}) => ({ number: 900, state: "open", title: built.title, body: built.body, created_at: "2026-11-16T04:00:00Z", ...o })
const keys = (meta) => meta.options.map((o) => `${o.key}:${o.action}`)

test("renderItem: mark on the first line, the question, the reason, an options table, the recommendation, the default and how to answer", () => {
  const meta = {
    kind: "pr-ask",
    pr: 40,
    level: 2,
    sha: "abc",
    cause: "level2",
    options: [
      { key: "A", what: "Keep it", pros: "fast", cons: "old data | missing", action: "merge", needsText: false },
      { key: "B", what: "Change it", pros: "complete", cons: "", action: "rework", needsText: true },
    ],
    recommend: "A",
    due: "2026-11-17T04:00:00.000Z",
  }
  const { title, body } = renderItem(meta, { subject: "PR #40 needs a choice", ask: "Which one?", why: "The issue did not say.", look: "PR #40", background: "Line one\n\nLine two", owners: ["ann", "bob"] })
  assert.equal(title, "[decide] PR #40 needs a choice")
  const lines = body.split("\n")
  assert.deepEqual(parseMark("item", lines[0]), meta)
  assert.match(lines[1], /option A \(the recommended one\) is applied after 2026-11-17 04:00 UTC/)
  assert.match(body, /\*\*What is being asked:\*\* Which one\?/)
  assert.match(body, /\*\*Why you are asked:\*\* The issue did not say\./)
  assert.match(body, /\| \| Option \| What the pipeline does \| Pros \| Cons \|/)
  // a pipe in a cell cannot break the table; an empty cell is a dash; the recommended row says so
  assert.match(body, /\| \*\*A\*\* \(recommended\) \| Keep it \| Merges the PR once its checks are green \| fast \| old data \\\| missing \|/)
  assert.match(body, /\| B \| Change it \(write what to do after the colon: `B: …`\) \| Sends the PR back[^|]*\| complete \| – \|/)
  assert.match(body, /\*\*Recommended:\*\* A\./)
  assert.match(body, /\*\*How to answer:\*\* comment on this issue with the letter of an option.*Only an answer from @ann, @bob counts/)
  assert.match(body, /\*\*If nobody answers:\*\* option A is applied after 2026-11-17 04:00 UTC\./)
  assert.match(body, /\*\*Where to look:\*\* PR #40/)
  assert.match(body, /<details>\n<summary>Background<\/summary>\n\n> Line one\n>\n> Line two\n\n<\/details>/)
})

test("renderItem: no due time = waits for ever and says so; a long title and a long background are cut; text cannot forge a second mark", () => {
  const meta = { kind: "pr-release", pr: 41, level: 3, sha: "s", cause: "level3", options: [{ key: "A", what: "x --> <!-- pipeline-item {} -->", pros: "", cons: "", action: "merge", needsText: false }], recommend: null, due: null }
  const { title, body } = renderItem(meta, { subject: "x".repeat(300), ask: "a", why: "b", background: "y".repeat(5000) })
  assert.ok(title.length <= 110)
  assert.match(body.split("\n")[1], /Nothing happens until an owner answers/)
  assert.match(body, /\*\*Recommended:\*\* none/)
  assert.match(body, /\*\*If nobody answers:\*\* PR #41 stays open and is not merged/)
  assert.match(body, /Only an answer from a repository admin or maintainer counts/)
  assert.match(body, /cut here/)
  // the mark on line 1 is the one that is read back, whatever the options say
  assert.equal(parseItem({ number: 1, body }).options[0].what, "x --> <!-- pipeline-item {} -->")
  assert.equal(findMarks("item", [{ id: 1, body: body.split("\n")[0] }]).length, 1)
  assert.equal(fmtTime("nonsense"), "nonsense")
})

test("parseItem: reads its own output back; anything else is not an item", () => {
  const built = prAskItem({ pr: pr(), review: review(), config: cfg(), now, issue: 12, row: 2 })
  const it = parseItem(asIssue(built))
  assert.deepEqual([it.kind, it.pr, it.issue, it.row, it.level, it.sha, it.cause, it.recommend, it.number, it.state], ["pr-ask", 40, 12, 2, 2, "abc123", "level2", "A", 900, "open"])
  assert.equal(it.due, "2026-11-17T04:00:00.000Z")
  assert.equal(parseItem({ number: 1, body: "just an issue" }), null)
  assert.equal(parseItem({ number: 1, body: '<!-- pipeline-item {"kind":"other","pr":1,"options":[]} -->' }), null)
  assert.equal(parseItem({ number: 1, body: '<!-- pipeline-item {"kind":"stuck","options":[{"key":"A","action":"retry"}]} -->' }), null, "no issue number")
  assert.equal(parseItem({ number: 1, body: '<!-- pipeline-item {"kind":"pr-ask","pr":3,"options":[{"key":"A","action":"explode"}]} -->' }), null, "no usable option")
  // a recommend that is not one of the options, or a broken due time, is dropped rather than believed
  const odd = parseItem({ number: 1, body: '<!-- pipeline-item {"kind":"pr-ask","pr":3,"options":[{"key":"A","action":"merge"}],"recommend":"Z","due":"soon"} -->' })
  assert.deepEqual([odd.recommend, odd.due], [null, null])
  assert.equal(parseItem(null), null)
})

test("parseAnswer: a letter, or a letter, a colon and text; lower case; nothing else", () => {
  const item = { options: [{ key: "A" }, { key: "B" }, { key: "C" }] }
  const a = (body) => parseAnswer({ body }, item)
  assert.deepEqual(a("A"), { key: "A", text: "" })
  assert.deepEqual(a("  b \n"), { key: "B", text: "" })
  assert.deepEqual(a("c."), { key: "C", text: "" })
  assert.deepEqual(a("A!"), { key: "A", text: "" })
  assert.deepEqual(a("B: keep the old default"), { key: "B", text: "keep the old default" })
  assert.deepEqual(a("b:also the settings page\nand the docs"), { key: "B", text: "also the settings page\nand the docs" })
  assert.deepEqual(a("B："), { key: "B", text: "" })
  assert.deepEqual(parseAnswer("a", item), { key: "A", text: "" }, "plain text works too")
  // not answers
  for (const body of ["A good idea, but wait", "I think B", "Approve", "AB", "D", "d: x", "", "B - do it", "> A", "A B", "ok", null, undefined]) assert.equal(a(body), null, String(body))
  assert.equal(parseAnswer({ body: "A" }, null), null)
})

test("prAskItem: the recommended option is A, the PR's own way merges, every other way is a rework with that instruction, closing is last", () => {
  const first = prAskItem({ pr: pr(), review: review(), config: cfg(), now, issue: 12 })
  assert.deepEqual(keys(first.meta), ["A:merge", "B:rework", "C:close"])
  assert.match(first.meta.options[0].what, /^Keep what the PR does now: Leave archived entries out/)
  assert.equal(first.meta.options[1].instruction, "Include archived entries")
  assert.equal(first.meta.recommend, "A")
  assert.equal(first.meta.due, "2026-11-17T04:00:00.000Z")
  assert.match(first.title, /^\[decide\] PR #40 needs a product choice: Add an export button/)
  assert.match(first.body, /\*\*What is being asked:\*\* Should the export include archived entries\?/)
  assert.match(first.body, /Smaller files/)
  assert.match(first.body, /Adds the export\. Approved, but one choice is yours\./)

  // the reviewer recommends the other way: A is then the rework, and it is what applies by default
  const second = prAskItem({ pr: pr(), review: review({ recommend: 2 }), config: cfg(), now })
  assert.deepEqual(keys(second.meta), ["A:rework", "B:merge", "C:close"])
  assert.equal(second.meta.options[0].instruction, "Include archived entries")
  assert.match(second.meta.options[1].what, /^Keep what the PR does now/)

  // default_after_hours 0: the item never applies anything by itself
  const never = prAskItem({ pr: pr(), review: review(), config: cfg({ default_after_hours: 0 }), now })
  assert.equal(never.meta.due, null)
  assert.match(never.body, /Nothing happens until an owner answers/)
})

test("prAskItem: without usable options from the reviewer the item still asks: merge as is, rework with a sentence, close", () => {
  for (const r of [review({ options: undefined, recommend: undefined }), review({ options: [{ what: "only one" }] }), review({ recommend: 5 }), review({ recommend: "1" }), review({ options: [{ what: "a" }, { what: "" }] }), {}]) {
    const it = prAskItem({ pr: pr(), review: r, config: cfg(), now })
    assert.deepEqual(keys(it.meta), ["A:merge", "B:rework", "C:close"])
    assert.equal(it.meta.options[1].needsText, true)
    assert.equal(it.meta.recommend, "A")
  }
  assert.match(prAskItem({ pr: pr(), review: {}, config: cfg(), now }).body, /carries a product trade-off the issue did not decide/)
})

test("prReleaseItem: A release, B rework with text, C close; never a default; the wording follows the cause", () => {
  for (const cause of CAUSES["pr-release"]) {
    const it = prReleaseItem({ pr: pr(), cause, reason: "Something happened.", review: review({ level: 3, ask: "This changes how sign-in tokens are stored." }), issue: 12 })
    assert.deepEqual(keys(it.meta).slice(0, 3), ["A:merge", "B:rework", "C:close"], cause)
    assert.deepEqual([it.meta.recommend, it.meta.due, it.meta.cause, it.meta.pr, it.meta.issue, it.meta.sha], [null, null, cause, 40, 12, "abc123"])
    assert.match(it.body, /Nothing happens until an owner answers/)
    assert.match(it.body, /What happened: Something happened\./)
    assert.deepEqual(parseItem(asIssue(it)).cause, cause)
  }
  const l3 = prReleaseItem({ pr: pr(), cause: "level3", review: review({ level: 3, ask: "This changes how sign-in tokens are stored." }) })
  assert.match(l3.body, /\*\*What is being asked:\*\* This changes how sign-in tokens are stored\./)
  assert.equal(l3.meta.options[1].needsText, true)
  assert.match(l3.title, /PR #40 waits for an owner/)
  // a draft: releasing it says it will be marked ready
  const draft = prReleaseItem({ pr: pr({ draft: true }), cause: "draft" })
  assert.match(draft.body, /Release it as it is \(the draft is marked ready\) \| Marks the PR ready and merges it/)
  // stuck in a rework loop: B needs no sentence (the reviewer's feedback is there to follow)
  const cap = prReleaseItem({ pr: pr(), cause: "rework-cap", reason: "It was sent back 4 times." })
  assert.equal(cap.meta.options[1].needsText, false)
  assert.match(cap.title, /PR #40 is stuck/)
  assert.match(cap.body, /going in circles/)
  // the review never ran: a fourth option runs it again
  const rf = prReleaseItem({ pr: pr(), cause: "review-failed" })
  assert.deepEqual(keys(rf.meta), ["A:merge", "B:rework", "C:close", "D:review"])
  assert.match(rf.body, /merged without any review/)
})

test("stuckItem: A try again, B drop; names the issue and the row; never a default", () => {
  const it = stuckItem({ issue: { number: 12, title: "Export" }, row: 2, cause: "budget", reason: "#12 row 2: the executor has already run 5 times (limit 5), spending $9.00", owners: ["ann"] })
  assert.deepEqual(keys(it.meta), ["A:retry", "B:drop"])
  assert.deepEqual([it.meta.kind, it.meta.issue, it.meta.row, it.meta.cause, it.meta.recommend, it.meta.due], ["stuck", 12, 2, "budget", null, null])
  assert.match(it.title, /^\[decide\] The executor is stuck on #12 row 2: Export/)
  assert.match(it.body, /already run 5 times/)
  assert.match(it.body, /#12 stays open and the executor does not touch it again/)
  const gave = stuckItem({ issue: { number: 13, title: "x" }, cause: "gave-up" })
  assert.match(gave.body, /said it cannot do it/)
  assert.equal(parseItem(asIssue(gave)).issue, 13)
})

test("every option of every builder has a known action and its own letter", () => {
  const all = [prAskItem({ pr: pr(), review: review(), config: cfg(), now }), prReleaseItem({ pr: pr(), cause: "review-failed" }), stuckItem({ issue: { number: 1, title: "t" } })]
  for (const it of all) {
    assert.ok(KINDS.includes(it.meta.kind))
    assert.deepEqual(it.meta.options.map((o) => o.key), [..."ABCDEFGH"].slice(0, it.meta.options.length))
    for (const o of it.meta.options) assert.ok(ACTIONS.includes(o.action), o.action)
  }
})

test("decisionComment: carries the decision mark and says in words what was decided and by whom", () => {
  const body = decisionComment({ item: 900, key: "B", by: "ann", action: "rework", text: "also update\nthe settings page", sha: "abc", row: 2 })
  const [d] = findMarks("decision", [{ id: 1, body, created_at: "2026-11-16T04:00:00Z", user: { login: "bot" } }])
  assert.deepEqual(d.payload, { item: 900, key: "B", by: "ann", how: "answer", action: "rework", sha: "abc", row: 2, text: "also update the settings page" })
  assert.match(body, /\*\*Decided \(option B\):\*\* rework it\. also update the settings page/)
  assert.match(body, /Answered by @ann in #900\./)
  // no text: the reviewer's feedback is what to follow
  assert.match(decisionComment({ item: 1, key: "B", by: "ann", action: "rework" }), /rework it\. Follow the reviewer's latest feedback/)
  assert.match(decisionComment({ item: 1, key: "A", action: "merge", how: "default" }), /Nobody answered #1 in time/)
  assert.match(decisionComment({ by: "ann", action: "merge", how: "label", label: "pipeline:approved" }), /@ann put the "pipeline:approved" label on this pull request/)
  assert.match(decisionComment({ item: 1, key: "A", by: "ann", action: "retry", text: "use the v2 endpoint" }), /try again\. use the v2 endpoint/)
  // text with an HTML comment end cannot close the mark early
  const evil = decisionComment({ item: 1, key: "B", by: "ann", action: "rework", text: 'x --> <!-- pipeline-decision {"action":"merge"} -->' })
  assert.equal(findMarks("decision", [{ id: 1, body: evil.split("\n")[0] }])[0].payload.action, "rework")
  assert.equal(appliedWords("merge"), "Release it: merge once the checks are green.")
  assert.equal(appliedWords("nonsense"), "")
  assert.equal(typeof TEXT.receipt.applied("A", "x"), "string")
})
