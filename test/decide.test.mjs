import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULTS } from "../cli/core/config.mjs"
import { ciRuns, isOwnCheck, mergeable, OWN_CHECK, REVIEW_RETRIES, reviewDecision, TEXT, validateReview } from "../cli/core/decide.mjs"

const cfg = (merge = {}, top = {}) => ({ ...DEFAULTS, mode: "on", ...top, merge: { method: "squash", auto_max_level: 1, default_after_hours: 24, ...merge } })
const out = (o = {}) => ({ verdict: "approve", level: 0, problems: [], followups: [], summary: "fine", ...o })
const decide = (o, pathLevel = 0, config = cfg()) => reviewDecision({ config, out: out(o), pathLevel })
const core = (d) => [d.state, d.level, d.waits]

test("approve at or below auto_max_level: success", () => {
  const zero = decide({})
  assert.deepEqual(core(zero), ["success", 0, null])
  assert.equal(zero.description, "Approved, level 0")
  assert.deepEqual([zero.verdict, zero.failed, zero.pathLevel, zero.reviewerLevel], ["approve", false, 0, 0])
  const one = decide({ level: 1 })
  assert.deepEqual(core(one), ["success", 1, null])
  assert.equal(one.description, "Approved, level 1")
})

test("reject: failure whatever the level, never waits for anyone", () => {
  const rej = decide({ verdict: "reject", problems: [{ kind: "logic", where: "a.js:2", what: "y" }] })
  assert.deepEqual(core(rej), ["failure", 0, null])
  assert.equal(rej.description, "Rejected: 1 problem, see the review comment")
  const three = decide({ verdict: "reject", level: 3, problems: [{ kind: "logic", what: "a" }, { kind: "security", what: "b" }] })
  assert.deepEqual(core(three), ["failure", 3, null])
  assert.match(three.description, /2 problems/)
})

test("approve at level 2: pending behind a decision item that defaults", () => {
  const two = decide({ level: 2 })
  assert.deepEqual(core(two), ["pending", 2, null])
  assert.equal(two.description, "Approved, level 2: decision item opened, the recommended option applies after 24 h")
  // 0 hours = wait forever, which is waiting for an owner
  const forever = decide({ level: 2 }, 0, cfg({ default_after_hours: 0 }))
  assert.deepEqual(core(forever), ["pending", 2, "owner"])
  // the automatic range is configurable: 2 merges on its own, or nothing does
  assert.deepEqual(core(decide({ level: 2 }, 0, cfg({ auto_max_level: 2 }))), ["success", 2, null])
  assert.deepEqual(core(decide({ level: 0 }, 0, cfg({ auto_max_level: 0 }))), ["success", 0, null])
  assert.deepEqual(core(decide({ level: 1 }, 0, cfg({ auto_max_level: 0 }))), ["pending", 1, null])
})

test("level 3 or needs_human: pending, waits for an owner, never defaults", () => {
  const three = decide({ level: 3 })
  assert.deepEqual(core(three), ["pending", 3, "owner"])
  assert.match(three.description, /level 3: waiting for an owner \(label "pipeline:approved" releases it\)/)
  // even when everything below it is automatic
  assert.deepEqual(core(decide({ level: 3 }, 0, cfg({ auto_max_level: 2 }))), ["pending", 3, "owner"])
  const nh = decide({ verdict: "needs_human" })
  assert.deepEqual(core(nh), ["pending", 0, "owner"])
  assert.equal(nh.description, TEXT.needsHuman)
  // an unknown verdict is "could not decide", never an approval
  const odd = decide({ verdict: "lgtm" })
  assert.deepEqual([odd.verdict, ...core(odd)], ["needs_human", "pending", 0, "owner"])
})

