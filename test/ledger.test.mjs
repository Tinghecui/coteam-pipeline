import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULTS } from "../cli/core/config.mjs"
import { budget, claudeCooldown, countedRuns, NOT_AN_ATTEMPT, parseLedger, unavailableReason, UNAVAILABLE_COOLDOWN_MS } from "../cli/core/ledger.mjs"

const now = new Date("2026-11-15T12:00:00Z")
const limits = { ...DEFAULTS.limits, daily_usd: 15, issue_max_runs: 5, issue_max_usd: 20 }

test("ledger: broken lines and non-objects are skipped", () => {
  const e = parseLedger('{"usd":1}\nnot json\n\n[1]\n"x"\nnull\n{"usd":2}\n')
  assert.deepEqual(e, [{ usd: 1 }, { usd: 2 }])
  assert.deepEqual(parseLedger(""), [])
  assert.deepEqual(parseLedger(null), [])
})

test("budget: the daily limit counts every role, only today (UTC)", () => {
  const entries = [
    { at: "2026-11-14T23:59:00Z", role: "executor", issue: 1, usd: 100 },
    { at: "2026-11-15T01:00:00Z", role: "executor", issue: 1, usd: 6 },
    { at: "2026-11-15T02:00:00Z", role: "reviewer", issue: 2, usd: 4 },
    { at: "not a time", role: "reviewer", usd: 50 },
    { at: "2026-11-15T02:30:00Z", role: "reviewer", usd: "n/a" },
  ]
  const ok = budget(entries, { issue: 3, limits, now })
  assert.deepEqual([ok.ok, ok.reason, ok.today, ok.day, ok.capped], [true, "", 10, "2026-11-15", false])
  const full = budget([...entries, { at: "2026-11-15T03:00:00Z", role: "executor", issue: 2, usd: 5 }], { issue: 3, limits, now })
  assert.equal(full.ok, false)
  assert.equal(full.reason, "$15.00 spent today (UTC 2026-11-15), the daily limit is $15.00")
  // a daily stop is not "this issue used up its allowance": it just waits for tomorrow
  assert.equal(full.capped, false)
  // an entry written with another offset still lands on its UTC day
  assert.equal(budget([{ at: "2026-11-15T01:00:00+03:00", role: "executor", issue: 1, usd: 99 }], { issue: 3, limits, now }).today, 0)
  // the limit comes from the config, not from a constant
  assert.equal(budget(entries, { issue: 3, limits: { ...limits, daily_usd: 10 }, now }).ok, false)
})

test("budget: per issue, runs (first run + reworks) or dollars, executor only", () => {
  const e = (usd, role = "executor") => ({ at: "2026-11-01T00:00:00Z", role, issue: 7, usd })
  assert.equal(budget([e(1), e(1), e(1), e(1)], { issue: 7, limits, now }).ok, true)
  const runs = budget([e(1), e(1), e(1), e(1), e(1)], { issue: 7, limits, now })
  assert.equal(runs.reason, "#7: the executor has already run 5 times (limit 5), spending $5.00")
  assert.deepEqual([runs.ok, runs.capped], [false, true])
  const spent = budget([e(12), e(8.5)], { issue: 7, limits, now })
  assert.equal(spent.reason, "#7: the executor has already spent $20.50 (limit $20.00) over 2 runs")
  assert.equal(spent.capped, true)
  assert.equal(budget([e(6, "reviewer"), e(6, "reviewer"), e(6, "reviewer")], { issue: 7, limits: { ...limits, daily_usd: 100 }, now }).ok, true)
  // other issues do not count; the issue number may arrive as a string
  assert.equal(budget([e(1), e(1), e(1), { ...e(1), issue: 8 }], { issue: "7", limits, now }).issueRuns, 3)
  // limits come from the config
  assert.equal(budget([e(1), e(1)], { issue: 7, limits: { ...limits, issue_max_runs: 2 }, now }).capped, true)
  assert.equal(budget([e(3)], { issue: 7, limits: { ...limits, issue_max_usd: 3 }, now }).capped, true)
  // the default limits leave room for the first run plus every rework
  assert.ok(DEFAULTS.limits.issue_max_runs >= DEFAULTS.limits.max_rework + 1)
})

