import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { DEFAULTS } from "../cli/core/config.mjs"
import { prReleaseItem } from "../cli/core/items.mjs"
import { mark, parseMark } from "../cli/core/marks.mjs"
import { ORDER, execute, gather, run } from "../cli/roles/tick.mjs"

// ---------- a fake GitHub ----------

const now = new Date("2026-11-16T04:00:00Z")
const ago = (minutes) => new Date(now.getTime() - minutes * 60000).toISOString()
const REPO = "acme/app"
const cfg = (over = {}) => ({ ...DEFAULTS, mode: "on", owners: ["ann"], ...over, merge: { method: "squash", auto_max_level: 1, default_after_hours: 24, ...(over.merge || {}) } })
let nextId = 5000
const comment = (body, by = "bot", at = ago(60)) => ({ id: nextId++, body, created_at: at, updated_at: at, user: { login: by } })
const label = (name) => ({ name })
const issue = (number, o = {}) => ({ number, title: `Task ${number}`, body: "Do the thing.", state: "open", labels: [label("pipeline")], created_at: ago(5000), user: { login: "ann" }, ...o })
const pull = (number, ref, sha, o = {}) => ({
  number,
  title: `PR ${number}`,
  body: "",
  state: "open",
  draft: false,
  node_id: `NODE${number}`,
  labels: [],
  head: { ref, sha, repo: { full_name: REPO } },
  base: { ref: "main", repo: { full_name: REPO } },
  mergeable: true,
  mergeable_state: "clean",
  updated_at: ago(10),
  ...o,
})
const review = (sha, verdict, level) => comment(`${mark("review", { sha, verdict, level, by: "reviewer" })}\nreview text`, "bot", ago(30))
const green = { check_runs: [{ name: "test", status: "completed", conclusion: "success" }] }
const ownStatus = (state) => ({ statuses: [{ context: "pipeline/review", state, created_at: ago(30), updated_at: ago(30) }] })

// world: what the repository looks like. Every write is recorded in `calls`; `fail(call)`
// returning true makes that call throw.
function fakeIo(world, { config = cfg(), fail = () => false, env = {}, botLogin = "bot" } = {}) {
  const calls = []
  const reads = []
  const w = { issues: [], prs: [], closedPrs: [], items: [], closedItems: [], comments: {}, status: {}, checks: {}, events: {}, runs: {}, collaborators: [], ledger: [], ...world }
  const read = (path) => {
    reads.push(path)
    let m
    if (world.failRead?.(path)) throw new Error(`GET ${path}: 502`)
    if (path.startsWith("issues?state=open&labels=pipeline%3Adecide")) return w.items
    if (path.startsWith("issues?state=closed&labels=pipeline%3Adecide")) return w.closedItems
    if (path.startsWith("issues?state=open&labels=pipeline&")) return w.issues
    if ((m = /^issues\/(\d+)\/comments/.exec(path))) return w.comments[m[1]] || []
    if ((m = /^issues\/(\d+)\/events/.exec(path))) return w.events[m[1]] || []
    if ((m = /^issues\/(\d+)$/.exec(path))) return [...w.issues, ...(w.others || [])].find((i) => i.number === Number(m[1])) || { number: Number(m[1]), state: "open" }
    if (path.startsWith("pulls?state=open")) return w.prs
    if (path.startsWith("pulls?state=closed")) return /page=1$/.test(path) ? w.closedPrs : []
    if ((m = /^pulls\/(\d+)$/.exec(path))) return w.prs.find((p) => p.number === Number(m[1]))
    if ((m = /^commits\/(\w+)\/status/.exec(path))) return w.status[m[1]] || { statuses: [] }
    if ((m = /^commits\/(\w+)\/check-runs/.exec(path))) return w.checks[m[1]] || green
    if ((m = /^actions\/workflows\/([\w.-]+)\/runs/.exec(path))) return { workflow_runs: w.runs[m[1]] || [] }
    if ((m = /^actions\/runs\/(\d+)\/jobs/.exec(path))) return { total_count: w.jobs?.[m[1]] ?? 0 }
    if (path.startsWith("collaborators")) return w.collaborators
    if (path === "/user") return { login: "bot" }
    if (path === `/repos/${REPO}`) return { owner: { login: "acme", type: "Organization" } }
    throw new Error(`fake gh: no route for GET ${path}`)
  }
  const write = (method) => (path, body) => {
    const call = { method, path, ...(body === undefined ? {} : { body }) }
    calls.push(call)
    if (fail(call)) throw new Error(`${method} ${path}: 422 Unprocessable\nmore detail`)
    return method === "POST" && path === "issues" ? { number: 990 + calls.length } : {}
  }
  const gh = {
    repo: REPO,
    get: read,
    list: read,
    post: write("POST"),
    patch: write("PATCH"),
    put: write("PUT"),
    del: write("DELETE"),
    graphql: (query, variables) => write("GRAPHQL")("graphql", { query, variables }),
    dispatch: (workflow, ref, inputs) => write("DISPATCH")(workflow, { ref, inputs }),
  }
  const lines = []
  return { io: { env, now: () => now, log: (l) => lines.push(l), gh, ledger: { read: () => w.ledger }, config, botLogin }, calls, reads, lines }
}
const short = (calls) => calls.map((c) => `${c.method} ${c.path}`)