test("final level = max(path level, reviewer level); out-of-range levels are clamped, missing ones fail closed", () => {
  // paths say 3, the reviewer says 0: the reviewer cannot lower it
  const d = decide({ level: 0 }, 3)
  assert.deepEqual([d.level, d.pathLevel, d.reviewerLevel, d.state, d.waits], [3, 3, 0, "pending", "owner"])
  assert.equal(decide({ level: 2 }, 1).level, 2)
  assert.equal(decide({ level: 1 }, 2).level, 2)
  assert.equal(decide({ level: 9 }).level, 3)
  assert.equal(decide({ level: -4 }).level, 0)
  assert.equal(decide({ level: "1" }).level, 1)
  for (const level of [undefined, null, "", "high", NaN]) assert.deepEqual(core(decide({ level })), ["pending", 3, "owner"], String(level))
  // a path level that was never computed is 3, not 0
  for (const pathLevel of [null, undefined, "0", 4, -1, 1.5]) assert.deepEqual(core(reviewDecision({ config: cfg(), out: out(), pathLevel })), ["pending", 3, "owner"], String(pathLevel))
})

test("approve with blocking problems listed is a reject (the reviewer forgot to flip the verdict)", () => {
  const d = decide({ verdict: "approve", problems: [{ kind: "tests_missing", where: "src/a.js", what: "behaviour changed, no test" }] })
  assert.deepEqual([d.verdict, ...core(d)], ["reject", "failure", 0, null])
  assert.equal(d.problems.length, 1)
  // followups never block
  assert.equal(decide({ followups: [{ kind: "style", what: "rename" }] }).state, "success")
  // junk in problems is ignored
  assert.equal(decide({ problems: [null, "x"] }).state, "success")
  assert.equal(decide({ problems: "none" }).state, "success")
})

test("the reviewer did not run: pending with the reason, and an unknown path level is level 3", () => {
  const d = reviewDecision({ config: cfg(), out: null, pathLevel: 0, failure: "timed out after 20 min" })
  assert.deepEqual(core(d), ["pending", 0, null])
  assert.equal(d.description, "Review did not run: timed out after 20 min")
  assert.deepEqual([d.failed, d.verdict, d.reviewerLevel], [true, null, null])
  // level 0 by path is no reason to pass without a review
  assert.notEqual(d.state, "success")
  // the path level could not be computed either (budget stop, fetch failed): 3, never 0
  for (const pathLevel of [null, undefined, "0"]) assert.equal(reviewDecision({ config: cfg(), out: null, pathLevel, failure: "x" }).level, 3)
  // a failure reason wins over whatever output there is; no output at all is a failure too
  assert.equal(reviewDecision({ config: cfg(), out: out(), pathLevel: 0, failure: "invalid output" }).failed, true)
  const none = reviewDecision({ config: cfg(), out: undefined, pathLevel: 1 })
  assert.deepEqual([none.state, none.level, none.description], ["pending", 1, "Review did not run: no output"])
  assert.equal(reviewDecision({ config: cfg(), out: "approve", pathLevel: 0 }).failed, true)
  assert.equal(REVIEW_RETRIES, 3)
})

test("descriptions fit a commit status (140 characters, one line)", () => {
  const d = reviewDecision({ config: cfg(), out: null, pathLevel: 0, failure: `line one\n${"x".repeat(300)}` })
  assert.equal(d.description.length, 140)
  assert.ok(!d.description.includes("\n"))
})

test("the state does not depend on the mode; mode is enforced in mergeable", () => {
  for (const mode of ["off", "record", "on"]) {
    assert.equal(decide({}, 0, cfg({}, { mode })).state, "success")
    assert.equal(decide({ verdict: "reject", problems: [{ kind: "logic", what: "x" }] }, 0, cfg({}, { mode })).state, "failure")
  }
})

const pr = (o = {}) => ({ number: 5, state: "open", draft: false, head: { sha: "h1" }, mergeable: true, mergeable_state: "clean", ...o })
const review = (o = {}) => ({ sha: "h1", state: "success", ...o })
const green = { runs: [{ name: "test", status: "completed", conclusion: "success" }], statuses: [] }
const can = (o = {}) => mergeable({ config: cfg(), pr: pr(), review: review(), checks: green, ...o })

test("mergeable: reviewed head, success, green checks, no conflict, mode on", () => {
  assert.deepEqual(can(), { ok: true, why: "" })
})

