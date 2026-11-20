import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULTS } from "../cli/core/config.mjs"
import { REVIEW_RETRIES } from "../cli/core/decide.mjs"
import { decisionComment, parseItem, prAskItem, prReleaseItem, stuckItem } from "../cli/core/items.mjs"
import { findMarks, mark, parseMark } from "../cli/core/marks.mjs"
import { FIX_WORKFLOW, REVIEW_WORKFLOW, planTick } from "../cli/core/plan.mjs"

// ---------- fixtures ----------

const now = new Date("2026-11-16T04:00:00Z")
const ago = (minutes) => new Date(now.getTime() - minutes * 60000).toISOString()
const cfg = (over = {}) => ({
  ...DEFAULTS,
  mode: "on",
  owners: ["ann"],
  ...over,
  merge: { method: "squash", auto_max_level: 1, default_after_hours: 24, ...(over.merge || {}) },
  limits: { ...DEFAULTS.limits, ...(over.limits || {}) },
})
let nextId = 1000
// a comment; by default written by the pipeline's bot an hour ago
const c = (body, { by = "bot", at = ago(60) } = {}) => ({ id: nextId++, body, created_at: at, updated_at: at, user: { login: by } })
const m = (kind, obj, opts) => c(`${mark(kind, obj)}\nsome words for people`, opts)
const issue = (number, o = {}) => ({ number, title: `Task ${number}`, body: "Do the thing.", labels: ["pipeline"], state_reason: null, created_at: ago(5000), comments: [], ...o })
const SPEC = (rows = "| 1 | First | `a.js` | none | run it |\n| 2 | Second | `b.js` | 1 | run it |") =>
  `## Summary\n\nx\n\n## Acceptance criteria\n\n- works\n\n## Open questions\n\nnone\n\n## PR split\n\n| # | What | Where | Depends on | How to verify |\n|---|---|---|---|---|\n${rows}\n`
const spec = (number, o = {}) => issue(number, { body: SPEC(), ...o })
const green = [{ name: "test", status: "completed", conclusion: "success" }]
const status = (state, o = {}) => ({ context: "pipeline/review", state, created_at: ago(30), updated_at: ago(30), ...o })
const pr = (number, ref, sha, o = {}) => ({
  number,
  title: `PR ${number}`,
  body: "",
  draft: false,
  node_id: `NODE${number}`,
  labels: [],
  head: { ref, sha },
  mergeable: true,
  mergeable_state: "clean",
  comments: [],
  statuses: [],
  checkRuns: green,
  approved: null,
  ...o,
})
const review = (sha, verdict, level, extra = {}, opts = { at: ago(30) }) => m("review", { sha, verdict, level, by: "reviewer", ...extra }, opts)
// a PR whose head carries a verdict and the matching status
const reviewed = (number, ref, sha, verdict, level, o = {}) => {
  const st = verdict === "reject" ? "failure" : verdict === "approve" && level <= 1 ? "success" : "pending"
  return pr(number, ref, sha, { ...o, comments: [review(sha, verdict, level, o.reviewExtra || {}), ...(o.comments || [])], statuses: [status(st), ...(o.statuses || [])] })
}
const closed = (number, ref, o = {}) => ({ number, title: `PR ${number}`, head: { ref, sha: `c${number}` }, merged_at: null, closed_at: ago(100), labels: [], ...o })
const run = (id, display_title, o = {}) => ({ id, status: "in_progress", conclusion: null, created_at: ago(5), display_title, html_url: "", ...o })
const entry = (issueNo, minutes, o = {}) => ({ at: ago(minutes), role: "executor", issue: issueNo, row: null, usd: 1, turns: 10, outcome: "failed", ...o })
const state = (o = {}) => ({ issues: [], prs: [], closedPrs: [], items: [], ledger: [], runs: { fix: [], review: [] }, maintainers: [], markAuthors: ["bot"], repoHasChecks: null, refsDone: {}, ...o })
// a decision item as it sits on GitHub
const itemIssue = (number, built, o = {}) => ({ number, title: built.title, body: built.body, state: "open", created_at: ago(120), user: { login: "bot" }, comments: [], ...o })
const answer = (body, by = "ann", at = ago(10)) => c(body, { by, at })
const releaseItem = (number, thePr, cause, o = {}) => itemIssue(number, prReleaseItem({ pr: thePr, cause, issue: 1 }), o)
const askItem = (number, thePr, o = {}, config = cfg(), at = now) => itemIssue(number, prAskItem({ pr: thePr, review: { level: 2 }, config, now: at, issue: 1 }), o)

const plan = (s, config = cfg()) => planTick(state(s), config, now)
const does = (e) => e.actions.map((a) => a.do)
const fixes = (p) => p.dispatchFix.map((d) => [d.issue, d.row])
const reworksOf = (p) => p.dispatchRework.map((d) => [d.pr, d.attempt])
const opened = (p) => p.openItems.map((i) => [i.kind, i.cause, i.pr || i.issue])
const noted = (p, re) => p.notes.some((n) => re.test(n))
const nothingPlanned = (p) => assert.deepEqual([p.dispatchFix, p.dispatchRework, p.dispatchReview, p.merge, p.openItems, p.applyAnswers, p.applyDefaults, p.closeItems, p.markRows, p.closeIssues, p.nudges], [[], [], [], [], [], [], [], [], [], [], []], JSON.stringify(p, null, 1))

// ---------- modes ----------

test("mode off: nothing is planned, whatever the state", () => {
  const p = plan({ issues: [issue(1)], prs: [reviewed(40, "pipeline/2-x", "h", "approve", 0)] }, cfg({ mode: "off" }))
  nothingPlanned(p)
  assert.equal(p.mode, "off")
  assert.match(p.notes[0], /mode is "off"/)
})

