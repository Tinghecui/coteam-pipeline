import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { DEFAULTS, loadConfig } from "../cli/core/config.mjs"
import { OWN_CHECK as CORE_OWN_CHECK } from "../cli/core/decide.mjs"
import { CALLERS, NEEDED, OWN_CHECK, TEXT, labelCommand, neededLabels, parseCaller, run } from "../cli/roles/doctor.mjs"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const file = (path) => readFileSync(`${ROOT}${path}`, "utf8")
const REPO = "acme/app"
const SHA = "c".repeat(40)
const config = (o = {}) => ({ ...loadConfig(file("templates/pipeline.yml"), file("presets/startup.yml")), ...o })
// The templates as a user would have them after replacing the placeholder.
const caller = (name, edit = (t) => t) => edit(file(`templates/workflows/${name}`).replaceAll("Tinghecui/coteam-pipeline", "engine-org/coteam-pipeline"))
const notFound = () => new Error("gh api -X GET failed (1): gh: Not Found (HTTP 404)")
const forbidden = () => new Error("gh api -X GET failed (1): gh: Resource not accessible by integration (HTTP 403)")

// A repository where everything is in place. `over` replaces routes: a value, or a function
// that returns one or throws. Writes are recorded in `calls`.
function fake({ cfg = config(), over = {}, io: extra = {}, failPost = () => false } = {}) {
  const labels = neededLabels(cfg).map((l) => ({ name: l.name }))
  const routes = {
    "labels?per_page=100": labels,
    "actions/secrets?per_page=100": { secrets: [{ name: "PIPELINE_APP_KEY" }, { name: "ANTHROPIC_API_KEY" }] },
    "actions/organization-secrets?per_page=100": { secrets: [] },
    "actions/variables?per_page=100": { variables: [{ name: "PIPELINE_APP_ID" }, { name: "PIPELINE_BOT" }] },
    "actions/organization-variables?per_page=100": { variables: [] },
    "issues?state=all&per_page=1": [],
    "pulls?state=all&per_page=1": [],
    [`branches/${cfg.base}`]: { name: cfg.base, protected: true, commit: { sha: SHA } },
    [`rules/branches/${cfg.base}`]: [],
    [`commits/${SHA}/status?per_page=100`]: { statuses: [] },
    [`commits/${SHA}/check-runs?filter=latest&per_page=100`]: { check_runs: [{ name: "test", status: "completed", conclusion: "success" }] },
    "actions/workflows?per_page=1": { total_count: 4, workflows: [] },
    [`/repos/${REPO}`]: { allow_squash_merge: true, allow_merge_commit: true, allow_rebase_merge: false },
    ...Object.fromEntries(CALLERS.map((c) => [`contents/.github/workflows/${c.file}?ref=${cfg.base}`, { encoding: "base64", content: Buffer.from(caller(c.file)).toString("base64") }])),
    ...over,
  }
  const calls = []
  const reads = []
  const get = (path) => {
    reads.push(path)
    if (!(path in routes)) throw new Error(`fake gh: no route for GET ${path}`)
    const v = routes[path]
    return typeof v === "function" ? v() : v
  }
  const write = (method) => (path, body) => {
    calls.push({ method, path, body })
    if (failPost({ method, path, body })) throw new Error(`gh api -X ${method} failed (1): gh: Resource not accessible by integration (HTTP 403)`)
    return {}
  }
  const lines = []
  const io = {
    env: {},
    now: () => new Date("2026-11-20T00:00:00Z"),
    log: (l) => lines.push(l),
    gh: { repo: REPO, get, list: get, post: write("POST"), patch: write("PATCH"), put: write("PUT"), del: write("DELETE"), graphql: write("GRAPHQL"), dispatch: write("DISPATCH") },
    config: cfg,
    botLogin: "acme-pipeline[bot]",
    ...extra,
  }
  return { io, calls, reads, lines }
}
const of = (res, id) => res.results.filter((r) => r.id === id)
const one = (res, id) => {
  const found = of(res, id)
  assert.equal(found.length, 1, `one result "${id}", got ${found.length}: ${JSON.stringify(res.results.map((r) => r.id))}`)
  return found[0]
}
const content = (text) => ({ encoding: "base64", content: Buffer.from(text).toString("base64") })
const wf = (name) => `contents/.github/workflows/${name}?ref=main`