test("mergeable: mode, draft, closed", () => {
  assert.deepEqual(can({ config: cfg({}, { mode: "record" }) }), { ok: false, why: 'mode is "record": nothing is merged unless mode is "on"' })
  assert.equal(can({ config: cfg({}, { mode: "off" }) }).ok, false)
  assert.deepEqual(can({ pr: pr({ draft: true }) }), { ok: false, why: TEXT.why.draft })
  assert.deepEqual(can({ pr: pr({ state: "closed" }) }), { ok: false, why: TEXT.why.closed })
})

test("mergeable: the head must be the reviewed one and the review a success, or released by a decision", () => {
  assert.equal(can({ review: null }).why, TEXT.why.notReviewed)
  assert.equal(can({ review: review({ sha: "" }) }).why, TEXT.why.notReviewed)
  assert.equal(can({ pr: pr({ head: { sha: "h2" } }) }).why, TEXT.why.stale)
  assert.equal(can({ review: review({ state: "pending" }) }).why, 'the review status is "pending"')
  assert.equal(can({ review: review({ state: "failure" }) }).why, 'the review status is "failure"')
  assert.equal(can({ review: review({ state: undefined }) }).why, 'the review status is "missing"')
  // a human decision releases a pending or rejected review of this head ...
  assert.equal(can({ review: review({ state: "pending", released: true }) }).ok, true)
  assert.equal(can({ review: review({ state: "failure", released: true }) }).ok, true)
  // ... but not another head, not red checks, and only a real `true`
  assert.equal(can({ pr: pr({ head: { sha: "h2" } }), review: review({ state: "pending", released: true }) }).why, TEXT.why.stale)
  assert.equal(can({ review: review({ state: "pending", released: true }), checks: { runs: [{ name: "test", status: "completed", conclusion: "failure" }] } }).ok, false)
  assert.equal(can({ review: review({ state: "pending", released: "no" }) }).ok, false)
})

test("mergeable: conflicts, and mergeability GitHub has not computed yet", () => {
  assert.equal(can({ pr: pr({ mergeable: false }) }).why, TEXT.why.conflict)
  assert.equal(can({ pr: pr({ mergeable: null, mergeable_state: "dirty" }) }).why, TEXT.why.conflict)
  assert.equal(can({ pr: pr({ mergeable: null, mergeable_state: "unknown" }) }).why, TEXT.why.unknownMergeable)
  assert.equal(can({ pr: pr({ mergeable: undefined }) }).why, TEXT.why.unknownMergeable)
})

test("mergeable: every check run and status other than our own must be completed and successful", () => {
  const run = (name, status, conclusion = null) => ({ name, status, conclusion })
  const withChecks = (runs, statuses = []) => can({ checks: { runs, statuses } })
  assert.equal(withChecks([run("test", "in_progress")]).why, 'check "test" has not finished')
  assert.equal(withChecks([run("test", "queued")]).ok, false)
  assert.equal(withChecks([run("lint", "completed", "success"), run("test", "completed", "failure")]).why, 'check "test" is failure')
  for (const bad of ["cancelled", "timed_out", "action_required", "stale", null]) assert.equal(withChecks([run("test", "completed", bad)]).ok, false, String(bad))
  // skipped and neutral runs are not failures
  assert.equal(withChecks([run("a", "completed", "skipped"), run("b", "completed", "neutral"), run("c", "completed", "success")]).ok, true)
  // commit statuses
  assert.equal(withChecks([], [{ context: "ci/build", state: "success" }]).ok, true)
  assert.equal(withChecks([], [{ context: "ci/build", state: "pending" }]).why, 'check "ci/build" has not finished')
  assert.equal(withChecks([], [{ context: "ci/build", state: "failure" }]).why, 'check "ci/build" is failure')
  assert.equal(withChecks([run("test", "completed", "success")], [{ context: "ci/build", state: "error" }]).ok, false)
  // our own status is the review itself: it is judged by review.state, not here
  assert.equal(withChecks([run("test", "completed", "success")], [{ context: "pipeline/review", state: "pending" }]).ok, true)
  assert.equal(can({ config: cfg({}, { status_context: "bot/check" }), checks: { runs: [], statuses: [{ context: "pipeline/review", state: "pending" }] } }).ok, false)
  // several statuses for one context: the newest counts (by time, else the first, as the API lists newest first)
  const older = { context: "ci/build", state: "failure", updated_at: "2026-11-15T01:00:00Z" }
  const newer = { context: "ci/build", state: "success", updated_at: "2026-11-15T02:00:00Z" }
  assert.equal(withChecks([], [older, newer]).ok, true)
  assert.equal(withChecks([], [newer, older]).ok, true)
  assert.equal(withChecks([], [{ context: "ci/build", state: "success" }, { context: "ci/build", state: "failure" }]).ok, true)
  assert.equal(withChecks([], [{ context: "ci/build", state: "failure" }, { context: "ci/build", state: "success" }]).ok, false)
})

