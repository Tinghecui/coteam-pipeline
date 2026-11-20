// Spec issues: parseSpec, checkSpec, briefProblems, specProgress. Fake data only.
// Run: node --test test/spec.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import { BRIEF_MAX, briefProblems, checkSpec, parseSpec, specProgress, specSections } from "../cli/core/spec.mjs"

const table = (rows) => `| # | What | Where | Depends on | How to verify |\n| --- | --- | --- | --- | --- |\n${rows.map((r) => `| ${r.join(" | ")} |`).join("\n")}`
const brief = [
  "**In one sentence**: Settings get a switch; when it is off, your other devices no longer see your drafts.",
  "**Background**: Today a draft shows up on every device.",
  "**Why**: Someone left half a message on a work computer and their family read it on the phone at home.",
  "**Options considered**",
  "",
  "| | Option | Pros | Cons |",
  "| --- | --- | --- | --- |",
  "| **A (chosen)** | Add a switch, off by default | People who do not want it are not affected | One more setting |",
  "| B | Never sync drafts | Simple | People who want it have no choice |",
  "",
  "**Who decided**: The owner, in the discussion of 16 November.",
  "**If it goes wrong**: At worst drafts stop syncing; reverting these pull requests brings back today's behaviour.",
  "**How to verify**: Sign in on two devices, write a draft on one; the other does not show it until the switch is on.",
].join("\n")
const DEFAULT_ROWS = [
  [1, "Account service stores the field", "`server/account.js`", "none", "criterion 1"],
  [2, "Desktop reads the field", "`desktop/sync.js`", "1", "criterion 2"],
  [3, "Settings screen", "`app/settings.jsx`", "1, 2", "criterion 3"],
]
const specBody = ({ open = "none", rows = DEFAULT_ROWS, split = true, summary = brief } = {}) =>
  `${summary ? `## Summary\n\n${summary}\n\n` : ""}## Requirement\n\nA switch.\n\n## Acceptance criteria\n\n1. The field is stored.\n2. Desktop can read it.\n3. The screen has the switch.\n\n## Decisions\n\n1. Off by default.\n\n## Open questions\n\n${open}\n\n## Out of scope\n\n1. No phone app.\n\n## Current state\n\n1. There is no such field.\n${split ? `\n## PR split\n\n${table(rows)}\n` : ""}\n## Risks\n\nnone\n`

const prefix = "pipeline/"
const pr = (number, issue, row, extra = {}) => ({ number, head: { ref: `${prefix}${issue}-r${row}-x` }, merged_at: null, labels: [], ...extra })
const done = (row, p) => ({ body: `<!-- pipeline-row-done ${JSON.stringify({ row, pr: p })} -->\nRow ${row} merged.` })
const closedMark = (o) => ({ body: `<!-- pipeline-row-closed ${JSON.stringify(o)} -->\nnote` })

test("sections: split on ## headings; headings inside fenced code do not count", () => {
  const s = specSections("intro\n## A\n\none\n\n```md\n## B\n```\n\n## C ##\ntwo\r\n")
  assert.deepEqual([...s.keys()], ["A", "C"])
  assert.equal(s.get("A"), "one\n\n```md\n## B\n```")
  assert.equal(s.get("C"), "two")
})

test("a spec issue is an issue with a split table; anything else is a single task", () => {
  for (const body of ["", "## What happens\n\nNothing on click", "## Acceptance criteria\n\n1. a", "## What\n\n```md\n## PR split\n| # |\n```\n", "## PR split\n\nnone"]) {
    const s = parseSpec(body)
    assert.equal(s.isSpec, false, body)
    assert.deepEqual([s.rows, s.problems], [[], []], body)
  }
  const s = parseSpec(specBody())
  assert.equal(s.isSpec, true)
  assert.deepEqual(s.problems, [])
  assert.equal(s.open, "")
  assert.equal(s.summary, brief)
  assert.match(s.criteria, /^1\. The field is stored\.\n2\. Desktop can read it\./)
  assert.equal(s.sections.Decisions, "1. Off by default.")
  assert.deepEqual(s.rows, [
    { n: 1, what: "Account service stores the field", where: "`server/account.js`", deps: [], verify: "criterion 1" },
    { n: 2, what: "Desktop reads the field", where: "`desktop/sync.js`", deps: [1], verify: "criterion 2" },
    { n: 3, what: "Settings screen", where: "`app/settings.jsx`", deps: [1, 2], verify: "criterion 3" },
  ])
  // headings are matched without regard to case or spacing
  const loose = parseSpec(specBody().replace("## PR split", "## pr  Split").replace("## Acceptance criteria", "## ACCEPTANCE CRITERIA"))
  assert.deepEqual([loose.isSpec, loose.rows.length, loose.problems], [true, 3, []])
})