test("a complete installation passes, with nothing written", async () => {
  const f = fake({ io: { tokenPermissions: { metadata: "read", contents: "write", issues: "write", pull_requests: "write", statuses: "write", actions: "write", checks: "read" } } })
  const res = await run({}, f.io)
  assert.equal(res.ok, true, f.lines.join("\n"))
  assert.equal(res.counts.FAIL, 0)
  assert.equal(res.counts.warn, 0, f.lines.join("\n"))
  assert.equal(res.counts.skip, 0)
  assert.deepEqual(f.calls, [], "the doctor only reads")
  assert.equal(one(res, "config").state, "ok")
  assert.equal(one(res, "labels").state, "ok")
  assert.equal(one(res, "workflow.engine").text, TEXT.callers.ok("main", "engine-org/coteam-pipeline", "v0.1.0"))
  assert.equal(one(res, "secrets").state, "ok")
  assert.equal(one(res, "variables").state, "ok")
  assert.equal(one(res, "write").state, "ok")
  assert.equal(one(res, "ci").state, "ok")
  assert.equal(one(res, "protection").state, "info")
  for (const key of ["issues", "pulls", "contents", "statuses", "checks", "actions"]) assert.equal(one(res, `read.${key}`).state, "ok", key)
  // every result was printed, state first; the last line is the summary
  assert.equal(f.lines[0], TEXT.title(REPO))
  for (const r of res.results) assert.ok(f.lines.includes(`${r.state.padEnd(4)}  ${r.text}`), r.text)
  assert.match(f.lines.at(-1), /^Ready: /)
})