test("mergeable: no checks at all is green only when the repo is known to have none", () => {
  assert.equal(can({ checks: { runs: [], statuses: [] } }).why, TEXT.why.noChecks)
  assert.equal(can({ checks: undefined }).why, TEXT.why.noChecks)
  // only our own status has reported: the repo's checks have not started yet
  assert.equal(can({ checks: { runs: [], statuses: [{ context: "pipeline/review", state: "success" }], repoHasChecks: true } }).why, TEXT.why.noChecks)
  assert.deepEqual(can({ checks: { runs: [], statuses: [], repoHasChecks: false } }), { ok: true, why: "" })
  assert.equal(can({ checks: { runs: [], statuses: [{ context: "pipeline/review", state: "success" }], repoHasChecks: false } }).ok, true)
  // a repo said to have no checks still has to be green if one shows up
  assert.equal(can({ checks: { runs: [{ name: "test", status: "completed", conclusion: "failure" }], repoHasChecks: false } }).ok, false)
})

test("the pipeline's own jobs are not CI: a dispatcher round that failed, was cancelled or is still going neither blocks a merge nor counts as a check", () => {
  // the job name alone, and as GitHub shows the job of a called workflow: "<caller job> / <job>"
  for (const name of ["pipeline-tick", "pipeline / pipeline-tick", "pipeline / pipeline-fix", "anything / pipeline-review"]) assert.ok(isOwnCheck(name), name)
  for (const name of ["test", "build / test", "my-pipeline-tick", "pipeline-tick / test", "pipeline-ticks", "pipeline-tick (push)", "", null, undefined]) assert.ok(!isOwnCheck(name), String(name))
  assert.ok(OWN_CHECK instanceof RegExp)
  const run = (name, status, conclusion = null) => ({ name, status, conclusion })
  const ci = run("test", "completed", "success")
  assert.deepEqual(ciRuns([ci, run("pipeline / pipeline-tick", "completed", "failure"), run("pipeline/review", "completed", "failure"), null], "pipeline/review"), [ci])
  assert.deepEqual(ciRuns(undefined), [])
  for (const own of [run("pipeline / pipeline-tick", "completed", "failure"), run("pipeline / pipeline-tick", "completed", "cancelled"), run("pipeline / pipeline-tick", "in_progress"), run("pipeline-tick", "queued"), run("pipeline / pipeline-review", "completed", "timed_out")]) {
    assert.deepEqual(can({ checks: { runs: [ci, own], statuses: [] } }), { ok: true, why: "" }, JSON.stringify(own))
    // the repository's own failure is still a failure next to it
    assert.equal(can({ checks: { runs: [run("test", "completed", "failure"), own], statuses: [] } }).why, 'check "test" is failure')
    // on its own it is "no checks have reported", not "green"
    assert.equal(can({ checks: { runs: [own], statuses: [] } }).why, TEXT.why.noChecks)
    assert.equal(can({ checks: { runs: [own], statuses: [], repoHasChecks: false } }).ok, true)
  }
})

// ---------- validateReview ----------