test("budget: runs where the agent was unavailable are not charged to the issue", () => {
  const e = (usd, o = {}) => ({ at: "2026-11-01T00:00:00Z", role: "executor", issue: 7, usd, ...o })
  const un = e(4, { outcome: "unavailable" })
  const b = budget([e(1), e(1), un, un, un], { issue: 7, limits, now })
  assert.deepEqual([b.issueRuns, b.issueUsd, b.ok], [2, 2, true])
  // whatever they did cost still counts towards the day
  assert.equal(budget([{ ...un, at: "2026-11-15T01:00:00Z" }], { issue: 7, limits, now }).today, 4)
})

test("budget: each row of a spec issue has its own allowance; entries without a row are row 0", () => {
  const e = (row) => ({ at: "2026-11-01T00:00:00Z", role: "executor", issue: 9, usd: 1, ...(row === undefined ? {} : { row }) })
  const entries = [e(1), e(1), e(1), e(1), e(1), e(2), e()]
  const r1 = budget(entries, { issue: 9, row: 1, limits, now })
  assert.equal(r1.reason, "#9 row 1: the executor has already run 5 times (limit 5), spending $5.00")
  assert.equal(budget(entries, { issue: 9, row: 2, limits, now }).issueRuns, 1)
  assert.equal(budget(entries, { issue: 9, row: 0, limits, now }).issueRuns, 1)
  assert.equal(budget(entries, { issue: 9, limits, now }).issueRuns, 7)
})

test("budget: counts start again after a human decision", () => {
  const e = (at) => ({ at, role: "executor", issue: 7, usd: 4 })
  const entries = [e("2026-11-14T01:00:00Z"), e("2026-11-14T02:00:00Z"), e("2026-11-14T03:00:00Z"), e("2026-11-14T04:00:00Z"), e("2026-11-14T05:00:00Z"), e("2026-11-15T09:00:00Z")]
  const big = { ...limits, daily_usd: 100 }
  assert.equal(budget(entries, { issue: 7, limits: big, now }).capped, true)
  const after = budget(entries, { issue: 7, limits: big, now, since: "2026-11-15T08:00:00Z" })
  assert.deepEqual([after.issueRuns, after.issueUsd, after.ok], [1, 4, true])
  // a run recorded at the very moment of the decision belongs to the time before it
  assert.equal(budget(entries, { issue: 7, limits: big, now, since: "2026-11-15T09:00:00Z" }).issueRuns, 0)
  // the day's spend is real money and does not start again
  assert.equal(after.today, 4)
})

// Shapes of real CLI output for 401 / 529 / 429 answers.
const res = (result, o = {}) => ({ type: "result", subtype: "success", is_error: true, result, ...o })

test("unavailable: out of quota, overloaded, logged out, never started", () => {
  const why = (msgs, o) => unavailableReason(msgs, o)?.reason ?? null
  assert.equal(why([res("Failed to authenticate. API Error: 401 Invalid API key")]), "auth")
  assert.equal(why([res("API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary. Try again in a moment.")]), "overloaded")
  assert.equal(why([res("API Error: Request rejected (429) · You've hit your limit")]), "quota")
  assert.deepEqual(unavailableReason([res("Claude AI usage limit reached|1792494000")]), {
    reason: "quota",
    detail: "Claude AI usage limit reached|1792494000",
    resetsAt: new Date(1792494000 * 1000).toISOString(),
  })
  assert.equal(why([{ type: "result", subtype: "error_during_execution", is_error: true, errors: ["OAuth token has expired. Please run /login"] }]), "auth")
  // a refused rate_limit_event: resetsAt (seconds) ends the cooldown; no result message needed
  const r = unavailableReason([{ type: "system" }, { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1792494000 } }])
  assert.deepEqual([r.reason, r.resetsAt], ["quota", new Date(1792494000 * 1000).toISOString()])
  // no message at all: it never started; stderr may say why
  assert.equal(why([], { rc: 1 }), "not_started")
  assert.equal(why(null, { rc: 1 }), "not_started")
  assert.equal(why([], { rc: 1, stderr: "Invalid API key · Please run /login" }), "auth")
  assert.equal(why([{ type: "system", subtype: "init" }], { rc: 1, stderr: "API Error: 529 overloaded_error" }), "overloaded")
  assert.equal(unavailableReason([res("x ".repeat(400) + "usage limit")]).detail.length, 300)
})

