import assert from "node:assert/strict"
import { test } from "node:test"
import { BOARD_MARK, renderBoard, sameBoard } from "../cli/core/board.mjs"
import { DEFAULTS } from "../cli/core/config.mjs"
import { emptyPlan } from "../cli/core/plan.mjs"

const now = new Date("2026-11-22T10:00:00Z")
const config = { ...DEFAULTS, mode: "on" }
const planWith = (o = {}) => ({ ...emptyPlan("on"), ...o })

test("board: grouped by what it needs, people first; an issue whose PR has its own line is left out", () => {
  const body = renderBoard({
    plan: planWith({
      board: [
        { pr: 40, issue: 2, row: 0, state: "merging", text: "approved; merged now" },
        { pr: 43, issue: 5, row: 2, state: "owner", text: "waits for an owner: decision item #900", item: 900 },
        { issue: 2, row: 0, state: "working", text: "in progress in PR #40", inPr: 40 },
        { issue: 7, row: 0, state: "working", text: "in progress in PR #77", inPr: 77 },
        { issue: 1, row: 0, state: "queued", text: "waits for a free slot | really" },
      ],
      spentToday: 3.456,
      runsToday: 4,
      running: [{ id: 1 }],
      notes: ["a note"],
    }),
    config,
    now,
    runUrl: "https://github.com/acme/app/actions/runs/9",
  })
  const lines = body.split("\n")
  assert.equal(lines[0], BOARD_MARK)
  assert.equal(lines[1], "# Pipeline status")
  assert.match(body, /\*\*Mode:\*\* `on` · \*\*Today \(UTC\):\*\* \$3\.46 of \$30\.00, 4 agent runs · \*\*Executor runs going:\*\* 1 of 2/)
  const heads = lines.filter((l) => l.startsWith("## "))
  assert.deepEqual(heads, ["## Needs a person (1)", "## Moving (2)", "## Waiting (1)"])
  assert.ok(body.indexOf("PR #43 (#5 row 2)") < body.indexOf("PR #40 (#2)"))
  // #2 is PR #40's issue: said once; #7's PR is not on the board, so #7 stays
  assert.ok(!body.includes("| #2 |"))
  assert.match(body, /\| 🔧 \| #7 \| in progress in PR #77 \|/)
  // a pipe in the text does not break the table
  assert.match(body, /waits for a free slot \\\| really/)
  assert.match(body, /<details><summary>Notes from the round that wrote this \(1\)<\/summary>/)
  assert.match(lines.at(-1), /^Written by the pipeline at 2026-11-22T10:00:00Z \(\[run\]\(https:\/\/github\.com\/acme\/app\/actions\/runs\/9\)\)\./)
})

test("board: the round's hold, failures, record mode, a run limit, nothing at all", () => {
  const body = renderBoard({ plan: planWith({ held: "waits for the daily budget: $30.00 spent today" }), config: { ...config, mode: "record", limits: { ...config.limits, daily_runs: 20 } }, now, failures: 2 })
  assert.match(body, /> Nothing new starts right now\. Waits for the daily budget: \$30\.00 spent today\./)
  assert.match(body, /> 2 steps of the last round failed/)
  assert.match(body, /Mode "record"/)
  assert.match(body, /0 agent runs of 20/)
  assert.match(body, /Nothing is in progress\. Put the "pipeline" label on an issue/)
})

test("board: the same board with another time stamp, run or notes is the same; any line of the table is not", () => {
  const plan = planWith({ board: [{ issue: 1, row: 0, state: "queued", text: "waits" }], notes: ["run 5 queued for 20 minutes"] })
  const a = renderBoard({ plan, config, now, runUrl: "u1" })
  const b = renderBoard({ plan: { ...plan, notes: ["run 5 queued for 50 minutes"] }, config, now: new Date("2026-11-22T11:00:00Z"), runUrl: "u2" })
  assert.notEqual(a, b)
  assert.ok(sameBoard(a, b))
  assert.ok(sameBoard(a.replace(/\n/g, "\r\n"), b))
  assert.ok(!sameBoard(a, renderBoard({ plan: { ...plan, board: [{ issue: 1, row: 0, state: "working", text: "the executor is dispatched now" }] }, config, now })))
  assert.ok(!sameBoard(a, renderBoard({ plan: { ...plan, spentToday: 1 }, config, now })))
  assert.ok(!sameBoard("", a))
})

test("board: each line names its issue's title, shortened, with pipes escaped", () => {
  const long = "x".repeat(100)
  const body = renderBoard({
    plan: planWith({
      board: [
        { pr: 40, issue: 2, row: 0, state: "working", text: "reviewing", title: "Add a | b" },
        { issue: 3, row: 0, state: "queued", text: "waits", title: long },
        { issue: 4, row: 0, state: "idle", text: "nothing" },
      ],
    }),
    config,
    now,
  })
  assert.match(body, /\| PR #40 \(#2\) Add a \\\| b \| reviewing \|/)
  assert.ok(body.includes(`| #3 ${"x".repeat(79)}… | waits |`))
  assert.match(body, /\| #4 \| nothing \|/)
})