const options = [
  { what: "keep the old default", pros: "nothing changes for users", cons: "new users see the old screen" },
  { what: "switch the default", pros: "simpler", cons: "existing users are surprised" },
]
const two = (o = {}) => out({ level: 2, ask: "Which default should new users get?", options, recommend: 1, ...o })

test("validateReview: a complete level-2 approval and everything that asks nobody pass unchanged", () => {
  const good = two()
  assert.deepEqual(validateReview(good), { out: good, downgraded: null })
  assert.equal(validateReview(good).out, good)
  assert.equal(validateReview(two({ recommend: 2 })).downgraded, null)
  // levels that merge on their own need no question; level 3 is released by an owner, not answered
  for (const level of [0, 1, 3]) assert.equal(validateReview(out({ level })).downgraded, null, `level ${level}`)
  // rejections and needs_human are not approvals
  assert.equal(validateReview(out({ verdict: "reject", level: 2, problems: [{ kind: "logic", where: "a:1", what: "x" }] })).downgraded, null)
  assert.equal(validateReview(out({ verdict: "needs_human", level: 2 })).downgraded, null)
  // an approval that lists problems is rejected by reviewDecision: nothing to ask
  assert.equal(validateReview(out({ level: 2, problems: [{ kind: "logic", where: "a:1", what: "x" }] })).downgraded, null)
  // no output at all is the failure path of reviewDecision
  for (const bad of [null, undefined, "approve", []]) assert.deepEqual(validateReview(bad), { out: bad, downgraded: null })
})

test("validateReview: a level-2 approval without ask, two options or a valid recommend becomes needs_human, with the reason", () => {
  const bare = out({ level: 2 })
  const v = validateReview(bare)
  assert.equal(v.out.verdict, "needs_human")
  assert.equal(v.downgraded, "the reviewer approved at level 2, where an owner has to choose, but did not write the question to answer, did not give at least two options")
  // the input is not modified
  assert.equal(bare.verdict, "approve")
  assert.match(validateReview(two({ ask: "  " })).downgraded, /question to answer$/)
  assert.match(validateReview(two({ options: [options[0]] })).downgraded, /at least two options$/)
  assert.match(validateReview(two({ options: [options[0], { what: "", pros: "a", cons: "b" }] })).downgraded, /at least two options$/)
  assert.match(validateReview(two({ options: "both" })).downgraded, /at least two options$/)
  for (const recommend of [undefined, null, 0, 3, -1, 1.5, "1"]) {
    const r = validateReview(two({ recommend }))
    assert.match(r.downgraded, /did not recommend one of its options$/, String(recommend))
    assert.equal(r.out.verdict, "needs_human")
  }
  // the downgraded output waits for an owner and never defaults
  const d = reviewDecision({ config: cfg(), out: v.out, pathLevel: 0 })
  assert.deepEqual(core(d), ["pending", 2, "owner"])
})

test("validateReview: the level that counts is the higher of path and reviewer, against auto_max_level", () => {
  // level 2 by path, the reviewer saw nothing to ask: there is no question that could default
  const byPath = validateReview(out({ level: 0 }), { pathLevel: 2, config: cfg() })
  assert.equal(byPath.out.verdict, "needs_human")
  assert.match(byPath.downgraded, /^the reviewer approved at level 2/)
  assert.equal(validateReview(two({ level: 0 }), { pathLevel: 2, config: cfg() }).downgraded, null)
  // an unknown path level is level 3: an owner releases it, nothing to validate
  assert.equal(validateReview(out({ level: 2 }), { pathLevel: null, config: cfg() }).downgraded, null)
  // auto_max_level 2: level 2 merges on its own; auto_max_level 0: level 1 needs the question too
  assert.equal(validateReview(out({ level: 2 }), { pathLevel: 0, config: cfg({ auto_max_level: 2 }) }).downgraded, null)
  assert.match(validateReview(out({ level: 1 }), { pathLevel: 0, config: cfg({ auto_max_level: 0 }) }).downgraded, /^the reviewer approved at level 1/)
  // a level the reviewer left out is level 3
  assert.equal(validateReview(out({ level: undefined })).downgraded, null)
})