test("the role keeps to the io contract: no process, no child processes, no clock of its own", () => {
  const src = file("cli/roles/doctor.mjs")
  assert.ok(!/process\.|child_process|Date\.now|new Date\(/.test(src))
  assert.deepEqual([...src.matchAll(/^import .* from "(.+)"$/gm)].map((m) => m[1]), ["../core/config.mjs", "../core/decide.mjs"])
  // which check runs are the pipeline's own is known in one place, cli/core/decide.mjs
  assert.equal(OWN_CHECK, CORE_OWN_CHECK)
  assert.ok(!/OWN_CHECK = /.test(src))
  assert.equal(typeof TEXT, "object")
})

test("a config that does not load fails, and the other checks go on with the defaults", async () => {
  const f = fake({ io: { config: null, configError: "Invalid pipeline config (1 problem):\n  - mode: must be one of: off, record, on" } })
  const res = await run({}, f.io)
  assert.equal(res.ok, false)
  const c = one(res, "config")
  assert.equal(c.state, "FAIL")
  assert.match(c.text, /Invalid pipeline config/)
  assert.ok(c.hint)
  // the defaults have no test command: that is reported too, and the labels are still looked at
  assert.equal(one(res, "stack.test").state, "FAIL")
  assert.equal(one(res, "labels").state, "ok")
  assert.match(f.lines.at(-1), /^Not ready: /)
})

test("stack.test empty fails; stack.check empty warns; limits beyond the job timeouts warn", async () => {
  const cfg = config({ stack: { ...DEFAULTS.stack, test: "  ", check: [] }, limits: { ...config().limits, executor_minutes: 300, reviewer_minutes: 50 } })
  const res = await run({}, fake({ cfg }).io)
  assert.equal(one(res, "stack.test").state, "FAIL")
  assert.match(one(res, "stack.test").hint, /stack\.test/)
  assert.equal(one(res, "stack.check").state, "warn")
  assert.equal(one(res, "limits.executor_minutes").state, "warn")
  assert.equal(one(res, "limits.reviewer_minutes").state, "warn")
  assert.equal(res.ok, false)
})

test("missing labels: the exact gh lines are offered, nothing is created without --fix", async () => {
  const cfg = config()
  const f = fake({ cfg, over: { "labels?per_page=100": [{ name: "Pipeline" }, { name: "level:0" }, { name: "bug" }] } })
  const res = await run({}, f.io)
  const r = one(res, "labels")
  assert.equal(r.state, "FAIL")
  // "Pipeline" counts as "pipeline": GitHub compares label names without case
  assert.ok(!r.text.includes("pipeline,"), r.text)
  const lines = r.hint.split("\n")
  assert.equal(lines.length, 1 + 7)
  assert.ok(lines.includes("gh label create 'pipeline:decide' --repo acme/app --color d93f0b --description 'A decision the pipeline needs from an owner'"))
  assert.ok(lines.includes("gh label create 'level:3' --repo acme/app --color b60205 --description 'Risk level 3'"))
  assert.deepEqual(f.calls, [])
  assert.deepEqual(res.created, [])
})

test("the label lines survive a name with a quote in it", () => {
  assert.equal(labelCommand("a/b", { name: "it's", color: "000000", description: "x; rm -rf ~" }), "gh label create 'it'\\''s' --repo a/b --color 000000 --description 'x; rm -rf ~'")
})

test("the label names follow the config", () => {
  const names = neededLabels(config({ labels: { ...DEFAULTS.labels, work: "bot", level_prefix: "risk-" } })).map((l) => l.name)
  assert.deepEqual(names, ["bot", "pipeline:decide", "pipeline:approved", "pipeline:redo", "pipeline:followup", "risk-0", "risk-1", "risk-2", "risk-3"])
  for (const l of neededLabels(config())) assert.match(l.color, /^[0-9a-f]{6}$/)
})

test("--fix creates the missing labels and only those", async () => {
  const f = fake({ over: { "labels?per_page=100": neededLabels(config()).slice(2).map((l) => ({ name: l.name })) } })
  const res = await run({ fix: true }, f.io)
  assert.deepEqual(res.created, ["pipeline", "pipeline:decide"])
  assert.deepEqual(f.calls.map((c) => `${c.method} ${c.path} ${c.body.name}`), ["POST labels pipeline", "POST labels pipeline:decide"])
  assert.equal(f.calls[0].body.color, "1d76db")
  assert.equal(one(res, "labels.created").state, "ok")
  assert.equal(one(res, "labels").state, "ok")
  assert.equal(res.ok, true)
})

test("--fix with a token that may not create labels: says so and gives the line", async () => {
  const f = fake({ over: { "labels?per_page=100": neededLabels(config()).slice(1).map((l) => ({ name: l.name })) }, failPost: () => true })
  const res = await run({ fix: true }, f.io)
  const r = one(res, "labels")
  assert.equal(r.state, "FAIL")
  assert.match(r.text, /could not create the label "pipeline"/)
  assert.match(r.hint, /gh label create 'pipeline' /)
  assert.equal(res.ok, false)
})

test("labels that cannot be listed are a skip, with every line to run by hand", async () => {
  const res = await run({}, fake({ over: { "labels?per_page=100": () => { throw forbidden() } } }).io)
  const r = one(res, "labels")
  assert.equal(r.state, "skip")
  assert.equal(r.hint.split("\n").length, 1 + 9)
  assert.equal(res.ok, true, "what cannot be checked does not fail the run")
})

test("a caller workflow missing on the base branch fails with what to copy", async () => {
  const f = fake({ over: { [wf("pipeline-review.yml")]: () => { throw notFound() } } })
  const res = await run({}, f.io)
  const r = one(res, "workflow.review")
  assert.equal(r.state, "FAIL")
  assert.match(r.text, /pipeline-review\.yml is not on the branch "main"/)
  assert.match(r.hint, /templates\/workflows\/pipeline-review\.yml/)
  assert.equal(of(res, "workflow.engine").length, 0)
  assert.equal(res.ok, false)
})

test("the workflows are read from the configured base branch", async () => {
  const cfg = config({ base: "release/1.x" })
  const f = fake({ cfg, over: Object.fromEntries(CALLERS.map((c) => [`contents/.github/workflows/${c.file}?ref=release%2F1.x`, content(caller(c.file))]).concat([["branches/release%2F1.x", { protected: false, commit: { sha: SHA } }], ["rules/branches/release%2F1.x", []]])) })
  const res = await run({}, f.io)
  assert.equal(res.ok, true, f.lines.join("\n"))
  assert.equal(one(res, "protection").text, TEXT.protection.off("release/1.x"))
})

test("engine_ref different from the ref in uses: fails", async () => {
  const over = { [wf("pipeline-fix.yml")]: content(caller("pipeline-fix.yml", (t) => t.replace("engine_ref: v0.1.0", "engine_ref: v0.2.0"))) }
  const res = await run({}, fake({ over }).io)
  const r = one(res, "workflow.fix")
  assert.equal(r.state, "FAIL")
  assert.equal(r.text, TEXT.callers.refMismatch("pipeline-fix.yml", "v0.1.0", "v0.2.0"))
  assert.equal(res.ok, false)
})

test("three callers on different engine refs fail, listing each", async () => {
  const over = { [wf("pipeline-tick.yml")]: content(caller("pipeline-tick.yml", (t) => t.replaceAll("v0.1.0", "v0.1.1"))) }
  const res = await run({}, fake({ over }).io)
  const r = one(res, "workflow.engine")
  assert.equal(r.state, "FAIL")
  assert.match(r.text, /pipeline-tick\.yml: engine-org\/coteam-pipeline@v0\.1\.1; pipeline-fix\.yml: engine-org\/coteam-pipeline@v0\.1\.0/)
})

test("a branch as the engine ref warns; a tag or a full sha does not", async () => {
  const all = (ref) => Object.fromEntries(CALLERS.map((c) => [wf(c.file), content(caller(c.file, (t) => t.replaceAll("v0.1.0", ref)))]))
  const onMain = await run({}, fake({ over: all("main") }).io)
  assert.equal(one(onMain, "workflow.ref").state, "warn")
  assert.equal(onMain.ok, true)
  const onSha = await run({}, fake({ over: all("0123456789abcdef0123456789abcdef01234567") }).io)
  assert.equal(of(onSha, "workflow.ref").length, 0)
})

test("a caller that calls the wrong reusable workflow, or none, fails", async () => {
  const over = {
    [wf("pipeline-fix.yml")]: content(caller("pipeline-review.yml")),
    [wf("pipeline-review.yml")]: content("name: pipeline-review\non:\n  workflow_dispatch:\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n"),
  }
  const res = await run({}, fake({ over }).io)
  assert.equal(one(res, "workflow.fix").text, TEXT.callers.noUses("pipeline-fix.yml", "fix"))
  assert.equal(one(res, "workflow.review").text, TEXT.callers.noUses("pipeline-review.yml", "review"))
})

test("secrets: inherit warns; a lost run-name, a lost dispatch trigger and an extra trigger fail", async () => {
  const over = {
    [wf("pipeline-tick.yml")]: content(caller("pipeline-tick.yml", (t) => t.replace(/    secrets:\n      PIPELINE_APP_KEY: .*\n/, "    secrets: inherit\n"))),
    [wf("pipeline-fix.yml")]: content(caller("pipeline-fix.yml", (t) => t.replace(/^run-name: .*\n/m, ""))),
    [wf("pipeline-review.yml")]: content(caller("pipeline-review.yml", (t) => t.replace("on:\n  workflow_dispatch:", "on:\n  pull_request:\n    types: [opened]\n  workflow_dispatch:"))),
  }
  const res = await run({}, fake({ over }).io)
  assert.equal(one(res, "workflow.tick").state, "warn")
  assert.match(one(res, "workflow.tick").text, /secrets: inherit/)
  assert.equal(one(res, "workflow.fix").text, TEXT.callers.runName("pipeline-fix.yml", '"#<issue>"'))
  assert.equal(one(res, "workflow.review").text, TEXT.callers.extraTrigger("pipeline-review.yml", "pull_request"))
  assert.equal(res.ok, false)
  const noDispatch = await run({}, fake({ over: { [wf("pipeline-review.yml")]: content(caller("pipeline-review.yml", (t) => t.replace("  workflow_dispatch:", "  push:"))) } }).io)
  assert.ok(of(noDispatch, "workflow.review").some((r) => r.text === TEXT.callers.notDispatch("pipeline-review.yml")))
})

test("parseCaller reads the templates and is not fooled by comments", () => {
  for (const c of CALLERS) {
    const p = parseCaller(file(`templates/workflows/${c.file}`))
    assert.deepEqual(p.uses, { repo: "Tinghecui/coteam-pipeline", reusable: c.reusable, ref: "v0.1.0" })
    assert.equal(p.engineRef, "v0.1.0")
    assert.equal(p.inherit, false)
  }
  const p = parseCaller('# uses: a/b/.github/workflows/tick.yml@old\non: [push, workflow_dispatch]\njobs:\n  j:\n    uses: "x/y/.github/workflows/tick.yml@abc" # note\n    with:\n      engine_ref: "abc"\n    # secrets: inherit\n')
  assert.deepEqual(p.uses, { repo: "x/y", reusable: "tick", ref: "abc" })
  assert.equal(p.engineRef, "abc")
  assert.equal(p.inherit, false)
  assert.deepEqual(p.triggers, ["push", "workflow_dispatch"])
  assert.deepEqual(parseCaller("on: workflow_dispatch\n").triggers, ["workflow_dispatch"])
  assert.equal(parseCaller("jobs: {}\n").uses, null)
})

test("secrets and variables: missing names fail with the command; values are never asked for", async () => {
  const f = fake({ over: { "actions/secrets?per_page=100": { secrets: [{ name: "PIPELINE_APP_KEY" }] }, "actions/variables?per_page=100": { variables: [] } } })
  const res = await run({}, f.io)
  const s = one(res, "secrets")
  assert.equal(s.state, "FAIL")
  assert.equal(s.text, TEXT.settings.missing("secrets", ["ANTHROPIC_API_KEY"]))
  assert.match(s.hint, /^gh secret set ANTHROPIC_API_KEY --repo acme\/app/)
  assert.equal(one(res, "variables").state, "FAIL")
  // PIPELINE_BOT is optional: a note that says what it is for, never a failure or a warning
  const bot = one(res, "variables.bot")
  assert.equal(bot.state, "info")
  assert.match(bot.text, /optional/)
  assert.match(bot.hint, /gh variable set PIPELINE_BOT --repo acme\/app --body "<app-slug>\[bot\]"/)
  // names are listed; no single secret or variable is ever fetched
  assert.ok(!f.reads.some((p) => /actions\/(secrets|variables)\/\w/.test(p)), f.reads.join("\n"))
})

test("the pipeline's own login: reported when known, a warning when not; PIPELINE_BOT is compared with the App's login when that is certain", async () => {
  const known = await run({}, fake().io)
  assert.equal(one(known, "bot").state, "ok")
  assert.match(one(known, "bot").text, /writes as acme-pipeline\[bot\]/)
  assert.equal(of(known, "variables.bot").length, 0, "the variable is set and nothing says it is wrong")
  const unknown = await run({}, fake({ io: { botLogin: "" } }).io)
  assert.equal(one(unknown, "bot").state, "warn")
  assert.match(one(unknown, "bot").hint, /the engine reads the App's login itself/)
  assert.equal(unknown.ok, true)

  // on the App's own token (GitHub told its permissions) the login is the App's for certain
  const perms = { contents: "write", issues: "write", pull_requests: "write", statuses: "write", actions: "write", checks: "read" }
  const vars = (list) => ({ "actions/variables?per_page=100": { variables: [{ name: "PIPELINE_APP_ID", value: "1" }, ...list] } })
  const unset = await run({}, fake({ over: vars([]), io: { tokenPermissions: perms } }).io)
  assert.equal(one(unset, "variables.bot").state, "info")
  assert.match(one(unset, "variables.bot").hint, /--body "acme-pipeline\[bot\]"/, "the hint names the real login")
  const typo = await run({}, fake({ over: vars([{ name: "PIPELINE_BOT", value: "acme-pipline[bot]" }]), io: { tokenPermissions: perms } }).io)
  assert.equal(one(typo, "variables.bot").state, "warn")
  assert.equal(one(typo, "variables.bot").text, TEXT.settings.otherBot("acme-pipline[bot]", "acme-pipeline[bot]"))
  const right = await run({}, fake({ over: vars([{ name: "PIPELINE_BOT", value: "Acme-Pipeline[bot]" }]), io: { tokenPermissions: perms } }).io)
  assert.equal(of(right, "variables.bot").length, 0)
  // on a person's token the login is that person's: the variable is not compared with it
  const person = await run({}, fake({ over: vars([{ name: "PIPELINE_BOT", value: "acme-pipeline[bot]" }]), io: { botLogin: "ann" } }).io)
  assert.equal(of(person, "variables.bot").length, 0)
})

test("an organisation-level secret counts", async () => {
  const f = fake({ over: { "actions/secrets?per_page=100": { secrets: [{ name: "PIPELINE_APP_KEY" }] }, "actions/organization-secrets?per_page=100": { secrets: [{ name: "ANTHROPIC_API_KEY" }] } } })
  assert.equal(one(await run({}, f.io), "secrets").state, "ok")
})

test("a token that may not list secrets or variables: cannot check, not a failure", async () => {
  const deny = () => { throw forbidden() }
  const f = fake({ over: { "actions/secrets?per_page=100": deny, "actions/organization-secrets?per_page=100": deny, "actions/variables?per_page=100": deny, "actions/organization-variables?per_page=100": deny }, io: { env: { PIPELINE_BOT: "acme-pipeline[bot]" } } })
  const res = await run({}, f.io)
  assert.equal(one(res, "secrets").state, "skip")
  assert.match(one(res, "secrets").text, /cannot check/)
  assert.match(one(res, "secrets").hint, /PIPELINE_APP_KEY, ANTHROPIC_API_KEY/)
  assert.equal(one(res, "variables").state, "skip")
  assert.equal(of(res, "variables.bot").length, 0, "the variables could not be listed: nothing is said about PIPELINE_BOT")
  assert.equal(res.ok, true)
})

test("a read the bot is refused fails with the App permission to grant", async () => {
  const f = fake({ over: { "actions/workflows?per_page=1": () => { throw forbidden() }, [`commits/${SHA}/check-runs?filter=latest&per_page=100`]: () => { throw forbidden() } } })
  const res = await run({}, f.io)
  assert.equal(one(res, "read.actions").state, "FAIL")
  assert.match(one(res, "read.actions").hint, /"Actions: read and write"/)
  assert.match(one(res, "read.checks").hint, /"Checks: read"/)
  assert.equal(one(res, "read.issues").state, "ok")
  assert.equal(res.ok, false)
  // statuses were still readable, so CI is judged on them alone
  assert.notEqual(one(res, "ci").state, "skip")
})

test("write access: exact when the token's permissions are known", async () => {
  const perms = { contents: "write", issues: "write", pull_requests: "read", statuses: "write", actions: "write", checks: "read", workflows: "write" }
  const res = await run({}, fake({ io: { tokenPermissions: perms } }).io)
  const r = one(res, "write.pull_requests")
  assert.equal(r.state, "FAIL")
  assert.equal(r.text, TEXT.access.noWrite("pull_requests", "read"))
  assert.equal(one(res, "write.workflows").state, "warn", "more than the pipeline needs")
  assert.equal(of(res, "write").length, 0)
  const none = await run({}, fake({ io: { tokenPermissions: { contents: "write" } } }).io)
  assert.deepEqual(none.results.filter((x) => x.id.startsWith("write.")).map((x) => x.id).sort(), ["write.actions", "write.checks", "write.issues", "write.pull_requests", "write.statuses"])
  assert.deepEqual(Object.keys(NEEDED).sort(), ["actions", "checks", "contents", "issues", "pull_requests", "statuses"])
})

test("write access: a user's token is judged by push access; an App token without details cannot be checked", async () => {
  const user = (push) => ({ [`/repos/${REPO}`]: { allow_squash_merge: true, permissions: { admin: false, push, pull: true } } })
  assert.equal(one(await run({}, fake({ over: user(true) }).io), "write").state, "ok")
  const noPush = await run({}, fake({ over: user(false) }).io)
  assert.equal(one(noPush, "write").state, "FAIL")
  const app = await run({}, fake().io)
  assert.equal(one(app, "write").state, "skip")
  assert.match(one(app, "write").text, /cannot check/)
  assert.equal(app.ok, true)
})

test("a merge method the repository does not allow fails", async () => {
  const res = await run({}, fake({ cfg: config({ merge: { ...config().merge, method: "rebase" } }) }).io)
  assert.equal(one(res, "merge.method").state, "FAIL")
})

test("no CI at all: a warning in mode on, a note in record; the pipeline's own checks do not count as CI", async () => {
  const own = {
    [`commits/${SHA}/check-runs?filter=latest&per_page=100`]: { check_runs: [{ name: "pipeline / pipeline-tick" }, { name: "pipeline / pipeline-review" }, { name: "pipeline-fix" }] },
    [`commits/${SHA}/status?per_page=100`]: { statuses: [{ context: "pipeline/review", state: "success" }] },
  }
  const on = await run({}, fake({ cfg: config({ mode: "on" }), over: own }).io)
  assert.equal(one(on, "ci").state, "warn")
  assert.equal(one(on, "ci").text, TEXT.ci.noneOn)
  assert.equal(on.ok, true, "a warning, not a failure")
  const record = await run({}, fake({ over: own }).io)
  assert.equal(one(record, "ci").state, "info")
  const withStatus = await run({}, fake({ cfg: config({ mode: "on" }), over: { ...own, [`commits/${SHA}/status?per_page=100`]: { statuses: [{ context: "ci/circleci: build", state: "success" }] } } }).io)
  assert.equal(one(withStatus, "ci").state, "ok")
  assert.match(one(withStatus, "ci").text, /ci\/circleci: build/)
  assert.ok(OWN_CHECK.test("pipeline / pipeline-tick") && !OWN_CHECK.test("my-pipeline-tick") && !OWN_CHECK.test("test"))
})

test("branch protection is informational either way; a ruleset counts as protection", async () => {
  const open = { "branches/main": { protected: false, commit: { sha: SHA } } }
  const off = await run({}, fake({ over: open }).io)
  assert.equal(one(off, "protection").state, "info")
  assert.equal(one(off, "protection").text, TEXT.protection.off("main"))
  assert.match(one(off, "protection").hint, /pipeline\/review/)
  assert.equal(off.ok, true)
  const ruled = await run({}, fake({ over: { ...open, "rules/branches/main": [{ type: "pull_request" }] } }).io)
  assert.equal(one(ruled, "protection").text, TEXT.protection.on("main"))
  const unreadable = await run({}, fake({ over: { ...open, "rules/branches/main": () => { throw forbidden() } } }).io)
  assert.equal(one(unreadable, "protection").text, TEXT.protection.off("main"))
})

test("a base branch that cannot be read: contents fail, CI and protection are not guessed", async () => {
  const res = await run({}, fake({ over: { "branches/main": () => { throw notFound() } } }).io)
  assert.equal(one(res, "read.contents").state, "FAIL")
  assert.equal(one(res, "ci").state, "skip")
  assert.equal(of(res, "protection").length, 0)
  assert.equal(of(res, "read.statuses").length, 0)
})

test("works with a synchronous gh (the real one) as well as an asynchronous one", async () => {
  const f = fake()
  const g = f.io.gh
  f.io.gh = { ...g, get: async (p) => g.get(p), list: async (p) => g.list(p), post: async (p, b) => g.post(p, b) }
  const res = await run({}, f.io)
  assert.equal(res.ok, true, f.lines.join("\n"))
})