// One of everything: an issue to start, a PR to merge, one to send back, one to review, one
// that needs an owner, a finished task, an answered item, and a fork's PR that is none of ours.
function world() {
  const level3 = pull(44, "pipeline/7-auth", "h44")
  const built = prReleaseItem({ pr: level3, cause: "level3", issue: 7 })
  return {
    issues: [issue(1), issue(6), issue(2), issue(3), issue(4), issue(5), issue(7)],
    prs: [
      pull(40, "pipeline/2-ok", "h40"),
      pull(41, "pipeline/3-bad", "h41"),
      pull(42, "pipeline/4-new", "h42"),
      pull(43, "pipeline/5-risky", "h43"),
      level3,
      pull(45, "pipeline/9-fork", "h45", { head: { ref: "pipeline/9-fork", sha: "h45", repo: { full_name: "mallory/app" } } }),
      pull(46, "feature/unrelated", "h46"),
    ],
    closedPrs: [{ ...pull(30, "pipeline/6-done", "h30"), state: "closed", merged_at: ago(5), closed_at: ago(5), updated_at: ago(5) }],
    items: [{ number: 900, title: built.title, body: built.body, state: "open", created_at: ago(120), user: { login: "bot" }, labels: [label("pipeline:decide")] }],
    comments: {
      40: [review("h40", "approve", 0)],
      41: [review("h41", "reject", 0)],
      43: [review("h43", "approve", 3)],
      44: [review("h44", "approve", 3)],
      900: [comment("A", "ann", ago(10))],
    },
    status: { h40: ownStatus("success"), h41: ownStatus("failure"), h43: ownStatus("pending"), h44: ownStatus("pending") },
  }
}

// ---------- one round ----------