test("mode record: everything is planned, and a note says what would have been merged", () => {
  const p = plan({ issues: [issue(1)], prs: [reviewed(40, "pipeline/2-x", "h", "approve", 0)] }, cfg({ mode: "record" }))
  assert.deepEqual(fixes(p), [[1, 0]])
  assert.deepEqual(p.merge.map((x) => x.pr), [40])
  assert.ok(noted(p, /record mode: PR #40 \(level 0\) would have been merged now/))
  // in mode on the same merge carries no such note
  assert.ok(!noted(plan({ prs: [reviewed(40, "pipeline/2-x", "h", "approve", 0)] }), /record mode/))
})

// ---------- dispatching work ----------

test("single tasks: dispatched by issue number, up to max_parallel, counting runs that are going", () => {
  const s = { issues: [issue(3), issue(1), issue(2)] }
  const p = plan(s)
  assert.deepEqual(fixes(p), [[1, 0], [2, 0]])
  assert.deepEqual(p.dispatchFix[0].actions, [{ do: "dispatch", workflow: FIX_WORKFLOW, inputs: { issue: "1", row: "", pr: "" } }])
  assert.ok(noted(p, /#3 waits for a free slot \(at most 2 executor runs at a time\)/))
  // one run going (for another issue): one slot left
  assert.deepEqual(fixes(plan({ ...s, runs: { fix: [run(7, "fix #50")], review: [] } })), [[1, 0]])
  // two going, one of them only queued: none left
  assert.deepEqual(fixes(plan({ ...s, runs: { fix: [run(7, "fix #50"), run(8, "fix #51", { status: "queued" })], review: [] } })), [])
  // a finished run takes no slot
  assert.deepEqual(fixes(plan({ ...s, runs: { fix: [run(7, "fix #50", { status: "completed", conclusion: "success" })], review: [] } })), [[1, 0], [2, 0]])
  // issues without the work label, and decision items that also carry it, are not work
  assert.deepEqual(fixes(plan({ issues: [issue(1, { labels: ["bug"] }), issue(2, { labels: ["pipeline", "pipeline:decide"] })] })), [])
})

test("never dispatched: an active claim, a run already going for the issue, an open PR, an open question in the body", () => {
  const p = plan({
    issues: [
      issue(1, { comments: [m("claim", { run: "9", row: 0 }, { at: ago(30) })] }),
      issue(2),
      issue(3),
      issue(4, { body: "Do it.\n\n## Open questions\n\n- which colour?" }),
      issue(5, { comments: [m("claim", { run: "8", row: 0 }, { at: ago(200) })] }), // stale claim (over 3 h): ignored
      issue(6, { comments: [m("claim", { run: "8", row: 0, released: true }, { at: ago(5) })] }), // released
    ],
    prs: [pr(40, "pipeline/3-x", "h", { statuses: [status("pending")] })],
    runs: { fix: [run(7, "fix #2")], review: [run(70, "review PR #40")] },
  }, cfg({ limits: { max_parallel: 9 } }))
  assert.deepEqual(fixes(p), [[5, 0], [6, 0]])
  assert.ok(noted(p, /#1 is claimed by run 9/))
  assert.ok(noted(p, /#2: an executor run is going/))
  assert.ok(noted(p, /#3 is in progress: PR #40/))
  assert.ok(noted(p, /#4 is not dispatched: .*Open questions/))
})

test("over budget: no dispatch, a stuck item is opened once", () => {
  const five = [1, 2, 3, 4, 5].map((k) => entry(1, 600 + k))
  const s = { issues: [issue(1)], ledger: five }
  const p = plan(s)
  assert.deepEqual(fixes(p), [])
  assert.deepEqual(opened(p), [["stuck", "budget", 1]])
  const built = p.openItems[0].actions[0]
  assert.deepEqual([built.do, built.labels], ["openIssue", ["pipeline:decide"]])
  assert.match(built.body, /already run 5 times \(limit 5\)/)
  // the item is open now: nothing more, it waits
  const again = plan({ ...s, items: [itemIssue(900, { title: built.title, body: built.body })] })
  assert.deepEqual([opened(again), fixes(again)], [[], []])
  assert.deepEqual(again.waiting, [{ item: 900, kind: "stuck", issue: 1, due: null }])
  // somebody closed the item without answering: not asked again, not dispatched
  const shut = plan({ ...s, items: [itemIssue(900, { title: built.title, body: built.body }, { state: "closed" })] })
  assert.deepEqual([opened(shut), fixes(shut)], [[], []])
  assert.ok(noted(shut, /#1: already asked/))
  // money instead of runs
  assert.deepEqual(opened(plan({ issues: [issue(1)], ledger: [entry(1, 3000, { usd: 25 })] })), [["stuck", "budget", 1]])
  // runs where the agent was unavailable do not count against the issue
  assert.deepEqual(fixes(plan({ issues: [issue(1)], ledger: five.map((e) => ({ ...e, at: ago(3000), outcome: "unavailable", turns: 0 })) })), [[1, 0]])
  // nor do runs that refused to start, should a ledger line for them ever be written; and a refusal after "cannot fix" does not hide it
  assert.deepEqual(fixes(plan({ issues: [issue(1)], ledger: five.map((e) => ({ ...e, at: ago(3000), outcome: "skipped", turns: 0, usd: 0 })) })), [[1, 0]])
  assert.deepEqual(opened(plan({ issues: [issue(1)], ledger: [entry(1, 300, { outcome: "cannot_fix" }), entry(1, 200, { outcome: "skipped", usd: 0 })] })), [["stuck", "gave-up", 1]])
})

test("the ledger has fewer lines than the executor's own result marks (it is not being written): the marks are counted", () => {
  const result = (minutes, outcome, o = {}) => m("result", { outcome, row: 0, run: String(minutes), ...o }, { at: ago(minutes) })
  // five failed runs on the issue, nothing in the ledger: asked once instead of a sixth run
  const five = [500, 400, 300, 200, 100].map((k) => result(k, "failed"))
  const p = plan({ issues: [issue(1, { comments: five })] })
  assert.deepEqual([fixes(p), opened(p)], [[], [["stuck", "budget", 1]]])
  assert.match(p.openItems[0].actions[0].body, /already run 5 times on this \(limit 5\), and the ledger has no line for some of those runs/)
  // four: one more run is allowed
  assert.deepEqual(fixes(plan({ issues: [issue(1, { comments: five.slice(1) })] })), [[1, 0]])
  // "cannot do it" is read from the last mark when the ledger does not have that run
  const gave = plan({ issues: [issue(1, { comments: [result(100, "cannot_fix")] })] })
  assert.deepEqual([fixes(gave), opened(gave)], [[], [["stuck", "gave-up", 1]]])
  // with the ledger complete, the ledger is what counts (a successful rework has a line and no result mark)
  const full = plan({ issues: [issue(1, { comments: [result(300, "cannot_fix"), result(200, "failed")] })], ledger: [entry(1, 300, { outcome: "cannot_fix" }), entry(1, 200), entry(1, 100, { outcome: "rework" })] })
  assert.deepEqual([fixes(full), opened(full)], [[[1, 0]], []])
  // counts start again after a decision; another row's marks are another row's; a mark typed by someone else is nobody's
  const decided = c(decisionComment({ item: 900, key: "A", by: "ann", action: "retry" }), { at: ago(50) })
  assert.deepEqual(fixes(plan({ issues: [issue(1, { comments: [...five, decided] })] })), [[1, 0]])
  assert.deepEqual(fixes(plan({ issues: [issue(1, { comments: five.map((x) => ({ ...x, body: x.body.replace('"row":0', '"row":2') })) })] })), [[1, 0]])
  assert.deepEqual(fixes(plan({ issues: [issue(1, { comments: five.map((x) => ({ ...x, user: { login: "mallory" } })) })] })), [[1, 0]])
})

test("the executor said it cannot do it: a stuck item instead of another run; a decision afterwards starts the counts again", () => {
  const s = { issues: [issue(1)], ledger: [entry(1, 300, { outcome: "cannot_fix" })] }
  const p = plan(s)
  assert.deepEqual([fixes(p), opened(p)], [[], [["stuck", "gave-up", 1]]])
  // an owner decided after that run: dispatched again
  const decided = plan({ issues: [issue(1, { comments: [c(decisionComment({ item: 900, key: "A", by: "ann", action: "retry", text: "use the v2 endpoint" }), { at: ago(100) })] })], ledger: s.ledger })
  assert.deepEqual([fixes(decided), opened(decided)], [[[1, 0]], []])
  // a later ordinary failure is not "cannot do it"
  assert.deepEqual(fixes(plan({ issues: [issue(1)], ledger: [...s.ledger, entry(1, 200)] })), [[1, 0]])
})

test("the executor refused to start (a skip mark): permanent = ask an owner, passing = not dispatched again right away", () => {
  const permanent = plan({ issues: [issue(1, { comments: [m("skip", { why: "no_row", permanent: true, row: 0 }, { at: ago(300) })] })] })
  assert.deepEqual([fixes(permanent), opened(permanent)], [[], [["stuck", "refused", 1]]])
  const fresh = plan({ issues: [issue(1, { comments: [m("skip", { why: "claimed", permanent: false, row: 0 }, { at: ago(10) })] })] })
  assert.deepEqual(fixes(fresh), [])
  assert.ok(noted(fresh, /#1: the executor did not start \(claimed\)/))
  assert.deepEqual(fixes(plan({ issues: [issue(1, { comments: [m("skip", { why: "claimed", permanent: false, row: 0 }, { at: ago(45) })] })] })), [[1, 0]])
  // it said until when
  const until = { why: "cooldown", permanent: false, row: 0, until: new Date(now.getTime() + 3600000).toISOString() }
  assert.deepEqual(fixes(plan({ issues: [issue(1, { comments: [m("skip", until, { at: ago(45) })] })] })), [])
})

test("runs that cannot be attributed yet block dispatching, for at most an hour; ghost runs are ignored", () => {
  const s = { issues: [issue(1), issue(2)] }
  const fixRuns = (...runs) => plan({ ...s, runs: { fix: runs, review: [] } })
  // queued five minutes ago, the title does not name an issue yet: could be issue 1
  const blocked = fixRuns(run(7, "pipeline-fix", { status: "queued", created_at: ago(5) }))
  assert.deepEqual(fixes(blocked), [])
  assert.ok(noted(blocked, /nothing is dispatched this round: run 7 is queued or starting/))
  // running but still unnamed, 40 minutes: still blocks
  assert.deepEqual(fixes(fixRuns(run(7, "pipeline-fix", { created_at: ago(40) }))), [])
  // after an hour it no longer blocks, but it still takes a slot
  assert.deepEqual(fixes(fixRuns(run(7, "pipeline-fix", { created_at: ago(70) }))), [[1, 0]])
  // queued over 15 minutes with no job at all: a ghost, takes no slot, blocks nothing
  const ghost = fixRuns(run(7, "pipeline-fix", { status: "queued", created_at: ago(20), jobs: 0 }))
  assert.deepEqual(fixes(ghost), [[1, 0], [2, 0]])
  assert.deepEqual(ghost.running, [])
  assert.ok(noted(ghost, /run 7 has been queued for 20 minutes without a job \(a ghost run\): ignored/))
  // job count unknown: an unnamed run queued that long is taken for a ghost too
  assert.deepEqual(fixes(fixRuns(run(7, "pipeline-fix", { status: "queued", created_at: ago(20) }))), [[1, 0], [2, 0]])
  // it has a job: it is real, however long it has waited
  assert.deepEqual(fixes(fixRuns(run(7, "pipeline-fix", { status: "queued", created_at: ago(20), jobs: 1 }))), [])
  // a named run queued for long with a job count of 0 is a ghost as well: issue 1 is not held back by it
  assert.deepEqual(fixes(fixRuns(run(7, "fix #1", { status: "queued", created_at: ago(20), jobs: 0 }))), [[1, 0], [2, 0]])
  // the runs could not be read at all: nothing is dispatched
  const unknown = plan({ ...s, runs: { fix: null, review: [] } })
  assert.deepEqual(fixes(unknown), [])
  assert.ok(noted(unknown, /could not read the executor runs/))
})

test("today's spend at the daily limit: no executor and no review is dispatched", () => {
  const p = plan({ issues: [issue(1)], prs: [pr(40, "pipeline/2-x", "h")], ledger: [{ at: ago(60), role: "reviewer", pr: 9, usd: 31, turns: 5, outcome: "approve" }] })
  assert.deepEqual([fixes(p), p.dispatchReview], [[], []])
  assert.ok(noted(p, /nothing is dispatched: \$31\.00 spent today/))
  assert.equal(p.spentToday, 31)
  // yesterday's spend does not count
  assert.deepEqual(fixes(plan({ issues: [issue(1)], ledger: [{ at: ago(60 * 30), role: "reviewer", pr: 9, usd: 31, turns: 5, outcome: "approve" }] })), [[1, 0]])
})

test("cooldown: nothing is dispatched while the agent is unavailable; afterwards one probe, then back to normal", () => {
  const un = (minutes, o = {}) => ({ at: ago(minutes), role: "executor", issue: 1, turns: 0, usd: 0, outcome: "unavailable", unavailable: "quota", ...o })
  const base = { issues: [issue(1), issue(2), issue(3)], prs: [pr(40, "pipeline/9-x", "h")] }
  const cool = plan({ ...base, ledger: [un(12), un(11), un(10)] })
  assert.deepEqual([fixes(cool), cool.dispatchReview, cool.dispatchRework], [[], [], []])
  assert.equal(cool.cooldown.cooling, true)
  assert.ok(noted(cool, /the agent cannot be used right now \(quota\): nothing is dispatched until 2026-11-16T04:20:00Z/))
  // unavailable runs are not charged to the issue: no stuck item
  assert.deepEqual(opened(cool), [])
  // the wait is over and nothing has worked since: one probe; reviews go again
  const probe = plan({ ...base, ledger: [un(42), un(41)] })
  assert.deepEqual(fixes(probe), [[1, 0]])
  assert.deepEqual(probe.dispatchReview.map((r) => r.pr), [40])
  assert.ok(noted(probe, /one probe run is dispatched first/))
  // the probe is going: wait for it
  const waiting = plan({ ...base, ledger: [un(42)], runs: { fix: [run(5, "fix #99", { created_at: ago(5) })], review: [] } })
  assert.deepEqual(fixes(waiting), [])
  assert.ok(noted(waiting, /waiting for the probe run \(5\)/))
  // a run that started before the cooldown ended is not the probe
  assert.deepEqual(fixes(plan({ ...base, ledger: [un(42)], runs: { fix: [run(5, "fix #99", { created_at: ago(50) })], review: [] } }, cfg({ limits: { max_parallel: 3 } }))), [[1, 0]])
  // the probe has been going for 20 minutes: the agent works
  const long = plan({ ...base, ledger: [un(62)], runs: { fix: [run(5, "fix #99", { created_at: ago(25) })], review: [] } }, cfg({ limits: { max_parallel: 3 } }))
  assert.deepEqual(fixes(long), [[1, 0], [2, 0]])
  assert.equal(long.cooldown, null)
  // one run that really ran clears it
  const back = plan({ ...base, ledger: [un(10), { at: ago(2), role: "reviewer", pr: 60, turns: 8, usd: 1, outcome: "approve" }] })
  assert.equal(back.cooldown, null)
  assert.deepEqual(fixes(back), [[1, 0], [2, 0]])
})

// ---------- spec issues ----------

test("spec issue: row by row in dependency order, one PR of the issue at a time", () => {
  // nothing done yet: row 1
  assert.deepEqual(fixes(plan({ issues: [spec(1)] })), [[1, 1]])
  assert.deepEqual(plan({ issues: [spec(1)] }).dispatchFix[0].actions[0].inputs, { issue: "1", row: "1", pr: "" })
  // row 1 has an open PR: wait
  const busy = plan({ issues: [spec(1)], prs: [pr(40, "pipeline/1-r1-first", "h", { statuses: [status("pending")] })], runs: { fix: [], review: [run(70, "review PR #40")] } })
  assert.deepEqual(fixes(busy), [])
  assert.ok(noted(busy, /#1 row 1 is in progress: PR #40/))
  // row 1 merged a moment ago: mark it on the issue and go on with row 2 in the same round
  const merged = plan({ issues: [spec(1)], closedPrs: [closed(40, "pipeline/1-r1-first", { merged_at: ago(3) })] })
  assert.deepEqual(merged.markRows.map((r) => [r.issue, r.row, r.pr, r.kind]), [[1, 1, 40, "done"]])
  assert.deepEqual(parseMark("row-done", merged.markRows[0].actions[0].body), { row: 1, pr: 40 })
  assert.deepEqual(fixes(merged), [[1, 2]])
  // already marked: not marked again
  const marked = plan({ issues: [spec(1, { comments: [m("row-done", { row: 1, pr: 40 })] })], closedPrs: [closed(40, "pipeline/1-r1-first", { merged_at: ago(3) })] })
  assert.deepEqual([marked.markRows, fixes(marked)], [[], [[1, 2]]])
  // each row has its own budget: five runs on row 1 do not stop row 2
  const rowBudget = plan({ issues: [spec(1, { comments: [m("row-done", { row: 1, pr: 40 })] })], ledger: [1, 2, 3, 4, 5].map((k) => entry(1, 500 + k, { row: 1 })) })
  assert.deepEqual([fixes(rowBudget), opened(rowBudget)], [[[1, 2]], []])
  // ... and five on row 2 do: the item names the row
  const stuck = plan({ issues: [spec(1, { comments: [m("row-done", { row: 1, pr: 40 })] })], ledger: [1, 2, 3, 4, 5].map((k) => entry(1, 500 + k, { row: 2 })) })
  assert.deepEqual([fixes(stuck), stuck.openItems.map((i) => [i.kind, i.issue, i.row])], [[], [["stuck", 1, 2]]])
  assert.match(stuck.openItems[0].title, /stuck on #1 row 2/)
})

test("spec issue: every row merged closes the issue (marks first); a reopened finished issue is left alone", () => {
  const done = [m("row-done", { row: 1, pr: 40 })]
  const p = plan({ issues: [spec(1, { comments: done })], closedPrs: [closed(41, "pipeline/1-r2-second", { merged_at: ago(3) })] })
  assert.deepEqual(p.markRows.map((r) => [r.row, r.pr]), [[2, 41]])
  assert.deepEqual(p.closeIssues.map((x) => [x.issue, x.rows]), [[1, [{ row: 1, pr: 40 }, { row: 2, pr: 41 }]]])
  assert.deepEqual(does(p.closeIssues[0]), ["closeIssue", "comment"])
  assert.match(p.closeIssues[0].actions[1].body, /Every row of the PR split is merged \(row 1: PR #40, row 2: PR #41\)/)
  assert.deepEqual(fixes(p), [])
  // reopened by a person afterwards, nothing new to do: not closed again every round
  const reopened = plan({ issues: [spec(1, { state_reason: "reopened", comments: [...done, m("row-done", { row: 2, pr: 41 })] })] })
  assert.deepEqual([reopened.closeIssues, fixes(reopened)], [[], []])
  assert.ok(noted(reopened, /#1 was reopened but every row of its PR split is merged/))
})

test("spec issue: dependencies on other issues, and a spec that cannot be read", () => {
  const body = SPEC("| 1 | First | `a.js` | #77 | run it |\n| 2 | Second | `b.js` | none | run it |")
  // row 1 waits for #77, row 2 can go
  assert.deepEqual(fixes(plan({ issues: [issue(1, { body })] })), [[1, 2]])
  assert.deepEqual(fixes(plan({ issues: [issue(1, { body })], refsDone: { 77: true } })), [[1, 1]])
  const waits = plan({ issues: [issue(1, { body: SPEC("| 1 | First | `a.js` | #77 | run it |") })] })
  assert.deepEqual(fixes(waits), [])
  assert.ok(noted(waits, /#1 is not dispatched: row 1 waits for #77/))
  const broken = plan({ issues: [issue(1, { body: SPEC("| 1 | First | `a.js` | 1-3 | run it |") })] })
  assert.deepEqual(fixes(broken), [])
  assert.ok(noted(broken, /#1 is not dispatched: .*range/))
})

test("a PR closed without merging stops its row: marked once, not redone; the redo label (on the issue or on the PR) dispatches it again", () => {
  const gone = closed(40, "pipeline/1-r1-first")
  const p = plan({ issues: [spec(1)], closedPrs: [gone] })
  assert.deepEqual(p.markRows.map((r) => [r.issue, r.row, r.pr, r.kind, r.redo]), [[1, 1, 40, "closed", false]])
  assert.deepEqual(parseMark("row-closed", p.markRows[0].actions[0].body), { row: 1, pr: 40 })
  assert.match(p.markRows[0].actions[0].body, /put the "pipeline:redo" label on this issue/)
  // row 2 depends on row 1: nothing can go
  assert.deepEqual(fixes(p), [])
  assert.ok(noted(p, /PR #40 was closed without merging/))
  // the mark is there (and the PR may be long gone from the list): nothing is written again
  const marked = spec(1, { comments: [m("row-closed", { row: 1, pr: 40 })] })
  const quiet = plan({ issues: [marked] })
  assert.deepEqual([quiet.markRows, fixes(quiet)], [[], []])
  // the redo label on the issue: recorded, taken off again, row 1 dispatched in the same round
  const redo = plan({ issues: [{ ...marked, labels: ["pipeline", "pipeline:redo"] }] })
  assert.deepEqual(redo.markRows.map((r) => [r.row, r.pr, r.kind, r.redo]), [[1, 40, "closed", true]])
  assert.deepEqual(redo.markRows[0].actions.map((a) => [a.do, a.remove || ""]), [["label", "pipeline:redo"], ["comment", ""]])
  assert.deepEqual(parseMark("row-closed", redo.markRows[0].actions[1].body), { row: 1, pr: 40, redo: true })
  assert.deepEqual(fixes(redo), [[1, 1]])
  // next round the redo is on record: dispatched (if it was not yet), nothing written
  const after = plan({ issues: [spec(1, { comments: [...marked.comments, m("row-closed", { row: 1, pr: 40, redo: true })] })] })
  assert.deepEqual([after.markRows, fixes(after)], [[], [[1, 1]]])
  // the redo label on the closed PR works the same
  const onPr = plan({ issues: [marked], closedPrs: [{ ...gone, labels: ["pipeline:redo"] }] })
  assert.deepEqual([onPr.markRows.map((r) => r.redo), fixes(onPr)], [[true], [[1, 1]]])
  // a redo label with nothing to redo is taken off, so it cannot redo some later PR unasked
  const idle = plan({ issues: [spec(1, { labels: ["pipeline", "pipeline:redo"] })] })
  assert.deepEqual(idle.labels.map((l) => [l.on, l.remove]), [[1, "pipeline:redo"]])
  assert.deepEqual(fixes(idle), [[1, 1]])
})

// ---------- single tasks ----------

test("single task: the merged PR closes the issue; a reopened issue is worked on again; a closed PR stops it", () => {
  const p = plan({ issues: [issue(1)], closedPrs: [closed(40, "pipeline/1-task", { merged_at: ago(3) })] })
  assert.deepEqual(p.markRows.map((r) => [r.issue, r.row, r.pr, r.kind]), [[1, 0, 40, "done"]])
  assert.deepEqual(p.closeIssues.map((x) => x.issue), [1])
  assert.match(p.closeIssues[0].actions[1].body, /PR #40 was merged\. Closing this issue/)
  assert.deepEqual(fixes(p), [])
  // reopened later: that PR is on record, so it is not "just merged" again
  const again = plan({ issues: [issue(1, { state_reason: "reopened", comments: [m("row-done", { row: 0, pr: 40 })] })], closedPrs: [closed(40, "pipeline/1-task", { merged_at: ago(300) })] })
  assert.deepEqual([again.closeIssues, again.markRows, fixes(again)], [[], [], [[1, 0]]])
  // closed without merging: marked, not redone
  const shut = plan({ issues: [issue(1)], closedPrs: [closed(41, "pipeline/1-task")] })
  assert.deepEqual([shut.markRows.map((r) => [r.row, r.pr, r.kind]), fixes(shut)], [[[0, 41, "closed"]], []])
  assert.ok(noted(shut, /#1 is not dispatched: PR #41 was closed without merging; put the "pipeline:redo" label on the issue/))
  // with the redo label: dispatched again
  const redo = plan({ issues: [issue(1, { labels: ["pipeline", "pipeline:redo"], comments: [m("row-closed", { row: 0, pr: 41 })] })] })
  assert.deepEqual([redo.markRows.map((r) => r.redo), fixes(redo)], [[true], [[1, 0]]])
  // a PR closed before the one that was merged is history
  const history = plan({ issues: [issue(1, { state_reason: "reopened", comments: [m("row-closed", { row: 0, pr: 39 }), m("row-done", { row: 0, pr: 40 })] })] })
  assert.deepEqual(fixes(history), [[1, 0]])
  // PRs of another issue, or on other branches, do not count
  assert.deepEqual(fixes(plan({ issues: [issue(1)], closedPrs: [closed(40, "pipeline/11-task", { merged_at: ago(3) }), closed(41, "feature/1-task", { merged_at: ago(3) })] })), [[1, 0]])
})

// ---------- review ----------

test("review: dispatched when the head has no verdict and no review is running", () => {
  const p = plan({ prs: [pr(40, "pipeline/1-x", "h")] })
  assert.deepEqual(p.dispatchReview, [{ pr: 40, attempt: 1, actions: [{ do: "dispatch", workflow: REVIEW_WORKFLOW, inputs: { pr: "40" } }] }])
  // a verdict for an older head does not count
  assert.deepEqual(plan({ prs: [pr(40, "pipeline/1-x", "h2", { comments: [review("h1", "approve", 0)], statuses: [] })] }).dispatchReview.map((r) => r.pr), [40])
  // running, or queued and named: wait
  const running = plan({ prs: [pr(40, "pipeline/1-x", "h")], runs: { fix: [], review: [run(70, "review PR #40")] } })
  assert.deepEqual(running.dispatchReview, [])
  assert.ok(noted(running, /PR #40: the review is running/))
  // a review of PR #401 is not a review of PR #40
  assert.deepEqual(plan({ prs: [pr(40, "pipeline/1-x", "h")], runs: { fix: [], review: [run(70, "review PR #401")] } }).dispatchReview.map((r) => r.pr), [40])
  // a queued review run that does not say yet which PR it is for: could be this one
  const unnamed = plan({ prs: [pr(40, "pipeline/1-x", "h")], runs: { fix: [], review: [run(70, "pipeline-review", { status: "queued", created_at: ago(2) })] } })
  assert.deepEqual(unnamed.dispatchReview, [])
  // the review runs could not be read: none is dispatched
  assert.deepEqual(plan({ prs: [pr(40, "pipeline/1-x", "h")], runs: { fix: [], review: null } }).dispatchReview, [])
  // the executor is reworking this PR right now: the head is about to change
  assert.deepEqual(plan({ prs: [pr(40, "pipeline/1-x", "h")], runs: { fix: [run(7, "fix #1 (PR #40)")], review: [] } }).dispatchReview, [])
  // PRs on other branches are none of the pipeline's business
  nothingPlanned(plan({ prs: [pr(40, "feature/1-x", "h"), pr(41, "pipeline/ledger", "h")] }))
})

test("review that did not run: retried REVIEW_RETRIES times, then a pr-release item saying so, once", () => {
  const failed = (attempt, o = {}) => m("review", { sha: "h", failed: true, attempt, reason: "no output", by: "reviewer", ...o }, { at: ago(50 - attempt) })
  const withFailed = (n, extra = []) => pr(40, "pipeline/1-x", "h", { comments: [...Array.from({ length: n }, (_, k) => failed(k + 1)), ...extra], statuses: [status("pending")] })
  assert.equal(REVIEW_RETRIES, 3)
  assert.deepEqual(plan({ prs: [withFailed(1)] }).dispatchReview.map((r) => [r.pr, r.attempt]), [[40, 2]])
  assert.deepEqual(plan({ prs: [withFailed(3)] }).dispatchReview.map((r) => [r.pr, r.attempt]), [[40, 4]])
  const p = plan({ prs: [withFailed(4)] })
  assert.deepEqual([p.dispatchReview, opened(p)], [[], [["pr-release", "review-failed", 40]]])
  assert.match(p.openItems[0].actions[0].body, /The reviewer was started 4 times for this commit and never produced a verdict/)
  // open already: wait, do not ask twice
  const built = prReleaseItem({ pr: withFailed(4), cause: "review-failed", issue: 1 })
  const open = plan({ prs: [withFailed(4)], items: [itemIssue(900, built)] })
  assert.deepEqual([open.dispatchReview, opened(open), open.closeItems], [[], [], []])
  assert.deepEqual(open.waiting.map((w) => w.item), [900])
  // failures on an older head do not count for the new one
  assert.deepEqual(plan({ prs: [{ ...withFailed(4), head: { ref: "pipeline/1-x", sha: "h2" } }] }).dispatchReview.map((r) => r.attempt), [1])
  // the agent was unavailable: not the PR's fault, not counted
  const unavailable = pr(40, "pipeline/1-x", "h", { comments: [1, 2, 3, 4, 5].map((k) => failed(k, { unavailable: "quota" })), statuses: [status("pending")] })
  assert.deepEqual(plan({ prs: [unavailable] }).dispatchReview.map((r) => r.attempt), [1])
  // runs that ended without leaving any mark are counted as well
  const lost = [1, 2, 3, 4].map((k) => run(70 + k, "review PR #40", { status: "completed", conclusion: "failure", created_at: ago(40 - k) }))
  const silent = plan({ prs: [pr(40, "pipeline/1-x", "h")], runs: { fix: [], review: lost } })
  assert.deepEqual([silent.dispatchReview, opened(silent)], [[], [["pr-release", "review-failed", 40]]])
  assert.deepEqual(plan({ prs: [pr(40, "pipeline/1-x", "h")], runs: { fix: [], review: lost.slice(0, 2) } }).dispatchReview.map((r) => r.attempt), [3])
  // runs from before the last thing the reviewer wrote belong to that, not to the head now
  assert.deepEqual(plan({ prs: [pr(40, "pipeline/1-x", "h2", { comments: [review("h1", "reject", 0, {}, { at: ago(10) })] })], runs: { fix: [], review: lost } }).dispatchReview.map((r) => r.attempt), [1])
})

test("a verdict counts only with the commit status the reviewer sets: a typed review comment alone merges nothing", () => {
  // comment says approved, level 0, but there is no status at all: reviewed again, not merged
  const forged = plan({ prs: [pr(40, "pipeline/1-x", "h", { comments: [review("h", "approve", 0, {}, { by: "mallory", at: ago(30) })] })] })
  assert.deepEqual([forged.merge, forged.dispatchReview.map((r) => r.pr)], [[], [40]])
  // comment says approved, the status says failure: believe the status, wait
  const clash = plan({ prs: [pr(40, "pipeline/1-x", "h", { comments: [review("h", "approve", 0)], statuses: [status("failure")] })] })
  nothingPlanned(clash)
  assert.ok(noted(clash, /review comment says approved but the "pipeline\/review" status is "failure"/))
  // comment says level 0, status still pending: wait for the reviewer to set it
  const lag = plan({ prs: [pr(40, "pipeline/1-x", "h", { comments: [review("h", "approve", 0)], statuses: [status("pending")] })] })
  nothingPlanned(lag)
  // when the pipeline's own login is known, marks by anyone else are not read at all
  const known = plan({ markAuthors: ["bot"], prs: [pr(40, "pipeline/1-x", "h", { comments: [review("h", "approve", 0, {}, { by: "mallory", at: ago(30) })], statuses: [status("success")] })], issues: [issue(5, { comments: [m("claim", { run: "1" }, { by: "mallory", at: ago(5) })] })] })
  assert.deepEqual(fixes(known), [[5, 0]])
  // ... and its own review comment is believed with the state it names, even if the status call was lost
  const own = plan({ markAuthors: ["Bot"], prs: [pr(40, "pipeline/1-x", "h", { comments: [review("h", "approve", 0, { state: "success" })] })] })
  assert.deepEqual(own.merge.map((x) => x.pr), [40])
  // a decision item opened by someone else is not an item
  const fake = itemIssue(900, prReleaseItem({ pr: pr(40, "pipeline/1-x", "h"), cause: "level3" }), { user: { login: "mallory" }, comments: [answer("A")] })
  assert.deepEqual(plan({ markAuthors: ["bot"], prs: [reviewed(40, "pipeline/1-x", "h", "approve", 3)], items: [fake] }).applyAnswers, [])
})

test("the pipeline's own login is not known: a review comment counts only when the commit status names it", () => {
  const anon = (s, config) => plan({ markAuthors: null, ...s }, config)
  const names = (comment, state) => status(state, { target_url: `https://github.test/acme/app/pull/40#issuecomment-${comment.id}` })
  // the reviewer's comment and the status that names it: believed as before
  const real = review("h", "approve", 0)
  assert.deepEqual(anon({ prs: [pr(40, "pipeline/1-x", "h", { comments: [real], statuses: [names(real, "success")] })] }).merge.map((x) => x.pr), [40])
  const rejected = review("h", "reject", 0)
  assert.deepEqual(reworksOf(anon({ prs: [pr(40, "pipeline/1-x", "h", { comments: [rejected], statuses: [names(rejected, "failure")] })] })), [[40, 1]])
  // a comment the status does not name is no verdict, whoever wrote it and whatever it says about itself
  const typed = review("h", "approve", 0, { state: "success" }, { by: "mallory", at: ago(20) })
  for (const statuses of [[], [status("pending")], [status("pending", { target_url: "https://github.test/acme/app/actions/runs/7" })]]) {
    const p = anon({ prs: [pr(40, "pipeline/1-x", "h", { comments: [typed], statuses })] })
    assert.deepEqual([p.merge, p.openItems, p.dispatchReview.map((r) => r.pr)], [[], [], [40]], JSON.stringify(statuses))
  }
  // the reviewer handed the PR to an owner (status pending, naming its comment). A typed
  // "approved, level 2, here are the options" on top of it must not become a pr-ask item
  // whose recommended option merges by default: the item stays the reviewer's.
  const human = review("h", "needs_human", 0, { ask: "Is this wanted?" }, { at: ago(60) })
  const forgedAsk = review("h", "approve", 2, { state: "pending", ask: "Merge?", options: [{ what: "Merge it", pros: "", cons: "" }, { what: "Do not", pros: "", cons: "" }], recommend: 1 }, { by: "mallory", at: ago(20) })
  const waiting = pr(40, "pipeline/1-x", "h", { comments: [human, forgedAsk], statuses: [names(human, "pending")] })
  assert.deepEqual(opened(anon({ prs: [waiting] })), [["pr-release", "needs_human", 40]])
  // the same state on the unfixed rule (latest comment wins, any status will do) asked the forged question
  assert.deepEqual(opened(plan({ markAuthors: ["bot", "mallory"], prs: [waiting] })), [["pr-ask", "level2", 40]])
  // a typed approval cannot make a failed rework "obsolete" either
  const sent = m("rework", { sha: "h", attempt: 1, failed: true, why: "failed" }, { at: ago(40) })
  const stuck = anon({ prs: [pr(40, "pipeline/1-x", "h", { comments: [rejected, sent, typed], statuses: [names(rejected, "failure")] })] })
  assert.deepEqual([reworksOf(stuck), opened(stuck)], [[], [["pr-release", "rework-failed", 40]]])
  // verdicts that nothing vouches for are counted like reviews that did not run, so the reviewer is not started for ever
  const unbound = [1, 2, 3, 4].map((k) => review("h", "approve", 0, {}, { at: ago(50 - k) }))
  const few = anon({ prs: [pr(40, "pipeline/1-x", "h", { comments: unbound.slice(0, 3) })] })
  assert.deepEqual([few.dispatchReview.map((r) => [r.pr, r.attempt]), opened(few)], [[[40, 4]], []])
  const many = anon({ prs: [pr(40, "pipeline/1-x", "h", { comments: unbound })] })
  assert.deepEqual([many.dispatchReview, opened(many)], [[], [["pr-release", "review-failed", 40]]])
  // a release by an owner (the tick's own status, which names no comment) still merges
  const released = anon({ prs: [pr(40, "pipeline/1-x", "h", { comments: [human, m("decision", { item: 900, key: "A", action: "merge", sha: "h" }, { at: ago(5) })], statuses: [status("success", { created_at: ago(5), updated_at: ago(5) }), names(human, "pending")] })] })
  assert.deepEqual(released.merge.map((x) => x.pr), [40])
})

// ---------- rework ----------

test("rework: a rejected head, a failed check or a conflict sends the PR back; the mark is written before the dispatch", () => {
  const p = plan({
    prs: [
      reviewed(41, "pipeline/1-x", "h1", "reject", 0),
      reviewed(42, "pipeline/2-r3-x", "h2", "approve", 0, { checkRuns: [{ name: "unit", status: "completed", conclusion: "failure" }] }),
      reviewed(43, "pipeline/3-x", "h3", "approve", 0, { mergeable: false, mergeable_state: "dirty" }),
      reviewed(44, "pipeline/4-x", "h4", "approve", 0, { statuses: [{ context: "ci/lint", state: "error" }] }),
      reviewed(45, "pipeline/5-x", "h5", "approve", 0),
    ],
  }, cfg({ limits: { max_parallel: 9 } }))
  assert.deepEqual(p.dispatchRework.map((r) => [r.pr, r.issue, r.row, r.sha, r.attempt, r.why]), [
    [41, 1, 0, "h1", 1, "the reviewer rejected it"],
    [42, 2, 3, "h2", 1, 'check "unit" failed'],
    [43, 3, 0, "h3", 1, "it conflicts with the base branch"],
    [44, 4, 0, "h4", 1, 'check "ci/lint" failed'],
  ])
  const [first, second] = p.dispatchRework
  assert.deepEqual(does(first), ["comment", "dispatch"])
  assert.deepEqual(parseMark("rework", first.actions[0].body), { sha: "h1", attempt: 1, why: "the reviewer rejected it" })
  assert.match(first.actions[0].body, /Sent back to the executor \(rework 1 of at most 4\): the reviewer rejected it\./)
  assert.deepEqual(first.actions[1], { do: "dispatch", workflow: FIX_WORKFLOW, inputs: { issue: "1", row: "", pr: "41" } })
  assert.deepEqual(second.actions[1].inputs, { issue: "2", row: "3", pr: "42" })
  assert.deepEqual(p.merge.map((x) => x.pr), [45])
  // a cancelled or skipped check is not the change's fault: no rework (and no merge while it is not green)
  const cancelled = plan({ prs: [reviewed(46, "pipeline/6-x", "h", "approve", 0, { checkRuns: [{ name: "unit", status: "completed", conclusion: "cancelled" }] })] })
  assert.deepEqual([cancelled.dispatchRework, cancelled.merge], [[], []])
  // a failed check sends an unreviewed head back too, and a draft is reworked like any other PR
  const early = plan({ prs: [pr(47, "pipeline/7-x", "h", { draft: true, checkRuns: [{ name: "unit", status: "completed", conclusion: "timed_out" }] })] })
  assert.deepEqual([reworksOf(early), early.dispatchReview], [[[47, 1]], []])
  assert.equal(early.dispatchRework[0].why, 'check "unit" timed out')
  // a check named like the pipeline's own status is the review itself, not a check
  assert.deepEqual(plan({ prs: [reviewed(48, "pipeline/8-x", "h", "approve", 0, { checkRuns: [...green, { name: "pipeline/review", status: "completed", conclusion: "failure" }] })] }).dispatchRework, [])
})

test("rework is idempotent: once the mark for this head is there, nothing is dispatched again", () => {
  const first = plan({ prs: [reviewed(41, "pipeline/1-x", "h1", "reject", 0)] })
  const written = c(first.dispatchRework[0].actions[0].body, { at: ago(1) })
  const second = plan({ prs: [reviewed(41, "pipeline/1-x", "h1", "reject", 0, { comments: [written] })] })
  nothingPlanned(second)
  assert.ok(noted(second, /PR #41: a rework of this commit was dispatched; waiting for its result/))
  // the run is going (its title names the issue): wait as well, mark or no mark
  nothingPlanned(plan({ prs: [reviewed(41, "pipeline/1-x", "h1", "reject", 0)], runs: { fix: [run(7, "fix #1 (PR #41)")], review: [] } }))
  // ... or the executor holds the claim on the issue
  const claimed = plan({ issues: [issue(1, { comments: [m("claim", { run: "9" }, { at: ago(5) })] })], prs: [reviewed(41, "pipeline/1-x", "h1", "reject", 0)] })
  assert.deepEqual(claimed.dispatchRework, [])
  // the rework pushed a new head, which was rejected again: attempt 2
  const next = plan({ prs: [reviewed(41, "pipeline/1-x", "h2", "reject", 0, { comments: [m("rework", { sha: "h1", attempt: 1 }), m("rework", { sha: "h1", attempt: 1, head: "h2", done: true })] })] })
  assert.deepEqual(reworksOf(next), [[41, 2]])
})

test("rework that came to nothing: failed, lost or refused for good puts a pr-release item in front of an owner", () => {
  const sent = (minutes) => m("rework", { sha: "h1", attempt: 1, why: "the reviewer rejected it" }, { at: ago(minutes) })
  // the executor reported that it pushed nothing
  const failed = plan({ prs: [reviewed(41, "pipeline/1-x", "h1", "reject", 0, { comments: [sent(50), m("rework", { sha: "h1", attempt: 1, failed: true, why: "cannot_fix" }, { at: ago(20) })] })] })
  assert.deepEqual([failed.dispatchRework, opened(failed)], [[], [["pr-release", "rework-failed", 41]]])
  assert.match(failed.openItems[0].actions[0].body, /Rework 1 pushed no new commit \(cannot_fix\); and still: the reviewer rejected it\./)
  // dispatched long ago (past the executor's time limit plus the grace), no run, no word: lost
  const lost = plan({ prs: [reviewed(41, "pipeline/1-x", "h1", "reject", 0, { comments: [sent(151)] })] })
  assert.deepEqual(opened(lost), [["pr-release", "rework-failed", 41]])
  assert.match(lost.openItems[0].actions[0].body, /Rework 1 was started 151 minutes ago and left no result/)
  assert.deepEqual(opened(plan({ prs: [reviewed(41, "pipeline/1-x", "h1", "reject", 0, { comments: [sent(149)] })] })), [])
  // the executor refused and says it will not change by itself
  const refused = plan({ prs: [reviewed(41, "pipeline/1-x", "h1", "reject", 0, { comments: [sent(50), m("skip", { why: "max_rework", permanent: true, sha: "h1" }, { at: ago(45) })] })] })
  assert.deepEqual(opened(refused), [["pr-release", "rework-failed", 41]])
  assert.match(refused.openItems[0].actions[0].body, /The executor refused to start \(max_rework\)/)
  // it refused for a reason that passes: sent again later, as the same attempt
  const passing = (minutes) => reviewed(41, "pipeline/1-x", "h1", "reject", 0, { comments: [sent(50), m("skip", { why: "claimed", permanent: false, sha: "h1" }, { at: ago(minutes) })] })
  assert.deepEqual(reworksOf(plan({ prs: [passing(10)] })), [])
  const again = plan({ prs: [passing(40)] })
  assert.deepEqual(reworksOf(again), [[41, 1]])
  // the second dispatch of the same head says so (in the mark too): two identical comments would look like a mistake
  assert.deepEqual([again.dispatchRework[0].send, again.dispatchRework[0].skipped], [2, "claimed"])
  const body = again.dispatchRework[0].actions[0].body
  assert.deepEqual(parseMark("rework", body), { sha: "h1", attempt: 1, why: "the reviewer rejected it", send: 2 })
  assert.match(body, /Sent back to the executor again \(rework 1 of at most 4, sent 2 times: the run before did not start, claimed\): the reviewer rejected it\./)
  // the agent could not be used for the rework (the executor's `unavailable` skip mark, with the reset time it was told)
  const away = (minutes, until) => reviewed(41, "pipeline/1-x", "h1", "reject", 0, { comments: [sent(400), m("skip", { why: "unavailable", permanent: false, sha: "h1", ...(until ? { until } : {}) }, { at: ago(minutes) })] })
  assert.deepEqual([reworksOf(plan({ prs: [away(350)] })), opened(plan({ prs: [away(350)] }))], [[[41, 1]], []], "sent again, not reported as lost")
  assert.deepEqual(reworksOf(plan({ prs: [away(350, new Date(now.getTime() + 60000).toISOString())] })), [])
})

test("a failed rework is obsolete once the same head was approved afterwards: a conflict that shows up later is reworked", () => {
  const failed = m("rework", { sha: "k1", attempt: 1, failed: true, why: "no change" }, { at: ago(120) })
  const conflict = { mergeable: false, mergeable_state: "dirty" }
  // approved after the failed rework (a re-review): obsolete, the conflict goes back as attempt 2... of a new count of heads
  const later = pr(41, "pipeline/1-x", "k1", { ...conflict, comments: [failed, review("k1", "approve", 0, {}, { at: ago(60) })], statuses: [status("success")] })
  const stale = itemIssue(900, prReleaseItem({ pr: later, cause: "rework-failed", issue: 1 }))
  const p = plan({ prs: [later], items: [stale] })
  assert.deepEqual(p.dispatchRework.map((r) => [r.pr, r.why]), [[41, "it conflicts with the base branch"]])
  // the item that asked about the failed rework is no longer what needs deciding
  assert.deepEqual(p.closeItems.map((x) => x.item), [900])
  assert.deepEqual(opened(p), [])
  // the approval is older than the failed rework (it is the same review as before): not obsolete, the owner is asked
  const earlier = pr(42, "pipeline/2-x", "k2", { ...conflict, comments: [review("k2", "approve", 0, {}, { at: ago(200) }), m("rework", { sha: "k2", attempt: 1, failed: true }, { at: ago(120) })], statuses: [status("success")] })
  const q = plan({ prs: [earlier] })
  assert.deepEqual([q.dispatchRework, opened(q)], [[], [["pr-release", "rework-failed", 42]]])
})

test("rework limit: at most max_rework heads are sent back since the last decision; beyond that a pr-release item, once", () => {
  const sentBack = (n, at = ago(300)) => Array.from({ length: n }, (_, k) => m("rework", { sha: `old${k}`, attempt: k + 1 }, { at }))
  const rejected = (number, n, o = {}) => reviewed(number, `pipeline/${number - 40}-x`, `h${number}`, "reject", 0, { comments: [...sentBack(n), ...(o.comments || [])] })
  const p = plan({ prs: [rejected(41, 3), rejected(42, 4)] }, cfg({ limits: { max_parallel: 9 } }))
  assert.deepEqual(reworksOf(p), [[41, 4]])
  assert.deepEqual(opened(p), [["pr-release", "rework-cap", 42]])
  const body = p.openItems[0].actions[0].body
  assert.match(body, /It was sent back 4 times \(the limit is 4\) and still: the reviewer rejected it\./)
  const meta = parseItem({ number: 900, body })
  assert.deepEqual([meta.pr, meta.issue, meta.sha, meta.due, meta.recommend], [42, 2, "h42", null, null])
  // asked already and still open: wait. It never defaults, however old it is.
  const open = plan({ prs: [rejected(42, 4)], items: [itemIssue(900, { title: "t", body }, { created_at: ago(60 * 24 * 9) })] })
  assert.deepEqual([opened(open), open.applyDefaults, open.closeItems, open.dispatchRework], [[], [], [], []])
  // closed without an answer, same head: not asked again
  const shut = plan({ prs: [rejected(42, 4)], items: [itemIssue(900, { title: "t", body }, { state: "closed" })] })
  assert.deepEqual([opened(shut), shut.dispatchRework], [[], []])
  assert.ok(noted(shut, /PR #42: already asked/))
  // the limit was raised: the open item is no longer needed, the rework goes on
  const raised = plan({ prs: [rejected(42, 4)], items: [itemIssue(900, { title: "t", body })] }, cfg({ limits: { max_rework: 6, issue_max_runs: 7 } }))
  assert.deepEqual([reworksOf(raised), raised.closeItems.map((x) => x.item)], [[[42, 5]], [900]])
  // a decision on the PR after those reworks: counting starts again
  const decided = plan({ prs: [rejected(42, 4, { comments: [c(decisionComment({ item: 900, key: "B", by: "ann", action: "rework", sha: "old3" }), { at: ago(200) })] })] })
  assert.deepEqual([reworksOf(decided), opened(decided)], [[[42, 1]], []])
  // ... and so does a decision on the issue
  const onIssue = plan({ issues: [issue(2, { comments: [c(decisionComment({ item: 901, key: "A", by: "ann", action: "retry" }), { at: ago(200) })] })], prs: [rejected(42, 4)] })
  assert.deepEqual(reworksOf(onIssue), [[42, 1]])
  // max_rework 0: never sent back automatically
  const zero = plan({ prs: [rejected(41, 0)] }, cfg({ limits: { max_rework: 0 } }))
  assert.deepEqual([zero.dispatchRework, opened(zero)], [[], [["pr-release", "rework-cap", 41]]])
})

test("rework: the executor's own allowance for the issue or row is checked first, counted from the latest decision on the PR or the issue", () => {
  const five = (issueNo, row = null) => [1, 2, 3, 4, 5].map((k) => entry(issueNo, 600 + k, { row }))
  const rej = (number, ref, o = {}) => reviewed(number, ref, `h${number}`, "reject", 0, o)
  const decided = (minutes) => c(decisionComment({ item: 900, key: "B", by: "ann", action: "rework", sha: "zzz" }), { at: ago(minutes) })
  const p = plan(
    {
      issues: [issue(3, { comments: [decided(300)] })],
      prs: [
        rej(41, "pipeline/1-x"), // five runs on #1: not dispatched, the owner is asked
        rej(42, "pipeline/2-x", { comments: [decided(300)] }), // decided on the PR after those runs
        rej(43, "pipeline/3-x"), // decided on the issue after those runs
        rej(44, "pipeline/4-r2-x"), // row 2 ran once; the five runs were row 1
      ],
      ledger: [...five(1), ...five(2), ...five(3), ...five(4, 1), entry(4, 500, { row: 2 })],
    },
    cfg({ limits: { max_parallel: 9 } }),
  )
  assert.deepEqual(reworksOf(p), [[42, 1], [43, 1], [44, 1]])
  assert.deepEqual(opened(p), [["pr-release", "rework-cap", 41]])
  assert.match(p.openItems[0].actions[0].body, /#1: the executor has already run 5 times \(limit 5\)/)
})

test("slots: reworks go before new work, and both respect max_parallel", () => {
  const p = plan({ issues: [issue(1), issue(2)], prs: [reviewed(48, "pipeline/8-x", "h", "reject", 0)] })
  assert.deepEqual([reworksOf(p), fixes(p)], [[[48, 1]], [[1, 0]]])
  const full = plan({ issues: [issue(1)], prs: [reviewed(48, "pipeline/8-x", "h", "reject", 0), reviewed(49, "pipeline/9-x", "h", "reject", 0)], runs: { fix: [run(7, "fix #77")], review: [] } })
  assert.deepEqual([reworksOf(full), fixes(full)], [[[48, 1]], []])
  assert.ok(noted(full, /the rework of PR #49 waits for a free slot/))
})

// ---------- approved PRs ----------

test("approved at or below auto_max_level with green checks: merged, with the head sha the review saw", () => {
  const p = plan({ prs: [reviewed(40, "pipeline/1-r2-x", "h", "approve", 1)] })
  assert.deepEqual(p.merge, [{ pr: 40, sha: "h", method: "squash", issue: 1, row: 2, level: 1, by: "review", actions: [{ do: "merge", pr: 40, sha: "h", method: "squash" }] }])
  assert.equal(plan({ prs: [reviewed(40, "pipeline/1-x", "h", "approve", 0)] }, cfg({ merge: { method: "rebase" } })).merge[0].method, "rebase")
  // a check still running, GitHub still computing mergeability: not yet
  const pending = plan({ prs: [reviewed(40, "pipeline/1-x", "h", "approve", 0, { checkRuns: [{ name: "unit", status: "in_progress", conclusion: null }] })] })
  assert.deepEqual(pending.merge, [])
  assert.ok(noted(pending, /PR #40 is approved but not merged yet: check "unit" has not finished/))
  assert.deepEqual(plan({ prs: [reviewed(40, "pipeline/1-x", "h", "approve", 0, { mergeable: null })] }).merge, [])
  // a pending status of some other system holds it too; the pipeline's own status does not count as a check
  assert.deepEqual(plan({ prs: [reviewed(40, "pipeline/1-x", "h", "approve", 0, { statuses: [{ context: "ci/deploy-preview", state: "pending" }] })] }).merge, [])
})

test("no checks at all on the head: merged only when the repository runs none (told, or quiet long enough after the review)", () => {
  const bare = (minutes) => pr(40, "pipeline/1-x", "h", { checkRuns: [], comments: [review("h", "approve", 0, {}, { at: ago(minutes) })], statuses: [status("success")] })
  // reviewed two minutes ago, nothing reported yet: the checks may simply not have started
  const fresh = plan({ prs: [bare(2)] })
  assert.deepEqual(fresh.merge, [])
  assert.ok(noted(fresh, /no checks have reported on the head commit yet/))
  // still nothing a quarter of an hour later: this repository runs no checks on PRs
  assert.deepEqual(plan({ prs: [bare(15)] }).merge.map((x) => x.pr), [40])
  // told so: no waiting; told the opposite: never without checks
  assert.deepEqual(plan({ prs: [bare(2)], repoHasChecks: false }).merge.map((x) => x.pr), [40])
  assert.deepEqual(plan({ prs: [bare(600)], repoHasChecks: true }).merge, [])
})

test("level 2: a pr-ask item, once; the recommended option applies after default_after_hours (never when that is 0)", () => {
  const extra = { ask: "Keep archived entries out of the export?", options: [{ what: "Leave them out", pros: "small", cons: "incomplete" }, { what: "Include them", pros: "complete", cons: "slow" }], recommend: 1 }
  const two = reviewed(40, "pipeline/1-x", "h", "approve", 2, { reviewExtra: extra })
  const p = plan({ prs: [two] })
  assert.deepEqual([opened(p), p.merge], [[["pr-ask", "level2", 40]], []])
  const body = p.openItems[0].actions[0].body
  const meta = parseItem({ number: 900, body })
  assert.deepEqual([meta.pr, meta.issue, meta.sha, meta.recommend, meta.due], [40, 1, "h", "A", "2026-11-17T04:00:00.000Z"])
  assert.match(body, /Keep archived entries out of the export\?/)
  // open: waits; not due yet
  const item = (o = {}, at = now, config = cfg()) => itemIssue(900, prAskItem({ pr: two, review: { level: 2, ...extra }, config, now: at, issue: 1 }), o)
  const waiting = plan({ prs: [two], items: [item()] })
  assert.deepEqual([opened(waiting), waiting.applyDefaults, waiting.merge], [[], [], []])
  assert.deepEqual(waiting.waiting, [{ item: 900, kind: "pr-ask", pr: 40, due: "2026-11-17T04:00:00.000Z" }])
  // 25 hours later nobody answered: A (merge as it is) applies, and the PR is merged in the same round
  const old = new Date(now.getTime() - 25 * 3600000)
  const due = plan({ prs: [two], items: [item({}, old)] })
  assert.deepEqual(due.applyDefaults.map((d) => [d.item, d.key, d.effect, d.pr]), [[900, "A", "merge", 40]])
  assert.deepEqual(does(due.applyDefaults[0]), ["status", "comment", "closeIssue", "comment"])
  assert.deepEqual(due.applyDefaults[0].actions[0], { do: "status", sha: "h", state: "success", context: "pipeline/review", description: "Released by default (#900)" })
  assert.deepEqual(findMarks("decision", [{ id: 1, body: due.applyDefaults[0].actions[1].body }])[0].payload, { item: 900, key: "A", by: null, how: "default", action: "merge", sha: "h" })
  assert.deepEqual(due.merge.map((x) => [x.pr, x.by, x.item]), [[40, "default", 900]])
  // record mode: listed, with a note, and nothing follows from it
  const rec = plan({ prs: [two], items: [item({}, old)] }, cfg({ mode: "record" }))
  assert.deepEqual([rec.applyDefaults.map((d) => d.item), rec.merge], [[900], []])
  assert.ok(noted(rec, /record mode: item #900 is past its time, option A would have been applied/))
  // default_after_hours 0 now: an old item with a due time is not applied either
  const never = plan({ prs: [two], items: [item({}, old)] }, cfg({ merge: { default_after_hours: 0 } }))
  assert.deepEqual([never.applyDefaults, never.merge], [[], []])
  // ... and a new item gets no due time
  assert.equal(parseItem({ number: 1, body: plan({ prs: [two] }, cfg({ merge: { default_after_hours: 0 } })).openItems[0].actions[0].body }).due, null)
  // the reviewer recommended the other way: the default is a rework with that instruction
  const other = reviewed(40, "pipeline/1-x", "h", "approve", 2, { reviewExtra: { ...extra, recommend: 2 } })
  const flip = plan({ prs: [other], items: [itemIssue(900, prAskItem({ pr: other, review: { level: 2, ...extra, recommend: 2 }, config: cfg(), now: old, issue: 1 }))] })
  assert.deepEqual(flip.applyDefaults.map((d) => [d.key, d.effect]), [["A", "rework"]])
  assert.deepEqual(flip.dispatchRework.map((r) => [r.pr, r.attempt, r.why, r.item]), [[40, 1, "an owner asked for a change: Include them", 900]])
  // an answered item is never defaulted on top
  const answered = plan({ prs: [two], items: [item({ comments: [answer("C")] }, old)] })
  assert.deepEqual([answered.applyDefaults, answered.applyAnswers.map((a) => a.key)], [[], ["C"]])
  // with auto_max_level 2 the reviewer sets success and the PR simply merges
  const auto = plan({ prs: [pr(40, "pipeline/1-x", "h", { comments: [review("h", "approve", 2)], statuses: [status("success")] })] }, cfg({ merge: { auto_max_level: 2 } }))
  assert.deepEqual([auto.merge.map((x) => x.pr), opened(auto)], [[40], []])
})

test("level 3, needs_human, a draft: a pr-release item, once, that never defaults", () => {
  const p = plan({
    prs: [
      reviewed(41, "pipeline/1-x", "h1", "approve", 3, { reviewExtra: { ask: "This changes how sessions are stored." } }),
      reviewed(42, "pipeline/2-x", "h2", "needs_human", 0, { reviewExtra: { ask: "Is the new wording what you want?" } }),
      reviewed(43, "pipeline/3-x", "h3", "approve", 0, { draft: true }),
      reviewed(44, "pipeline/4-x", "h4", "approve", 3, { draft: true }),
    ],
  })
  assert.deepEqual(opened(p), [["pr-release", "level3", 41], ["pr-release", "needs_human", 42], ["pr-release", "draft", 43], ["pr-release", "draft", 44]])
  assert.deepEqual(p.merge, [])
  assert.match(p.openItems[0].actions[0].body, /This changes how sessions are stored\./)
  for (const i of p.openItems) assert.equal(parseItem({ number: 1, body: i.actions[0].body }).due, null)
  // open for a month: still waiting, nothing applied
  const three = reviewed(41, "pipeline/1-x", "h1", "approve", 3)
  const old = plan({ prs: [three], items: [releaseItem(900, three, "level3", { created_at: ago(60 * 24 * 30) })] })
  assert.deepEqual([opened(old), old.applyDefaults, old.merge, old.waiting.map((w) => w.item)], [[], [], [], [900]])
})

// ---------- answers ----------

test("answers: only owners count; the newest answer wins; anything that is not a letter is not an answer", () => {
  const three = reviewed(41, "pipeline/1-x", "h1", "approve", 3)
  const withComments = (...comments) => ({ prs: [three], items: [releaseItem(900, three, "level3", { comments })] })
  // a stranger's "A" releases nothing
  const stranger = plan(withComments(answer("A", "mallory")))
  assert.deepEqual([stranger.applyAnswers, stranger.merge], [[], []])
  assert.ok(noted(stranger, /item #900: the answer by @mallory does not count/))
  assert.deepEqual(stranger.waiting.map((w) => w.item), [900])
  // owner's talk is not an answer
  assert.deepEqual(plan(withComments(answer("A good question, let me think"), answer("I think B"))).applyAnswers, [])
  // the owner changed their mind: the later comment counts; the login's case does not matter
  const changed = plan(withComments(answer("A", "ann", ago(20)), answer("c", "Ann", ago(5))))
  assert.deepEqual(changed.applyAnswers.map((a) => [a.item, a.key, a.by, a.effect]), [[900, "C", "Ann", "close"]])
  // the pipeline's own comments on the item are never answers
  assert.deepEqual(plan(withComments(c(`${mark("nudge", { comment: 1 })}\nA`, { by: "ann" }))).applyAnswers, [])
  // owners empty in the config: admins and maintainers gathered by the role
  const byMaintainer = planTick(state({ ...withComments(answer("A", "mia")), maintainers: ["Mia"] }), cfg({ owners: [] }), now)
  assert.deepEqual(byMaintainer.applyAnswers.map((a) => a.by), ["mia"])
  const nobody = planTick(state(withComments(answer("A", "mia"))), cfg({ owners: [] }), now)
  assert.deepEqual(nobody.applyAnswers, [])
  assert.ok(noted(nobody, /nobody can answer decision items/))
})

test("answer A on a pr-release item: status, (ready), decision mark, item closed, then the merge that follows", () => {
  const three = reviewed(41, "pipeline/1-x", "h1", "approve", 3, { draft: true })
  const p = plan({ prs: [three], items: [releaseItem(900, three, "draft", { comments: [answer("A")] })] })
  const [a] = p.applyAnswers
  assert.deepEqual([a.item, a.key, a.by, a.how, a.effect, a.pr], [900, "A", "ann", "answer", "merge", 41])
  assert.deepEqual(does(a), ["status", "ready", "comment", "closeIssue", "comment"])
  assert.deepEqual(a.actions[0], { do: "status", sha: "h1", state: "success", context: "pipeline/review", description: "Released by @ann (#900)" })
  assert.deepEqual(a.actions[1], { do: "ready", pr: 41, node: "NODE41" })
  assert.equal(a.actions[2].on, 41)
  assert.deepEqual(findMarks("decision", [{ id: 1, body: a.actions[2].body }])[0].payload, { item: 900, key: "A", by: "ann", how: "answer", action: "merge", sha: "h1" })
  assert.deepEqual([a.actions[3], a.actions[4].on], [{ do: "closeIssue", issue: 900, reason: "completed" }, 900])
  assert.deepEqual(p.merge.map((x) => [x.pr, x.sha, x.by, x.item]), [[41, "h1", "answer", 900]])
  assert.deepEqual([opened(p), p.closeItems, p.waiting], [[], [], []])
  // checks still running: released now, merged by a later round (the status is then success)
  const slow = { ...three, draft: false, checkRuns: [{ name: "unit", status: "queued", conclusion: null }] }
  const q = plan({ prs: [slow], items: [releaseItem(900, slow, "level3", { comments: [answer("a")] })] })
  assert.deepEqual([q.applyAnswers.map((x) => x.effect), q.merge], [["merge"], []])
  const later = plan({ prs: [{ ...slow, checkRuns: green, statuses: [status("success")], comments: [...slow.comments, c(q.applyAnswers[0].actions[1].body, { at: ago(5) })] }] })
  assert.deepEqual(later.merge.map((x) => [x.pr, x.by]), [[41, "review"]])
  // record mode: the answer is applied all the same; the merge is planned and left to the role to skip
  const rec = plan({ prs: [{ ...three, draft: false }], items: [releaseItem(900, three, "level3", { comments: [answer("A")] })] }, cfg({ mode: "record" }))
  assert.deepEqual([rec.applyAnswers.length, rec.merge.length], [1, 1])
})

test("answer B with text: decision mark with the owner's words, then a rework counted from zero; without text the owner is asked for a sentence, once", () => {
  const three = reviewed(41, "pipeline/1-r2-x", "h1", "approve", 3)
  const p = plan({ prs: [three], items: [releaseItem(900, three, "level3", { comments: [answer("B: store the token hashed, not plain")] })] })
  const [a] = p.applyAnswers
  assert.deepEqual([a.key, a.text, a.effect], ["B", "store the token hashed, not plain", "rework"])
  assert.deepEqual(does(a), ["comment", "closeIssue", "comment"])
  assert.match(a.actions[0].body, /\*\*Decided \(option B\):\*\* rework it\. store the token hashed, not plain/)
  assert.deepEqual(p.dispatchRework.map((r) => [r.pr, r.issue, r.row, r.attempt, r.why, r.item]), [[41, 1, 2, 1, "an owner asked for a change: store the token hashed, not plain", 900]])
  assert.deepEqual(does(p.dispatchRework[0]), ["comment", "dispatch"])
  // no slot this round: the decision is recorded now and the rework follows from the mark later
  const busy = plan({ prs: [three], items: [releaseItem(900, three, "level3", { comments: [answer("B: store the token hashed")] })], runs: { fix: [run(7, "fix #70"), run(8, "fix #71")], review: [] } })
  assert.deepEqual([busy.applyAnswers.length, busy.dispatchRework], [1, []])
  const recorded = { ...three, comments: [...three.comments, c(busy.applyAnswers[0].actions[0].body, { at: ago(3) })] }
  const next = plan({ prs: [recorded] })
  assert.deepEqual(next.dispatchRework.map((r) => [r.pr, r.attempt, r.why]), [[41, 1, "an owner asked for a change: store the token hashed"]])
  assert.deepEqual(opened(next), [])
  // ... and once that rework is marked, it is waited for: not sent again, and no new item about level 3
  const sent = { ...recorded, comments: [...recorded.comments, c(next.dispatchRework[0].actions[0].body, { at: ago(1) })] }
  nothingPlanned(plan({ prs: [sent] }))
  // it failed: the owner hears about it
  const failedAfter = plan({ prs: [{ ...sent, comments: [...sent.comments, m("rework", { sha: "h1", attempt: 1, failed: true, why: "checks_failed" }, { at: ago(0) })] }] })
  assert.deepEqual(opened(failedAfter), [["pr-release", "rework-failed", 41]])

  // B alone where a sentence is needed: nothing is applied, a nudge is posted
  const bare = answer("B")
  const nudge = plan({ prs: [three], items: [releaseItem(900, three, "level3", { comments: [bare] })] })
  assert.deepEqual([nudge.applyAnswers, nudge.dispatchRework], [[], []])
  assert.deepEqual(nudge.nudges.map((n) => [n.item, n.key, n.comment]), [[900, "B", bare.id]])
  assert.match(nudge.nudges[0].actions[0].body, /Option B needs a sentence/)
  // the nudge is on the item: not posted again, still waiting
  const nudged = plan({ prs: [three], items: [releaseItem(900, three, "level3", { comments: [bare, c(nudge.nudges[0].actions[0].body)] })] })
  assert.deepEqual([nudged.nudges, nudged.applyAnswers, nudged.waiting.map((w) => w.item)], [[], [], [900]])
  // on a stuck PR, B needs no sentence: the reviewer's feedback is there to follow
  const capped = reviewed(42, "pipeline/2-x", "h2", "reject", 0, { comments: [1, 2, 3, 4].map((k) => m("rework", { sha: `o${k}`, attempt: k }, { at: ago(300) })) })
  const again = plan({ prs: [capped], items: [releaseItem(901, capped, "rework-cap", { comments: [answer("b")] })] })
  assert.deepEqual(again.applyAnswers.map((x) => [x.key, x.effect]), [["B", "rework"]])
  assert.match(again.applyAnswers[0].actions[0].body, /Follow the reviewer's latest feedback/)
  assert.deepEqual(reworksOf(again), [[42, 1]])
})

test("answer C closes the PR; A on a stuck PR releases a rejected head; D runs the review again", () => {
  const three = reviewed(41, "pipeline/1-x", "h1", "approve", 3)
  const close = plan({ prs: [three], items: [releaseItem(900, three, "level3", { comments: [answer("C")] })] })
  assert.deepEqual(does(close.applyAnswers[0]), ["closePr", "comment", "closeIssue", "comment"])
  assert.deepEqual(close.applyAnswers[0].actions[0], { do: "closePr", pr: 41 })
  assert.deepEqual([close.merge, close.dispatchRework, close.dispatchReview, opened(close)], [[], [], [], []])
  // rejected four times; the owner lets it through as it is
  const capped = reviewed(42, "pipeline/2-x", "h2", "reject", 0, { comments: [1, 2, 3, 4].map((k) => m("rework", { sha: `o${k}`, attempt: k }, { at: ago(300) })) })
  const release = plan({ prs: [capped], items: [releaseItem(901, capped, "rework-cap", { comments: [answer("A")] })] })
  assert.deepEqual([release.applyAnswers.map((x) => x.effect), release.merge.map((x) => [x.pr, x.by]), release.dispatchRework], [["merge"], [[42, "answer"]], []])
  // next round the status is success: the old rejection no longer sends it back; a red check still would
  const released = { ...capped, statuses: [status("success", { updated_at: ago(1) })], comments: [...capped.comments, c(release.applyAnswers[0].actions[1].body, { at: ago(1) })] }
  assert.deepEqual(plan({ prs: [{ ...released, checkRuns: [{ name: "unit", status: "in_progress", conclusion: null }] }] }).dispatchRework, [])
  assert.deepEqual(reworksOf(plan({ prs: [{ ...released, checkRuns: [{ name: "unit", status: "completed", conclusion: "failure" }] }] })), [[42, 1]])
  // the review never ran; D starts it again with a fresh count
  const failed = pr(43, "pipeline/3-x", "h3", { comments: [1, 2, 3, 4].map((k) => m("review", { sha: "h3", failed: true, attempt: k }, { at: ago(100 - k) })), statuses: [status("pending")] })
  const retry = plan({ prs: [failed], items: [releaseItem(902, failed, "review-failed", { comments: [answer("D")] })] })
  assert.deepEqual([retry.applyAnswers.map((x) => x.effect), retry.dispatchReview.map((r) => [r.pr, r.attempt])], [["review"], [[43, 1]]])
  const after = plan({ prs: [{ ...failed, comments: [...failed.comments, c(retry.applyAnswers[0].actions[0].body, { at: ago(2) })] }] })
  assert.deepEqual([after.dispatchReview.map((r) => r.attempt), opened(after)], [[1], []])
  // A on the same item: merged without a review, because an owner said so
  const blind = plan({ prs: [failed], items: [releaseItem(902, failed, "review-failed", { comments: [answer("A")] })] })
  assert.deepEqual(blind.merge.map((x) => [x.pr, x.by]), [[43, "answer"]])
})

test("answers on a pr-ask item: the PR's own way merges, the other way is a rework with the reviewer's words plus the owner's", () => {
  const extra = { ask: "q", options: [{ what: "Leave them out", pros: "a", cons: "b" }, { what: "Include them", pros: "c", cons: "d" }], recommend: 1 }
  const two = reviewed(40, "pipeline/1-x", "h", "approve", 2, { reviewExtra: extra })
  const item = (...comments) => itemIssue(900, prAskItem({ pr: two, review: { level: 2, ...extra }, config: cfg(), now, issue: 1 }), { comments })
  const keep = plan({ prs: [two], items: [item(answer("A"))] })
  assert.deepEqual([keep.applyAnswers.map((a) => a.effect), keep.merge.map((x) => x.pr)], [["merge"], [40]])
  const change = plan({ prs: [two], items: [item(answer("B: only the last year"))] })
  assert.deepEqual(change.applyAnswers.map((a) => a.effect), ["rework"])
  assert.equal(change.dispatchRework[0].why, "an owner asked for a change: Include them only the last year")
  const drop = plan({ prs: [two], items: [item(answer("C"))] })
  assert.deepEqual(does(drop.applyAnswers[0])[0], "closePr")
})

test("stuck item: A lets the executor try again with fresh counts (and the owner's hint), B takes the work label off", () => {
  const five = [1, 2, 3, 4, 5].map((k) => entry(1, 600 + k))
  const built = stuckItem({ issue: issue(1), row: 0, cause: "budget", reason: "x" })
  const retry = plan({ issues: [issue(1)], ledger: five, items: [itemIssue(900, built, { comments: [answer("A: the fixture lives in test/data")] })] })
  const [a] = retry.applyAnswers
  assert.deepEqual([a.item, a.key, a.effect, a.issue], [900, "A", "retry", 1])
  assert.deepEqual(does(a), ["comment", "closeIssue", "comment"])
  assert.equal(a.actions[0].on, 1)
  assert.match(a.actions[0].body, /try again\. the fixture lives in test\/data/)
  assert.deepEqual(fixes(retry), [[1, 0]])
  // next round the decision is on the issue: the old runs no longer count
  const later = plan({ issues: [issue(1, { comments: [c(a.actions[0].body, { at: ago(2) })] })], ledger: five })
  assert.deepEqual([fixes(later), opened(later)], [[[1, 0]], []])
  const drop = plan({ issues: [issue(1)], ledger: five, items: [itemIssue(900, built, { comments: [answer("B")] })] })
  assert.deepEqual(does(drop.applyAnswers[0]), ["label", "comment", "closeIssue", "comment"])
  assert.deepEqual(drop.applyAnswers[0].actions[0], { do: "label", on: 1, remove: "pipeline" })
  assert.deepEqual([fixes(drop), opened(drop)], [[], []])
})

test("an answer is applied once: an item whose decision is already recorded is only closed", () => {
  const three = reviewed(41, "pipeline/1-x", "h1", "approve", 3)
  const first = plan({ prs: [three], items: [releaseItem(900, three, "level3", { comments: [answer("B: do x")] })] })
  // the decision comment was written, closing the item failed; next round:
  const half = { ...three, comments: [...three.comments, c(first.applyAnswers[0].actions[0].body, { at: ago(2) })] }
  const p = plan({ prs: [half], items: [releaseItem(900, three, "level3", { comments: [answer("B: do x")] })] })
  assert.deepEqual(p.applyAnswers, [])
  assert.deepEqual(p.closeItems.map((x) => [x.item, x.why]), [[900, "the answer was already applied"]])
  assert.deepEqual(does(p.closeItems[0]), ["closeIssue", "comment"])
  // the rework it asked for is still dispatched, from the mark
  assert.deepEqual(reworksOf(p), [[41, 1]])
})

// ---------- stale items ----------

test("stale items are closed: the PR was merged or closed, got a new head, or no longer needs the decision", () => {
  const three = reviewed(41, "pipeline/1-x", "h1", "approve", 3)
  const item = (number, thePr, cause, o) => releaseItem(number, thePr, cause, o)
  const p = plan({
    prs: [
      reviewed(41, "pipeline/1-x", "h1-new", "approve", 3), // pushed since the item was opened
      reviewed(44, "pipeline/4-x", "h4", "approve", 0), // re-reviewed at level 0: nothing to decide
      reviewed(45, "pipeline/5-x", "h5", "approve", 3),
    ],
    closedPrs: [closed(42, "pipeline/2-x", { merged_at: ago(5) }), closed(43, "pipeline/3-x")],
    items: [
      item(900, three, "level3", { comments: [answer("A")] }), // an answer on a stale item is not applied
      item(901, pr(42, "pipeline/2-x", "h2"), "level3"),
      item(902, pr(43, "pipeline/3-x", "h3"), "level3"),
      item(903, pr(44, "pipeline/4-x", "h4"), "level3"),
      item(904, pr(45, "pipeline/5-x", "h5"), "level3"),
      item(905, pr(45, "pipeline/5-x", "h5"), "level3"), // asks the same as 904
      item(906, pr(99, "pipeline/9-x", "h9"), "level3"), // the PR is nowhere
      itemIssue(907, stuckItem({ issue: issue(77), cause: "budget" })), // the issue is closed or unlabelled
    ],
  })
  const why = Object.fromEntries(p.closeItems.map((x) => [x.item, x.why]))
  // new commits, and the new review asks the same kind of thing: the item is rewritten, not replaced (below)
  assert.equal(why[900], undefined)
  assert.equal(why[901], "PR #42 was merged")
  assert.equal(why[902], "PR #43 was closed")
  assert.equal(why[903], "PR #44 no longer needs a decision")
  assert.equal(why[905], "#904 asks the same thing")
  assert.equal(why[906], "PR #99 is no longer open")
  assert.match(why[907], /#77 is closed or no longer carries the "pipeline" label/)
  assert.equal(why[904], undefined)
  assert.deepEqual(p.applyAnswers, [])
  assert.deepEqual(p.closeItems[0].actions[0].reason, "not_planned")
  assert.deepEqual(p.merge.map((x) => x.pr), [44])
  // the new head of #41: no second item, the open one now names the new commit, and the
  // answer given about the old commit is not applied, now or in a later round
  assert.deepEqual(opened(p), [])
  assert.deepEqual(p.refreshItems.map((x) => [x.item, x.pr, does(x)]), [[900, 41, ["editIssue", "comment"]]])
  const rewritten = parseItem({ number: 900, body: p.refreshItems[0].actions[0].body })
  assert.deepEqual([rewritten.sha, rewritten.asked], ["h1-new", now.toISOString()])
  assert.match(p.refreshItems[0].actions[1].body, /<!-- pipeline-refresh \{"sha":"h1-new"\} -->\nPR #41 has new commits \(now at `h1-new`\) and was reviewed again\./)
  const next = plan({
    prs: [reviewed(41, "pipeline/1-x", "h1-new", "approve", 3)],
    items: [itemIssue(900, { title: "t", body: p.refreshItems[0].actions[0].body }, { comments: [answer("A")] })],
  })
  assert.deepEqual([next.applyAnswers, next.refreshItems, next.closeItems, next.waiting.map((w) => w.item)], [[], [], [], [900]])
  // an answer written after the rewrite counts
  const later = planTick(state({ prs: [reviewed(41, "pipeline/1-x", "h1-new", "approve", 3)], items: [itemIssue(900, { title: "t", body: p.refreshItems[0].actions[0].body }, { comments: [answer("A", "ann", new Date(now.getTime() + 60000).toISOString())] })] }), cfg(), new Date(now.getTime() + 120000))
  assert.deepEqual(later.applyAnswers.map((x) => [x.item, x.key, x.effect]), [[900, "A", "merge"]])
  // the question changed (level 3 before, now the PR is stuck in rework): the old item goes, the new one comes
  const stuckNow = reviewed(46, "pipeline/6-x", "h6", "reject", 0, { comments: [1, 2, 3, 4].map((k) => m("rework", { sha: `o${k}`, attempt: k }, { at: ago(300) })) })
  const q = plan({ prs: [stuckNow], items: [item(908, stuckNow, "level3")] })
  assert.deepEqual([q.closeItems.map((x) => x.item), opened(q)], [[908], [["pr-release", "rework-cap", 46]]])
  // a stuck item about the budget, while the executor has since said it cannot do it: replaced as well
  const gaveUp = plan({ issues: [issue(1)], ledger: [entry(1, 300, { outcome: "cannot_fix" })], items: [itemIssue(910, stuckItem({ issue: issue(1), cause: "budget" }))] })
  assert.deepEqual([gaveUp.closeItems.map((x) => x.item), opened(gaveUp)], [[910], [["stuck", "gave-up", 1]]])
  // a stuck item whose issue now has a PR, or that is no longer over budget, is closed too
  const five = [1, 2, 3, 4, 5].map((k) => entry(1, 600 + k))
  const built = stuckItem({ issue: issue(1), cause: "budget" })
  const raised = plan({ issues: [issue(1)], ledger: five, items: [itemIssue(909, built)] }, cfg({ limits: { issue_max_runs: 9 } }))
  assert.deepEqual([raised.closeItems.map((x) => x.item), fixes(raised)], [[909], [[1, 0]]])
})

// ---------- the release label ----------

test("labels.approved put on by an owner after the review releases the PR like answer A", () => {
  const three = (o = {}) => pr(41, "pipeline/1-x", "h1", { labels: ["pipeline:approved"], comments: [review("h1", "approve", 3, {}, { at: ago(30) })], statuses: [status("pending")], draft: true, ...o })
  const p = plan({ prs: [three({ approved: { by: "ann", at: ago(5) } })], items: [releaseItem(900, three(), "draft")] })
  const [a] = p.applyAnswers
  assert.deepEqual([a.how, a.by, a.effect, a.pr, a.item, a.key], ["label", "ann", "merge", 41, 900, null])
  assert.deepEqual(does(a), ["status", "ready", "comment", "closeIssue", "comment"])
  assert.match(a.actions[2].body, /@ann put the "pipeline:approved" label on this pull request/)
  assert.deepEqual(p.merge.map((x) => [x.pr, x.by]), [[41, "label"]])
  assert.deepEqual(p.closeItems, [])
  // no item open: the same, without closing one
  const bare = plan({ prs: [three({ approved: { by: "ann", at: ago(5) }, draft: false })] })
  assert.deepEqual([does(bare.applyAnswers[0]), opened(bare), bare.merge.length], [["status", "comment"], [], 1])
  // released already (the status is success): not applied a second time
  const done = plan({ prs: [three({ approved: { by: "ann", at: ago(5) }, draft: false, statuses: [status("success")] })] })
  assert.deepEqual([done.applyAnswers, done.merge.length], [[], 1])
  // put on by someone who is not an owner, or by nobody the role could find: ignored, the item is asked as usual
  const stranger = plan({ prs: [three({ approved: { by: "mallory", at: ago(5) } })] })
  assert.deepEqual([stranger.applyAnswers, stranger.merge, opened(stranger)], [[], [], [["pr-release", "draft", 41]]])
  assert.ok(noted(stranger, /label was put on by @mallory, who is not an owner/))
  assert.deepEqual(plan({ prs: [three({ approved: null })] }).applyAnswers, [])
  // the label is older than the review of this head (left on from an earlier commit): does not release it
  const old = plan({ prs: [three({ approved: { by: "ann", at: ago(45) } })] })
  assert.deepEqual([old.applyAnswers, old.merge], [[], []])
  assert.ok(noted(old, /label does not release the current commit/))
  // a head nobody reviewed is not released by a label either
  assert.deepEqual(plan({ prs: [pr(41, "pipeline/1-x", "h1", { labels: ["pipeline:approved"], approved: { by: "ann", at: ago(5) } })] }).applyAnswers, [])
})

// ---------- across rounds ----------

test("a second round on the state the first one leaves behind plans nothing new", () => {
  const s = {
    issues: [issue(1), spec(2, { comments: [m("row-done", { row: 1, pr: 30 })] })],
    prs: [reviewed(41, "pipeline/5-x", "h1", "reject", 0), reviewed(42, "pipeline/6-x", "h2", "approve", 3), pr(43, "pipeline/7-x", "h3")],
    closedPrs: [closed(31, "pipeline/2-r2-second", { merged_at: ago(3) })],
  }
  const first = plan(s, cfg({ limits: { max_parallel: 9 } }))
  assert.deepEqual([fixes(first), reworksOf(first), first.dispatchReview.map((r) => r.pr), opened(first), first.markRows.length, first.closeIssues.length], [[[1, 0]], [[41, 1]], [43], [["pr-release", "level3", 42]], 1, 1])
  // what the first round left: a run for #1, the rework mark, a review run, the item, the row mark; #2 is closed
  const left = {
    issues: [issue(1)],
    prs: [{ ...s.prs[0], comments: [...s.prs[0].comments, c(first.dispatchRework[0].actions[0].body, { at: ago(0) })] }, s.prs[1], s.prs[2]],
    closedPrs: s.closedPrs,
    items: [itemIssue(900, { title: first.openItems[0].title, body: first.openItems[0].actions[0].body }, { created_at: ago(0) })],
    runs: { fix: [run(7, "fix #1", { created_at: ago(0) }), run(8, "pipeline-fix", { status: "queued", created_at: ago(0) })], review: [run(70, "review PR #43", { status: "queued", created_at: ago(0) })] },
  }
  const second = plan(left, cfg({ limits: { max_parallel: 9 } }))
  nothingPlanned(second)
  assert.deepEqual(second.waiting.map((w) => w.item), [900])
})

// ---------- the pipeline's own check runs ----------

test("a failed, cancelled or running check of the pipeline's own jobs on the head is not a failed check: no rework, and the merge goes ahead", () => {
  const own = (status, conclusion = null, name = "pipeline / pipeline-tick") => ({ name, status, conclusion })
  for (const o of [own("completed", "failure"), own("completed", "timed_out"), own("completed", "cancelled"), own("in_progress"), own("completed", "failure", "pipeline-tick"), own("completed", "startup_failure", "pipeline / pipeline-review")]) {
    const p = plan({ prs: [reviewed(41, "pipeline/1-x", "h1", "approve", 0, { checkRuns: [...green, o] })] })
    assert.deepEqual([p.dispatchRework, p.openItems, p.merge.map((x) => x.pr)], [[], [], [41]], JSON.stringify(o))
    // an unreviewed head is reviewed, not sent back
    const fresh = plan({ prs: [pr(42, "pipeline/2-x", "h2", { checkRuns: [...green, o] })] })
    assert.deepEqual([fresh.dispatchRework, fresh.dispatchReview.map((x) => x.pr)], [[], [42]], JSON.stringify(o))
    // next to a real failure the real one is named
    const both = plan({ prs: [reviewed(43, "pipeline/3-x", "h3", "approve", 0, { checkRuns: [o, { name: "unit", status: "completed", conclusion: "failure" }] })] })
    assert.equal(both.dispatchRework[0].why, 'check "unit" failed')
  }
  // nothing but the pipeline's own check has reported: the repository's CI has not started yet (or there is none)
  const alone = (minutes) => pr(40, "pipeline/1-x", "h", { checkRuns: [own("completed", "failure")], comments: [review("h", "approve", 0, {}, { at: ago(minutes) })], statuses: [status("success")] })
  assert.deepEqual(plan({ prs: [alone(2)] }).merge, [])
  assert.ok(noted(plan({ prs: [alone(2)] }), /no checks have reported/))
  assert.deepEqual(plan({ prs: [alone(11)] }).merge.map((x) => x.pr), [40])
  assert.deepEqual(plan({ prs: [alone(600)], repoHasChecks: true }).merge, [])
})

// ---------- a person's own pull request for a work issue ----------

test("a person's open PR that says it closes a work issue: the issue is theirs, nothing is dispatched or asked, one note says so", () => {
  const other = (number, o = {}) => ({ number, title: "My own fix", body: "", head: { ref: "ann/my-fix" }, ...o })
  for (const mine of [
    other(70, { body: "Some words.\n\nFixes #1" }),
    other(70, { body: "closes #1." }),
    other(70, { body: "This resolved #1, I think" }),
    other(70, { body: "Fixes: #1" }),
    other(70, { title: "Fix #1: the list" }),
    // a fork may name its branch like the pipeline's; it is still somebody's pull request for #1
    other(70, { head: { ref: "pipeline/1-from-a-fork" } }),
  ]) {
    const p = plan({ issues: [issue(1), issue(2)], otherPrs: [mine] })
    assert.deepEqual(fixes(p), [[2, 0]], JSON.stringify(mine))
    assert.deepEqual([p.openItems, p.closeIssues, p.markRows], [[], [], []])
    assert.deepEqual(p.notes.filter((n) => /#1\b/.test(n)), ["#1 is not dispatched: PR #70, which is not the pipeline's, says it closes this issue; the pipeline leaves the issue alone while that pull request is open"])
  }
  // it has to say so about this issue, in GitHub's own words
  for (const not of [other(70, { body: "Related to #1" }), other(70, { body: "Fixes #10" }), other(70, { body: "Fixes #11 and #1" }), other(70, { body: "prefixes #1" }), other(70, { head: { ref: "pipeline/10-x" } }), other(70)]) {
    assert.deepEqual(fixes(plan({ issues: [issue(1)], otherPrs: [not] })), [[1, 0]], JSON.stringify(not))
  }
  // a spec issue is held back as a whole; the same state every round plans the same nothing
  const s = plan({ issues: [spec(3)], otherPrs: [other(71, { body: "Closes #3" })] })
  assert.deepEqual([fixes(s), s.notes.filter((n) => /PR #71/.test(n)).length], [[], 1])
  // an issue that is over its budget is not asked about while the person's pull request is open
  const spent = { issues: [issue(1)], ledger: [1, 2, 3, 4, 5].map((k) => entry(1, k * 10)) }
  assert.deepEqual(opened(plan(spent)), [["stuck", "budget", 1]])
  assert.deepEqual(opened(plan({ ...spent, otherPrs: [other(70, { body: "Fixes #1" })] })), [])
  // the pipeline's own pull request is not "somebody else's", whatever list it turns up in
  const own = reviewed(41, "pipeline/1-x", "h1", "approve", 0)
  const p = plan({ issues: [issue(1)], prs: [own], otherPrs: [{ number: 41, title: own.title, body: "Fixes #1", head: { ref: "pipeline/1-x" } }] })
  assert.ok(noted(p, /#1 is in progress: PR #41/) && !noted(p, /not the pipeline's/))
  assert.deepEqual(p.merge.map((x) => x.pr), [41])
  // no otherPrs in the state at all (an older caller): as before
  assert.deepEqual(fixes(planTick({ ...state({ issues: [issue(1)] }), otherPrs: undefined }, cfg(), now)), [[1, 0]])
})

test("a skip comment the executor renewed in place holds the run back from the time it was last written", () => {
  const skipped = (created, updated) => ({ ...m("skip", { why: "open_pr", permanent: false, run: "9", row: 0, other: 70 }, { at: ago(created) }), updated_at: ago(updated) })
  // written 3 hours ago and never touched: the wait is long over
  assert.deepEqual(fixes(plan({ issues: [issue(1, { comments: [skipped(180, 180)] })] })), [[1, 0]])
  // renewed 10 minutes ago: wait
  const p = plan({ issues: [issue(1, { comments: [skipped(180, 10)] })] })
  assert.deepEqual(fixes(p), [])
  assert.ok(noted(p, /#1: the executor did not start \(open_pr\); it is dispatched again later/))
  assert.deepEqual(fixes(plan({ issues: [issue(1, { comments: [skipped(180, 31)] })] })), [[1, 0]])
})

// ---------- one item per question, however many commits ----------

test("a level-2 question survives a rework: held while the PR is on its way to a new commit, rewritten when the new commit asks the same, closed when it does not", () => {
  const two = reviewed(41, "pipeline/1-x", "h1", "approve", 2)
  const item = askItem(900, two, { created_at: ago(30) })
  // the PR starts to conflict with the base while the question is open: it goes back to the
  // executor, and the item stays (before, it was closed here and a new one opened afterwards)
  const conflicting = { ...two, mergeable: false, mergeable_state: "dirty" }
  const p = plan({ prs: [conflicting], items: [item] })
  assert.deepEqual([reworksOf(p), p.closeItems, opened(p), p.refreshItems], [[[41, 1]], [], [], []])
  assert.deepEqual(p.waiting, [{ item: 900, kind: "pr-ask", pr: 41, due: null, hold: true }])
  // ... and neither an answer nor the default is applied to a commit that is being replaced
  const answered = plan({ prs: [conflicting], items: [{ ...item, comments: [answer("A")] }] })
  assert.deepEqual([answered.applyAnswers, answered.merge, reworksOf(answered)], [[], [], [[41, 1]]])
  assert.ok(noted(answered, /item #900: PR #41 is being reworked or reviewed again; the answer is not applied to the old commit/))
  const overdue = plan({ prs: [conflicting], items: [askItem(900, two, {}, cfg(), new Date(now.getTime() - 48 * 3600000))] })
  assert.deepEqual([overdue.applyDefaults, overdue.merge], [[], []])

  // the rework pushed a new commit that has not been reviewed yet: still held, the review is dispatched
  const pushed = pr(41, "pipeline/1-x", "h2", { comments: two.comments })
  const waiting = plan({ prs: [pushed], items: [{ ...item, comments: [answer("A")] }] })
  assert.deepEqual([waiting.dispatchReview.map((r) => r.pr), waiting.closeItems, waiting.applyAnswers, waiting.waiting.map((w) => [w.item, w.hold])], [[41], [], [], [[900, true]]])

  // reviewed again at level 2: the same item, rewritten for the new commit, its clock started again
  const again = reviewed(41, "pipeline/1-x", "h2", "approve", 2, { reviewExtra: { ask: "Round the total up or down?", options: [{ what: "Up" }, { what: "Down" }], recommend: 1 } })
  const r = plan({ prs: [again], items: [{ ...item, comments: [answer("A")] }] })
  assert.deepEqual([opened(r), r.closeItems, r.applyAnswers], [[], [], []])
  assert.deepEqual(r.refreshItems.map((x) => [x.item, x.kind, x.cause, x.pr]), [[900, "pr-ask", "level2", 41]])
  const [edit, said] = r.refreshItems[0].actions
  assert.deepEqual([edit.do, edit.issue, said.do, said.on], ["editIssue", 900, "comment", 900])
  assert.match(edit.body, /Round the total up or down\?/)
  const meta = parseItem({ number: 900, body: edit.body })
  assert.deepEqual([meta.sha, meta.asked, meta.due], ["h2", now.toISOString(), new Date(now.getTime() + 24 * 3600000).toISOString()])
  assert.match(said.body, /An answer given before this comment was about the old commits and does not count\. Without an answer, the recommended option applies /)

  // reviewed again at level 0: nothing to ask any more, the item is closed and the PR merges
  const fine = plan({ prs: [reviewed(41, "pipeline/1-x", "h2", "approve", 0)], items: [item] })
  assert.deepEqual([fine.closeItems.map((x) => [x.item, x.why]), fine.merge.map((x) => x.pr), fine.refreshItems], [[[900, "PR #41 no longer needs a decision"]], [41], []])
  // reviewed again at level 3: another kind of question, so the old item goes and a new one comes
  const three = plan({ prs: [reviewed(41, "pipeline/1-x", "h2", "approve", 3)], items: [item] })
  assert.deepEqual([three.closeItems.map((x) => x.item), opened(three), three.refreshItems], [[900], [["pr-release", "level3", 41]], []])
  // the same commit comes back to the same question (a failed check was run again and passed): the held answer counts
  const back = plan({ prs: [two], items: [{ ...item, comments: [answer("A")] }] })
  assert.deepEqual(back.applyAnswers.map((x) => [x.item, x.key]), [[900, "A"]])
})

test("work that waits for the daily budget says so where an owner looks, once a day", () => {
  const spent = [entry(9, 30, { usd: 30, outcome: "pr" })]
  const config = cfg({ limits: { daily_usd: 30 } })
  const rejected = reviewed(41, "pipeline/1-x", "h1", "reject", 0)
  const unreviewed = pr(42, "pipeline/2-x", "h2")
  const p = plan({ issues: [issue(1), issue(2), issue(3)], prs: [rejected, unreviewed], ledger: spent }, config)
  assert.deepEqual([p.dispatchFix, p.dispatchRework, p.dispatchReview], [[], [], []])
  // issues 1 and 2 have a PR going; issue 3 and both PRs are what is held back
  assert.deepEqual(p.notices.map((x) => x.on), [41, 42, 3])
  const day = now.toISOString().slice(0, 10)
  const body = p.notices[2].actions[0].body
  assert.ok(body.startsWith(`<!-- pipeline-budget-wait {"day":"${day}"} -->\nWaiting for the daily budget: $30.00 spent today (UTC ${day}), the daily limit is $30.00.`), body)
  assert.match(body, /starts by itself after midnight UTC.*raise `limits\.daily_usd`/)
  // said already today: not again; said yesterday: again
  const told = (d) => m("budget-wait", { day: d })
  const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10)
  const q = plan({ issues: [issue(3, { comments: [told(day)] }), issue(4, { comments: [told(yesterday)] })], prs: [{ ...unreviewed, comments: [told(day)] }], ledger: spent }, config)
  assert.deepEqual(q.notices.map((x) => x.on), [4])
  // under the limit, or nothing waiting: nothing is said
  assert.deepEqual(plan({ issues: [issue(3)], ledger: [entry(9, 30, { usd: 5 })] }, config).notices, [])
  assert.deepEqual(plan({ ledger: spent }, config).notices, [])
  // a mark typed by someone else does not silence it
  const forged = plan({ issues: [issue(3, { comments: [c(mark("budget-wait", { day }), { by: "mallory" })] })], ledger: spent }, config)
  assert.deepEqual(forged.notices.map((x) => x.on), [3])
})