test("open questions: empty, none, n/a count as settled; anything written blocks the issue, spec or not", () => {
  for (const o of ["", "none", "None.", "- none", "(none)", "N/A", "nothing", "-", "—"]) assert.deepEqual(parseSpec(specBody({ open: o })).problems, [], o)
  const s = parseSpec(specBody({ open: "1. On or off by default?\n2. More" }))
  assert.equal(s.open, "1. On or off by default?\n2. More")
  assert.deepEqual(s.problems.length, 1)
  assert.match(s.problems[0], /"## Open questions" is not empty: 1\. On or off by default\?/)
  // no such section at all is fine
  assert.deepEqual(parseSpec(`## Acceptance criteria\n\n1. a\n\n## PR split\n\n${table([[1, "a", "x", "none", "y"]])}`).problems, [])
  // a single task that still has an open question is not worked on either
  const task = parseSpec("Something is off.\n\n## Open questions\n\nWhich one did you mean?")
  assert.equal(task.isSpec, false)
  assert.match(task.problems.join(), /Open questions/)
})

test("split table: #123 is another issue or PR; what cannot be read is reported, never guessed", () => {
  const refs = parseSpec(specBody({ rows: [[1, "a", "x", "#227", "y"], [2, "b", "x", "1, #300", "y"], [3, "with \\| a pipe", "x", "-", "y"], [4, "d", "x", "1 and 2", "y"]] }))
  assert.deepEqual(refs.problems, [])
  assert.deepEqual(refs.rows.map((r) => r.deps), [[{ pr: 227 }], [1, { pr: 300 }], [], [1, 2]])
  assert.equal(refs.rows[2].what, "with | a pipe")
  const bad = (rows) => parseSpec(specBody({ rows })).problems.join(" ; ")
  assert.match(bad([[1, "a", "x", "2", "y"], [2, "b", "x", "1", "y"]]), /forms a cycle: rows 1, 2/)
  assert.match(bad([[1, "a", "x", "5", "y"]]), /Row 1: "Depends on" names row 5, which does not exist/)
  assert.match(bad([[1, "a", "x", "1", "y"]]), /names the row itself/)
  assert.match(bad([[1, "a", "x", "the 6th PR of #197", "y"]]), /may only hold row numbers/)
  assert.match(bad([[1, "a", "x", "none", "y"], [1, "b", "x", "none", "y"]]), /Row # 1 appears twice/)
  assert.match(bad([["one", "a", "x", "none", "y"]]), /not a positive integer: "one"/)
  assert.match(parseSpec("## Acceptance criteria\n\n1. a\n\n## PR split\n\nServer first, then the screen").problems.join(), /has no table/)
  assert.match(parseSpec("## Acceptance criteria\n\n1. a\n\n## PR split\n\n| Row | Content |\n| --- | --- |\n| 1 | a |").problems.join(), /header needs the columns/)
  assert.match(parseSpec(`## Acceptance criteria\n\n## PR split\n\n${table([[1, "a", "x", "none", "y"]])}`).problems.join(), /"## Acceptance criteria" is missing or empty/)
  // optional columns may be left out
  const slim = parseSpec("## Acceptance criteria\n\n1. a\n\n## PR split\n\n| # | What | Depends on |\n|---|---|---|\n| 1 | a | none |\n| 2 | b | 1 |")
  assert.deepEqual([slim.problems, slim.rows[1]], [[], { n: 2, what: "b", where: "", deps: [1], verify: "" }])
})

test('a range in "Depends on" (1-3, 1~3, 1..3, 1 to 3, #12-#14) is an error, not rows 1 and 3; a lone dash is still "none"', () => {
  const rows = (dep) => [[1, "a", "x", "none", "y"], [2, "b", "x", "none", "y"], [3, "c", "x", "none", "y"], [4, "d", "x", dep, "y"]]
  for (const t of ["1-3", "1 - 3", "1~3", "1—3", "1–3", "1..3", "1 to 3", "1 through 3", "#12-#14"])
    assert.match(parseSpec(specBody({ rows: rows(t) })).problems.join(" ; "), /Row 4: "Depends on" has a range "[^"]+"\. List every row/, t)
  for (const t of ["-", "—", "–", " - ", "none", "1, 2", "1, #300", "- 1", "1; 2", "1 & 2"]) assert.deepEqual(parseSpec(specBody({ rows: rows(t) })).problems, [], t)
  assert.deepEqual(parseSpec(specBody({ rows: rows("—") })).rows[3].deps, [])
  // and such a spec is never dispatched
  const p = specProgress(parseSpec(specBody({ rows: rows("1-3") })))
  assert.equal(p.next, null)
  assert.match(p.blocked, /^the spec has problems: Row 4: "Depends on" has a range "1-3"/)
})

test("progress: merged rows come from marks on the issue and from merged PRs; one row at a time; rows whose dependencies are not done are skipped", () => {
  const spec = parseSpec(specBody({ rows: [[1, "a", "x", "#227", "y"], [2, "b", "x", "1", "y"], [3, "c", "x", "none", "y"]] }))
  // #227 is not done: row 1 waits, row 3 does not depend on it
  let p = specProgress(spec, { issue: 9 })
  assert.equal(p.next.n, 3)
  p = specProgress(spec, { issue: 9, refsDone: { 227: true } })
  assert.equal(p.next.n, 1)
  // row 1 has an open PR: nothing is dispatched; PRs of other issues and other branches are ignored
  p = specProgress(spec, { issue: 9, refsDone: { 227: true }, openPrs: [pr(50, 9, 1, { draft: true }), pr(51, 8, 1), { number: 52, head: "feature/9-r2-x" }] })
  assert.deepEqual([p.next, p.open], [null, [{ row: 1, pr: 50, draft: true }]])
  // row 1 merged (no mark yet): noted as unmarked. Row 2's PR was closed unmerged: not merged, the row stops; next is 3
  const closed = [pr(50, 9, 1, { head: `${prefix}9-r1-a`, merged_at: "t" }), pr(52, 9, 2), pr(53, 8, 2, { merged_at: "t" })]
  p = specProgress(spec, { issue: 9, refsDone: { 227: true }, closedPrs: closed })
  assert.deepEqual([p.merged, p.unmarked, p.stopped, p.next.n, p.done], [[{ row: 1, pr: 50 }], [{ row: 1, pr: 50 }], [{ row: 2, pr: 52 }], 3, false])
  // a mark counts even when the PR is long gone from the lists; broken marks are skipped
  p = specProgress(spec, { issue: 9, refsDone: { 227: true }, comments: [done(1, 50), done(2, 54), { body: "other" }, { body: "<!-- pipeline-row-done {bad} -->" }, null] })
  assert.deepEqual([p.unmarked, p.next.n, p.merged], [[], 3, [{ row: 1, pr: 50 }, { row: 2, pr: 54 }]])
  p = specProgress(spec, { issue: 9, comments: [done(1, 50), done(2, 54), done(3, 55)] })
  assert.deepEqual([p.done, p.next, p.merged.length, p.blocked], [true, null, 3, ""])
  // a row found already done on the base branch is recorded with pr 0 and unblocks its dependents
  p = specProgress(spec, { issue: 9, comments: [done(1, 0)] })
  assert.deepEqual([p.merged, p.next.n], [[{ row: 1, pr: 0 }], 2])
  // everything waits: say for what
  p = specProgress(parseSpec(specBody({ rows: [[1, "a", "x", "#227", "y"], [2, "b", "x", "1", "y"]] })), { issue: 9 })
  assert.deepEqual([p.next, p.blocked], [null, "row 1 waits for #227"])
  // another branch prefix; without `issue` every PR on the prefix counts
  p = specProgress(spec, { branchPrefix: "bot/", refsDone: { 227: true }, openPrs: [{ number: 60, head: "bot/9-r1-a" }] })
  assert.deepEqual(p.open, [{ row: 1, pr: 60, draft: false }])
  // a single task has no rows: never "done", nothing to dispatch by row
  p = specProgress(parseSpec("Something is off."))
  assert.deepEqual([p.done, p.next], [false, null])
})

test("a row whose PR was closed unmerged is not redone automatically; dependents wait, the rest goes on; the redo label dispatches it again", () => {
  const spec = parseSpec(specBody({ rows: [[1, "a", "x", "none", "y"], [2, "b", "x", "1", "y"], [3, "c", "x", "none", "y"]] }))
  // row 1 closed: neither row 1 nor row 2 (depends on it), row 3 goes on
  let p = specProgress(spec, { issue: 9, closedPrs: [pr(50, 9, 1)] })
  assert.equal(p.next.n, 3)
  assert.deepEqual(p.stopped, [{ row: 1, pr: 50 }])
  assert.deepEqual(p.closed, [{ row: 1, pr: 50, redo: false, marked: false, markedRedo: false }])
  // row 3 merged too: nothing can be done; say how to redo
  p = specProgress(spec, { issue: 9, closedPrs: [pr(50, 9, 1)], comments: [done(3, 55)] })
  assert.deepEqual([p.next, p.done], [null, false])
  assert.equal(p.blocked, 'row 1: PR #50 was closed without merging, so the row is not redone automatically; put the "pipeline:redo" label on PR #50 to redo it')
  // labelled redo: dispatched again (label as string or object; the label name comes from config)
  p = specProgress(spec, { issue: 9, closedPrs: [pr(50, 9, 1, { labels: [{ name: "pipeline:redo" }] })] })
  assert.deepEqual([p.next.n, p.stopped], [1, []])
  p = specProgress(spec, { issue: 9, redoLabel: "again", closedPrs: [pr(50, 9, 1, { labels: ["again"] })] })
  assert.equal(p.next.n, 1)
  p = specProgress(spec, { issue: 9, redoLabel: "again", closedPrs: [pr(50, 9, 1, { labels: ["pipeline:redo"] })] })
  assert.equal(p.next.n, 3)
  // the redone PR was closed again without the label: the newer PR decides, the old label does not count
  p = specProgress(spec, { issue: 9, closedPrs: [pr(60, 9, 1), pr(50, 9, 1, { labels: ["pipeline:redo"] })] })
  assert.deepEqual(p.stopped, [{ row: 1, pr: 60 }])
  // noted on the issue: still stopped when the PR is no longer in the list; a redo note releases it
  p = specProgress(spec, { issue: 9, comments: [closedMark({ row: 1, pr: 50 })] })
  assert.deepEqual([p.stopped, p.closed[0].marked], [[{ row: 1, pr: 50 }], true])
  p = specProgress(spec, { issue: 9, comments: [closedMark({ row: 1, pr: 50 }), closedMark({ row: 1, pr: 50, redo: true })] })
  assert.deepEqual([p.next.n, p.closed[0].markedRedo], [1, true])
  // merged PRs, other issues, other branches do not stop a row; a row merged later is not stopped
  p = specProgress(spec, { issue: 9, closedPrs: [pr(50, 9, 1, { merged_at: "t" }), pr(51, 8, 1), { number: 52, head: "feature/9-r1-a", merged_at: null }] })
  assert.deepEqual([p.stopped, p.next.n], [[], 2])
  p = specProgress(spec, { issue: 9, closedPrs: [pr(50, 9, 1)], comments: [done(1, 61)] })
  assert.deepEqual([p.stopped, p.next.n], [[], 2])
})

test("the Summary brief: seven items or the short four; no backticks, file names or identifiers; options are a table with the chosen one marked, or 'only one option'", () => {
  assert.deepEqual(briefProblems(brief), [])
  assert.deepEqual(briefProblems("**Problem**: Save does nothing.\n**Cause**: The button was never wired up.\n**Fix**: Wire it up.\n**Risk and how to verify**: None; click it and see the note."), [])
  assert.match(briefProblems("").join(), /"## Summary" is missing/)
  assert.match(briefProblems("Just add a switch").join(), /either the full brief .* or the short one/)
  assert.match(briefProblems(brief.replace("**Who decided**: The owner, in the discussion of 16 November.\n", "")).join(), /lacks: Who decided/)
  assert.match(briefProblems(brief.replace(" (chosen)", "")).join(), /must mark the option that was picked/)
  const noTable = brief.split("\n").filter((l) => !l.startsWith("|")).join("\n")
  assert.match(briefProblems(noTable).join(), /must be a table .* or say "only one option"/)
  assert.deepEqual(briefProblems(noTable.replace("**Options considered**", "**Options considered**: only one option; nothing else was compared.")), [])
  assert.match(briefProblems(`${brief}\nChange \`auth.py\` and check_token()`).join(), /code-like text \(backticks, auth\.py, check_token, check_token\(\)\)/)
  assert.match(briefProblems(`${brief}\n${"very long ".repeat(BRIEF_MAX / 10 + 1)}`).join(), /too long/)
  // ordinary prose is not mistaken for code
  assert.deepEqual(briefProblems(brief.replace("Simple", "Simple, e.g. no setting at all; i.e. less to explain")), [])
})

test("checkSpec: everything wrong at once; a body without a split table is not a spec", () => {
  assert.deepEqual(checkSpec(specBody()), [])
  assert.match(checkSpec("Clicking save does nothing.").join(), /Not a spec issue/)
  const bad = checkSpec(
    specBody({ summary: "", open: "1. Which default?", rows: [[1, "a", "`.github/workflows/ci.yml` and `src/a.js`", "none", "y"], [2, "b", "`src/b.js`", "1-2", "y"]] }).replace("## Decisions\n\n1. Off by default.\n\n", ""),
    { isForbidden: (p) => p.startsWith(".github/") },
  )
  assert.equal(bad.length, 5)
  assert.match(bad.join("\n"), /Open questions" is not empty/)
  assert.match(bad.join("\n"), /Row 2: "Depends on" has a range "1-2"/)
  assert.match(bad.join("\n"), /"## Summary" is missing/)
  assert.match(bad.join("\n"), /"## Decisions" is missing or empty/)
  assert.match(bad.join("\n"), /Row 1: "Where" names `\.github\/workflows\/ci\.yml`, which the executor may not touch/)
  // without a matcher, paths are not checked
  assert.deepEqual(checkSpec(specBody({ rows: [[1, "a", "`.github/x.yml`", "none", "y"]] })), [])
})