test("one round, end to end: reads the state, carries the plan out in a safe order, reports what it did", async () => {
  const { io, calls, lines } = fakeIo(world())
  const res = await run({ dry: false }, io)
  assert.equal(res.ok, true, JSON.stringify(res.failures))
  assert.deepEqual(res.failures, [])
  assert.deepEqual(res.counts, { markRows: 1, applyAnswers: 1, applyDefaults: 0, merge: 2, closeItems: 0, labels: 0, closeIssues: 1, openItems: 1, nudges: 0, dispatchReview: 1, dispatchRework: 1, dispatchFix: 1 })
  assert.deepEqual(short(calls), [
    // bookkeeping first: the merged PR is recorded on its issue
    "POST issues/6/comments",
    // the owner's answer: status, decision mark on the PR, item closed, receipt last
    "POST statuses/h44",
    "POST issues/44/comments",
    "PATCH issues/900",
    "POST issues/900/comments",
    // merges: the one the review allows and the one the owner released
    "PUT pulls/40/merge",
    "PUT pulls/44/merge",
    // the finished task: closed, then told
    "PATCH issues/6",
    "POST issues/6/comments",
    // a new decision item (the label is made sure of first)
    "POST labels",
    "POST issues",
    // dispatches last: review, rework (mark before dispatch), new work
    "DISPATCH pipeline-review.yml",
    "POST issues/41/comments",
    "DISPATCH pipeline-fix.yml",
    "DISPATCH pipeline-fix.yml",
  ])
  const by = (path, method = "POST") => calls.filter((c) => c.path === path && c.method === method)
  assert.deepEqual(parseMark("row-done", by("issues/6/comments")[0].body.body), { row: 0, pr: 30 })
  assert.deepEqual(by("statuses/h44")[0].body, { state: "success", context: "pipeline/review", description: "Released by @ann (#900)" })
  assert.equal(parseMark("decision", by("issues/44/comments")[0].body.body).action, "merge")
  assert.deepEqual(by("issues/900", "PATCH")[0].body, { state: "closed", state_reason: "completed" })
  assert.deepEqual(by("pulls/40/merge", "PUT")[0].body, { merge_method: "squash", sha: "h40" })
  assert.deepEqual(by("issues/6", "PATCH")[0].body, { state: "closed", state_reason: "completed" })
  const opened = by("issues")[0].body
  assert.deepEqual(opened.labels, ["pipeline:decide"])
  assert.match(opened.title, /^\[decide\] PR #43 waits for an owner/)
  assert.deepEqual(by("pipeline-review.yml", "DISPATCH")[0].body, { ref: "main", inputs: { pr: "42" } })
  assert.deepEqual(parseMark("rework", by("issues/41/comments")[0].body.body), { sha: "h41", attempt: 1, why: "the reviewer rejected it" })
  assert.deepEqual(by("pipeline-fix.yml", "DISPATCH").map((c) => c.body.inputs), [{ issue: "3", row: "", pr: "41" }, { issue: "1", row: "", pr: "" }])
  // the fork's PR and the unrelated branch were never touched or even looked at closely
  assert.ok(!calls.some((c) => /\/(45|46)\b/.test(c.path)))
  assert.equal(res.done.length, 9)
  assert.match(lines.join("\n"), /tick: 7 work issues, 5 open pipeline PRs, 1 open decision item, 0 executor runs going/)
  assert.match(lines.join("\n"), /tick \(on\): fix 1, rework 1, review 1, merge 2, new items 1, answers 1/)
  assert.match(lines.join("\n"), /done: merge PR #40 \(review\)/)
  assert.match(lines.at(-1), /tick: 9 done, 0 failed/)
})

test("a failing action does not stop the others; the rest of its own entry is skipped; the role returns ok = false and lists it", async () => {
  // the rework mark on PR 41 cannot be written, and the task issue cannot be marked
  const fail = (c) => c.path === "issues/41/comments" || (c.path === "issues/6/comments" && /row-done/.test(c.body.body))
  const { io, calls, lines } = fakeIo(world(), { fail })
  const res = await run({}, io)
  assert.equal(res.ok, false)
  assert.deepEqual(res.failures.map((f) => [f.list, f.step, f.error]), [
    ["markRows", "comment", "POST issues/6/comments: 422 Unprocessable"],
    ["dispatchRework", "comment", "POST issues/41/comments: 422 Unprocessable"],
  ])
  // the mark failed, so the rework was not dispatched (a dispatch without its mark would repeat every round) ...
  assert.deepEqual(calls.filter((c) => c.method === "DISPATCH").map((c) => [c.path, c.body.inputs.issue || c.body.inputs.pr]), [["pipeline-review.yml", "42"], ["pipeline-fix.yml", "1"]])
  // ... and the issue whose row mark failed was not closed
  assert.ok(!calls.some((c) => c.method === "PATCH" && c.path === "issues/6"))
  assert.deepEqual(res.skipped.map((s) => [s.list, s.why]), [["closeIssues", "its row marks could not be written"]])
  // everything else went through
  assert.ok(calls.some((c) => c.path === "pulls/40/merge"))
  assert.ok(calls.some((c) => c.path === "pulls/44/merge"))
  assert.ok(calls.some((c) => c.path === "issues" && c.method === "POST"))
  assert.match(lines.join("\n"), /FAILED: dispatch rework 1 of PR #41: the reviewer rejected it: POST issues\/41\/comments: 422 Unprocessable/)
  assert.match(lines.at(-1), /tick: 6 done, 2 failed/)
})

test("an answer that could not be recorded: what follows from it does not run; a failed label call posts no comment after it", async () => {
  // the status cannot be set: the release is not recorded, so PR 44 is not merged and nothing is commented
  const { io, calls } = fakeIo(world(), { fail: (c) => c.path === "statuses/h44" })
  const res = await run({}, io)
  assert.equal(res.ok, false)
  assert.deepEqual(res.failures.map((f) => [f.list, f.step]), [["applyAnswers", "status"]])
  assert.ok(!calls.some((c) => c.path === "issues/44/comments" || c.path === "issues/900/comments" || c.path === "issues/900"))
  assert.ok(!calls.some((c) => c.path === "pulls/44/merge"))
  assert.ok(calls.some((c) => c.path === "pulls/40/merge"))
  assert.deepEqual(res.skipped.map((s) => [s.list, s.why]), [["merge", "the decision it follows from could not be recorded"]])

  // labels before comments: when the label call fails, the comment that would follow is never posted
  const plan = { markRows: [{ issue: 1, row: 1, pr: 9, kind: "closed", redo: true, actions: [{ do: "label", on: 1, remove: "pipeline:redo" }, { do: "comment", on: 1, body: "x" }] }] }
  const second = fakeIo({}, { fail: (c) => c.method === "DELETE" })
  const out = await execute(plan, second.io)
  assert.deepEqual(short(second.calls), ["DELETE issues/1/labels/pipeline%3Aredo"])
  assert.deepEqual(out.failures.map((f) => f.step), ["label"])
})

test("every kind of step reaches the right endpoint", async () => {
  const { io, calls } = fakeIo({})
  const actions = [
    { do: "comment", on: 5, body: "b" },
    { do: "status", sha: "abc", state: "success", context: "pipeline/review", description: "d" },
    { do: "label", on: 5, add: "x" },
    { do: "label", on: 5, remove: "y z" },
    { do: "ready", pr: 7, node: "NODE7" },
    { do: "closePr", pr: 7 },
    { do: "closeIssue", issue: 5, reason: "not_planned" },
    { do: "openIssue", title: "t", body: "b", labels: ["l"] },
    { do: "dispatch", workflow: "pipeline-fix.yml", inputs: { issue: "5", row: "2", pr: "" } },
    { do: "merge", pr: 7, sha: "abc", method: "rebase" },
  ]
  const out = await execute({ markRows: [{ issue: 5, row: 0, pr: 7, kind: "done", actions }] }, io)
  assert.deepEqual(out.failures, [])
  assert.deepEqual(short(calls), ["POST issues/5/comments", "POST statuses/abc", "POST issues/5/labels", "DELETE issues/5/labels/y%20z", "GRAPHQL graphql", "PATCH pulls/7", "PATCH issues/5", "POST issues", "DISPATCH pipeline-fix.yml", "PUT pulls/7/merge"])
  assert.deepEqual(calls[4].body.variables, { id: "NODE7" })
  assert.match(calls[4].body.query, /markPullRequestReadyForReview/)
  assert.deepEqual(calls[6].body, { state: "closed", state_reason: "not_planned" })
  assert.deepEqual(calls[8].body, { ref: "main", inputs: { issue: "5", row: "2", pr: "" } })
  assert.deepEqual(calls[9].body, { merge_method: "rebase", sha: "abc" })
  // a step nobody knows is a failure, not something silently skipped
  const odd = await execute({ markRows: [{ issue: 5, row: 0, pr: 7, kind: "done", actions: [{ do: "explode" }] }] }, fakeIo({}).io)
  assert.match(odd.failures[0].error, /unknown plan step "explode"/)
  // a GraphQL error comes back with status 200: it is a failure all the same
  const gq = fakeIo({})
  gq.io.gh.graphql = () => ({ errors: [{ message: "not a draft" }] })
  const res = await execute({ applyAnswers: [{ item: 1, key: "A", by: "ann", how: "answer", effect: "merge", pr: 7, actions: [{ do: "ready", pr: 7, node: "N" }, { do: "comment", on: 7, body: "x" }] }] }, gq.io)
  assert.match(res.failures[0].error, /not a draft/)
  assert.deepEqual(gq.calls, [])
})

// ---------- modes ----------

test("--dry prints the plan as JSON and writes nothing", async () => {
  const { io, calls, lines } = fakeIo(world())
  const res = await run({ dry: true }, io)
  assert.equal(res.ok, true)
  assert.equal(res.dry, true)
  assert.deepEqual(calls, [])
  const printed = JSON.parse(lines[0])
  assert.deepEqual(printed.merge.map((m) => m.pr), [40, 44])
  assert.deepEqual(printed.dispatchFix.map((d) => d.issue), [1])
  assert.deepEqual(res.plan.dispatchRework.map((d) => d.pr), [41])
  assert.match(lines.at(-1), /dry run, nothing was changed/)
})

test("mode record: everything except merging; mode off: not even a read", async () => {
  const rec = fakeIo(world(), { config: cfg({ mode: "record" }) })
  const res = await run({}, rec.io)
  assert.equal(res.ok, true)
  assert.ok(!rec.calls.some((c) => c.method === "PUT"))
  assert.deepEqual(res.skipped.map((s) => [s.list, s.why]), [["merge", 'mode is "record"'], ["merge", 'mode is "record"']])
  // the answer was applied, the review and the executor were dispatched, the item was opened
  assert.ok(rec.calls.some((c) => c.path === "statuses/h44"))
  assert.equal(rec.calls.filter((c) => c.method === "DISPATCH").length, 3)
  assert.ok(res.notes.some((n) => /record mode: PR #40 \(level 0\) would have been merged now/.test(n)))

  const off = fakeIo(world(), { config: cfg({ mode: "off" }) })
  const none = await run({}, off.io)
  assert.deepEqual([none.ok, none.mode, off.calls, off.reads], [true, "off", [], []])
})

test("record mode leaves a due default alone", async () => {
  const two = pull(40, "pipeline/2-x", "h40")
  const { prAskItem } = await import("../cli/core/items.mjs")
  const built = prAskItem({ pr: two, review: { level: 2 }, config: cfg(), now: new Date(now.getTime() - 30 * 3600000), issue: 2 })
  const w = {
    issues: [issue(2)],
    prs: [two],
    items: [{ number: 900, title: built.title, body: built.body, state: "open", created_at: ago(1800), user: { login: "bot" } }],
    comments: { 40: [review("h40", "approve", 2)] },
    status: { h40: ownStatus("pending") },
  }
  const rec = fakeIo(w, { config: cfg({ mode: "record" }) })
  const res = await run({}, rec.io)
  assert.deepEqual(rec.calls, [])
  assert.deepEqual(res.skipped.map((s) => s.list), ["applyDefaults"])
  // in mode on the default is applied and the PR merged
  const on = fakeIo(w)
  await run({}, on.io)
  assert.deepEqual(short(on.calls), ["POST statuses/h40", "POST issues/40/comments", "PATCH issues/900", "POST issues/900/comments", "PUT pulls/40/merge"])
})

// ---------- gather ----------

test("gather: the state planTick is given", async () => {
  const w = world()
  w.prs[3] = { ...w.prs[3], labels: [label("pipeline:approved")] }
  w.events = { 43: [{ event: "labeled", label: { name: "other" }, actor: { login: "x" }, created_at: ago(9) }, { event: "labeled", label: { name: "pipeline:approved" }, actor: { login: "ann" }, created_at: ago(5) }] }
  w.runs = {
    "pipeline-fix.yml": [
      { id: 1, status: "in_progress", created_at: ago(5), display_title: "fix #8" },
      { id: 2, status: "queued", created_at: ago(30), display_title: "pipeline-fix" },
      { id: 3, status: "completed", conclusion: "success", created_at: ago(90), display_title: "fix #7" },
    ],
  }
  w.jobs = { 2: 0 }
  w.prs.find((p) => p.number === 46).body = "Fixes #1"
  // the pipeline's own jobs leave check runs on a head too (this very round's, when a pull
  // request event started it); they are not handed to the plan
  w.checks = { ...w.checks, h40: { check_runs: [...green.check_runs, { name: "pipeline / pipeline-tick", status: "in_progress", conclusion: null }, { name: "pipeline / pipeline-tick", status: "completed", conclusion: "failure" }, { name: "pipeline-review", status: "completed", conclusion: "cancelled" }] } }
  w.collaborators = [{ login: "ann", permissions: { admin: true } }, { login: "mia", permissions: { maintain: true, admin: false } }, { login: "dev", permissions: { push: true } }]
  w.issues.push(issue(8, { body: "## Acceptance criteria\n\n- ok\n\n## PR split\n\n| # | What | Where | Depends on | How to verify |\n|---|---|---|---|---|\n| 1 | a | `a.js` | #77, #78 | run |\n" }))
  w.others = [{ number: 77, state: "closed" }, { number: 78, state: "closed", pull_request: { merged_at: null } }]
  w.ledger = [{ at: ago(60), role: "executor", issue: 1, usd: 1, turns: 3, outcome: "pr" }]
  w.status.h40.statuses[0].target_url = "https://github.test/acme/app/pull/40#issuecomment-1"
  const { io, reads, calls } = fakeIo(w, { config: cfg({ owners: [] }) })
  const { state, problems } = await gather(io)
  assert.deepEqual(calls, [])
  assert.deepEqual(state.issues.map((i) => i.number), [1, 6, 2, 3, 4, 5, 7, 8])
  assert.deepEqual(state.issues[0].labels, ["pipeline"])
  // only PRs on the prefix whose branch lives in this repository
  assert.deepEqual(state.prs.map((p) => p.number), [40, 41, 42, 43, 44])
  // everybody else's open PRs come from the same list, slim: the plan reads them for "Fixes #n"
  assert.deepEqual(state.otherPrs, [{ number: 45, title: "PR 45", body: "", head: { ref: "pipeline/9-fork" } }, { number: 46, title: "PR 46", body: "Fixes #1", head: { ref: "feature/unrelated" } }])
  assert.equal(reads.filter((r) => r.startsWith("pulls?state=open")).length, 1)
  assert.ok(!reads.includes("pulls/45") && !reads.includes("pulls/46"), "nothing more is read about them")
  const p40 = state.prs[0]
  assert.deepEqual([p40.head, p40.mergeable, p40.draft, p40.node_id, p40.statuses[0].state, p40.checkRuns, p40.comments.length, p40.approved], [{ ref: "pipeline/2-ok", sha: "h40" }, true, false, "NODE40", "success", [{ name: "test", status: "completed", conclusion: "success" }], 1, null])
  assert.deepEqual(state.prs[3].approved, { by: "ann", at: ago(5) })
  assert.deepEqual(state.closedPrs.map((p) => [p.number, Boolean(p.merged_at)]), [[30, true]])
  assert.deepEqual(state.items.map((i) => [i.number, i.state, i.comments.length, i.user.login]), [[900, "open", 1, "bot"]])
  assert.equal(state.ledger.length, 1)
  assert.deepEqual(state.runs.fix.map((r) => [r.id, r.status, r.jobs]), [[1, "in_progress", undefined], [2, "queued", 0], [3, "completed", undefined]])
  assert.deepEqual(state.runs.review, [])
  assert.deepEqual(state.maintainers, ["ann", "mia"])
  // the login the io layer worked out (io.botLogin): the same one the executor and the reviewer go by
  assert.deepEqual(state.markAuthors, ["bot"])
  // the status says which comment it stands for
  assert.equal(p40.statuses[0].target_url, "https://github.test/acme/app/pull/40#issuecomment-1")
  assert.deepEqual(state.refsDone, { 77: true, 78: false })
  assert.equal(state.repoHasChecks, null)
  assert.deepEqual(problems, [])
  // the job count is only looked up for runs queued for a long time
  assert.deepEqual(reads.filter((r) => r.startsWith("actions/runs/")), ["actions/runs/2/jobs?per_page=1"])
  // owners in the config: collaborators are not read at all; PIPELINE_BOT may name the account(s) too
  const named = fakeIo(world(), { env: { PIPELINE_BOT: "bot-a, bot-b", PIPELINE_HAS_CHECKS: "false" }, botLogin: "" })
  const g = await gather(named.io)
  assert.deepEqual([g.state.maintainers, g.state.markAuthors, g.state.repoHasChecks], [[], ["bot-a", "bot-b"], false])
  assert.ok(!named.reads.some((r) => r.startsWith("collaborators") || r === "/user"))
  const both = fakeIo(world(), { env: { PIPELINE_BOT: "bot-a" }, botLogin: "app[bot]" })
  assert.deepEqual((await gather(both.io)).state.markAuthors, ["app[bot]", "bot-a"])
})

test("gather: what cannot be read. Runs unreadable = nothing dispatched; the core state unreadable = the round is called off", async () => {
  // the workflow runs cannot be read: the round goes on, without dispatching
  const noRuns = fakeIo({ ...world(), failRead: (p) => p.startsWith("actions/workflows/") })
  const res = await run({}, noRuns.io)
  assert.equal(res.ok, true)
  assert.deepEqual(noRuns.calls.filter((c) => c.method === "DISPATCH"), [])
  assert.ok(noRuns.calls.some((c) => c.path === "pulls/40/merge"))
  assert.ok(res.notes.some((n) => /could not read the executor runs/.test(n)))
  // the comments of one PR cannot be read: planning on half the state could start work twice, so nothing is done
  const broken = fakeIo({ ...world(), failRead: (p) => p.startsWith("issues/41/comments") })
  const bad = await run({}, broken.io)
  assert.equal(bad.ok, false)
  assert.deepEqual(broken.calls, [])
  assert.match(bad.error, /GET issues\/41\/comments/)
  assert.match(broken.lines.at(-1), /could not read the repository state, nothing was done/)
  // the ledger cannot be read: no budget can be checked, nothing is done
  const noLedger = fakeIo(world())
  noLedger.io.ledger.read = () => {
    throw new Error("ledger: cannot reach the remote")
  }
  const led = await run({}, noLedger.io)
  assert.deepEqual([led.ok, noLedger.calls], [false, []])
  // the io layer could not work out the pipeline's login: said so; the tick does not ask on its
  // own (the executor and the reviewer would then go by something else than the tick does)
  const anon = fakeIo(world(), { botLogin: "" })
  const g = await gather(anon.io)
  assert.equal(g.state.markAuthors, null)
  assert.ok(g.problems.some((p) => /own login is not known/.test(p)))
  assert.ok(!anon.reads.includes("/user"))
})

test("the lists are carried out in the documented order and every list has its wording", async () => {
  assert.deepEqual(ORDER, ["markRows", "applyAnswers", "applyDefaults", "merge", "closeItems", "labels", "closeIssues", "openItems", "nudges", "dispatchReview", "dispatchRework", "dispatchFix"])
  const { TEXT } = await import("../cli/roles/tick.mjs")
  const { emptyPlan } = await import("../cli/core/plan.mjs")
  for (const list of ORDER) {
    assert.equal(typeof TEXT.what[list], "function", list)
    assert.ok(Array.isArray(emptyPlan("on")[list]), list)
  }
})

// ---------- every module loads ----------

// A scheduler once shipped with a SyntaxError because no test imported the file. Every module
// under cli/ is syntax-checked and imported here, so a broken file cannot pass unnoticed.
const cliDir = fileURLToPath(new URL("../cli", import.meta.url))
const modules = (dir) =>
  readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? modules(join(dir, e.name)) : e.name.endsWith(".mjs") ? [join(dir, e.name)] : []))
    .sort()

test("every module under cli/ parses and can be imported", async () => {
  const files = modules(cliDir)
  for (const need of ["core/items.mjs", "core/plan.mjs", "roles/tick.mjs", "core/marks.mjs", "core/decide.mjs"]) assert.ok(files.some((f) => f.endsWith(need)), `${need} is missing`)
  for (const file of files) {
    const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" })
    assert.equal(check.status, 0, `${file} does not parse:\n${check.stderr}`)
  }
  for (const file of files) {
    // Importing runs nothing: the entry point only acts when it is the script that was started.
    await assert.doesNotReject(import(pathToFileURL(file).href), `${file} cannot be imported`)
  }
})