test("unavailable: ordinary failures, time limits and successful runs are not outages", () => {
  const why = (msgs, o) => unavailableReason(msgs, o)?.reason ?? null
  // allowed again later, or only a warning (close to the limit, still working)
  assert.equal(why([{ type: "rate_limit_event", rate_limit_info: { status: "rejected" } }, { type: "rate_limit_event", rate_limit_info: { status: "allowed" } }, res("Tests failed")]), null)
  assert.equal(why([{ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning" } }, res("Tests failed")]), null)
  // stopped by the time limit: it ran too long
  assert.equal(why([], { rc: 124 }), null)
  assert.equal(why([], { rc: 137, stderr: "usage limit" }), null)
  for (const msgs of [
    [res("Tests failed: expected 1, got 2")],
    [res("Test case 529 failed")],
    [{ type: "result", subtype: "error_max_turns", is_error: true }],
    // the error text was something the agent read, not something the CLI reported
    [{ type: "assistant", message: { content: "API Error: 529 overloaded" } }, res("Tests failed")],
    [{ type: "rate_limit_event", rate_limit_info: { status: "rejected" } }, { type: "result", subtype: "success", is_error: false, result: "Fixed overloaded_error handling" }],
    [{ type: "system" }, { type: "assistant" }],
  ])
    assert.equal(why(msgs, { rc: 1 }), null, JSON.stringify(msgs))
  // with a result message, stderr is not consulted
  assert.equal(why([res("Tests failed")], { rc: 1, stderr: "rate limit" }), null)
})

test("cooldown: 30 minutes after the latest unavailable run, or until its reset time; one real run clears it", () => {
  const at = (m) => new Date(Date.parse("2026-11-16T04:00:00Z") + m * 60000).toISOString().replace(/\.000Z$/, "Z")
  const t0 = new Date(at(0))
  const un = (m, o = {}) => ({ at: at(m), role: "executor", issue: 5, turns: 0, usd: 0, outcome: "unavailable", unavailable: "quota", ...o })
  assert.equal(UNAVAILABLE_COOLDOWN_MS, 30 * 60000)
  assert.equal(claudeCooldown([], t0), null)
  assert.equal(claudeCooldown(null, t0), null)
  assert.equal(claudeCooldown([{ at: at(-5), role: "executor", issue: 5, turns: 30, outcome: "fail" }], t0), null)
  assert.deepEqual(claudeCooldown([un(-10)], t0), { until: at(20), since: at(-10), at: at(-10), reason: "quota", role: "executor", cooling: true })
  assert.equal(claudeCooldown([un(-10, { resets_at: at(120) })], t0).until, at(120))
  // a reset time already in the past: 30 minutes; absurdly far (more than 8 days): cut to 8 days
  assert.equal(claudeCooldown([un(-10, { resets_at: at(-60) })], t0).until, at(20))
  assert.equal(claudeCooldown([un(-10, { resets_at: at(60 * 24 * 30) })], t0).until, at(-10 + 60 * 24 * 8))
  // time is up but nothing has worked since: not cooling, the tick sends one probe
  assert.equal(claudeCooldown([un(-40)], t0).cooling, false)
  // a later run that really ran (it has turns, whatever its outcome) clears it
  assert.equal(claudeCooldown([un(-10), { at: at(-5), role: "reviewer", pr: 1, turns: 12, usd: 1, outcome: "approve" }], t0), null)
  // an earlier success does not; neither do entries by other roles or runs without turns
  assert.equal(claudeCooldown([{ at: at(-20), role: "reviewer", turns: 12, outcome: "approve" }, un(-10)], t0).cooling, true)
  assert.equal(claudeCooldown([un(-10), { at: at(-5), role: "tick", turns: 3, outcome: "asked" }], t0).cooling, true)
  assert.equal(claudeCooldown([un(-10), { at: at(-5), role: "executor", turns: 0, outcome: "fail" }], t0).cooling, true)
  // several in a row: the latest end wins, the reason is the most recent one, `since` the first
  const two = claudeCooldown([un(-25, { resets_at: at(60) }), un(-10, { role: "reviewer", unavailable: "overloaded" })], t0)
  assert.deepEqual([two.until, two.reason, two.since, two.role], [at(60), "overloaded", at(-25), "reviewer"])
  assert.equal(claudeCooldown([un(-10, { unavailable: undefined })], t0).reason, "unavailable")
})

test("budget: a run that refused to start (skipped, dry) never counts against the issue, should a ledger line for it ever be written", () => {
  assert.deepEqual(NOT_AN_ATTEMPT, ["unavailable", "skipped", "dry"])
  const run = (minute, outcome, o = {}) => ({ at: `2026-11-15T10:${String(minute).padStart(2, "0")}:00Z`, role: "executor", issue: 5, row: null, outcome, usd: 0, turns: 0, ...o })
  // five refusals and one real run: one attempt, not six
  const entries = [run(1, "skipped"), run(2, "skipped"), run(3, "dry"), run(4, "failed", { usd: 2, turns: 30 }), run(5, "skipped"), run(6, "skipped"), run(7, "unavailable")]
  const b = budget(entries, { issue: 5, limits, now })
  assert.deepEqual([b.ok, b.capped, b.issueRuns, b.issueUsd, b.today], [true, false, 1, 2, 2])
  assert.deepEqual(countedRuns(entries, { issue: 5 }).map((e) => e.outcome), ["failed"])
  // nor does it end a cooldown: nothing ran
  const cool = claudeCooldown([run(0, "unavailable", { unavailable: "quota", at: "2026-11-15T11:50:00Z" }), run(0, "skipped", { at: "2026-11-15T11:55:00Z" })], now)
  assert.equal(cool.cooling, true)
  // money it somehow cost still counts for the day, like an unavailable run's
  assert.equal(budget([run(1, "skipped", { usd: 20 })], { issue: 5, limits, now }).ok, false)
  assert.equal(budget([run(1, "skipped", { usd: 20 })], { issue: 5, limits, now }).capped, false)
})

test("countedRuns: the one count the tick and the executor share (issue, row, since the latest decision, executor only)", () => {
  const e = (minute, o = {}) => ({ at: `2026-11-15T10:${String(minute).padStart(2, "0")}:00Z`, role: "executor", issue: 5, row: null, outcome: "failed", ...o })
  const entries = [e(1), e(2, { row: 2 }), e(3, { issue: 6 }), e(4, { role: "reviewer" }), e(5, { outcome: "cannot_fix" }), e(6, { row: 0 })]
  assert.deepEqual(countedRuns(entries, { issue: 5 }).map((x) => x.at.slice(14, 16)), ["01", "02", "05", "06"])
  assert.deepEqual(countedRuns(entries, { issue: 5, row: 0 }).map((x) => x.at.slice(14, 16)), ["01", "05", "06"])
  assert.deepEqual(countedRuns(entries, { issue: 5, row: 2 }).map((x) => x.at.slice(14, 16)), ["02"])
  // a run recorded in the very second of the decision came before it
  assert.deepEqual(countedRuns(entries, { issue: 5, since: "2026-11-15T10:05:00Z" }).map((x) => x.at.slice(14, 16)), ["06"])
  assert.deepEqual(countedRuns(null, { issue: 5 }), [])
})
