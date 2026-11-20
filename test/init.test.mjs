// The installer's steps (cli/roles/init.mjs) and the Claude Code plugin that calls them.
// Nothing here talks to GitHub: `gh` and `git ls-remote` are a scripted proc, the API a
// scripted fetch; the browser is this test making the two requests a browser would make
// to the installer's local page.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { generateKeyPairSync } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { loadConfig } from "../cli/core/config.mjs"
import { run as realProc } from "../cli/io/proc.mjs"
import { main } from "../cli/main.mjs"
import { CALLERS, NEEDED, parseCaller } from "../cli/roles/doctor.mjs"
import { app, appNameOf, check, ciOf, engineRepo, files, manifestOf, renderCaller, repoOf, riskyOf, scan, stackOf, TEMPLATE_REF, TEXT, uiOf } from "../cli/roles/init.mjs"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const SHA = "a".repeat(40)
const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } }).trim()
const put = (dir, path, text) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), text)
}
function checkout(tree = {}, remote = "git@github.com:acme/shop.git") {
  const dir = mkdtempSync(join(tmpdir(), "init-test-"))
  sh(dir, "init", "-q", "-b", "main")
  if (remote) sh(dir, "remote", "add", "origin", remote)
  for (const [p, t] of Object.entries(tree)) put(dir, p, t)
  sh(dir, "add", "-A")
  sh(dir, "commit", "-q", "--allow-empty", "-m", "first")
  return dir
}
// git is real (it only reads the temp checkout); gh and ls-remote are answered from `gh`.
function fakeProc(gh = {}, { remoteRefs = `${SHA}\tHEAD\n` } = {}) {
  const calls = []
  const proc = (cmd, args, opts = {}) => {
    if (cmd === "git" && args[0] === "ls-remote") return { rc: 0, stdout: remoteRefs, stderr: "" }
    if (cmd === "git") return realProc(cmd, args, opts)
    calls.push({ args, input: opts.input })
    const key = args.join(" ")
    const hit = Object.keys(gh).find((k) => key.startsWith(k))
    if (!hit) return { rc: 1, stdout: "", stderr: `HTTP 404: Not Found (${key})` }
    const v = typeof gh[hit] === "function" ? gh[hit](args, opts) : gh[hit]
    return typeof v === "string" ? { rc: 0, stdout: v, stderr: "" } : v?.rc !== undefined ? v : { rc: 0, stdout: JSON.stringify(v), stderr: "" }
  }
  return { proc, calls }
}
const REPO_INFO = { default_branch: "main", private: true, owner: { login: "acme", type: "Organization" }, permissions: { admin: true }, allow_squash_merge: true, allow_merge_commit: false }
const GH = {
  "api repos/acme/shop/actions/permissions": { enabled: true, allowed_actions: "all" },
  "api repos/acme/shop/actions/secrets": { secrets: [{ name: "DEPLOY_KEY" }] },
  "api repos/acme/shop/actions/variables": { variables: [] },
  "api repos/acme/shop": REPO_INFO,
  "auth status": "  - Token scopes: 'gist', 'repo', 'workflow'\n",
}
const logs = () => {
  const lines = []
  return { lines, log: (s) => lines.push(s), text: () => lines.join("\n") }
}

// ---------- scan ----------

test("repoOf: ssh and https remotes of GitHub; anything else is not a repository the pipeline can run in", () => {
  assert.equal(repoOf("git@github.com:acme/shop.git\n"), "acme/shop")
  assert.equal(repoOf("https://github.com/acme/shop"), "acme/shop")
  assert.equal(repoOf("https://x-access-token:abc@github.com/acme/my.shop.git/"), "acme/my.shop")
  assert.equal(repoOf("git@gitlab.com:acme/shop.git"), "")
  assert.equal(repoOf(""), "")
})

test("stackOf: the commands follow the lockfile and the scripts that really exist", () => {
  const pkg = (scripts, deps = { a: "1" }) => JSON.stringify({ scripts, dependencies: deps })
  const of = (tree) => stackOf(Object.keys(tree), (f) => tree[f])
  assert.deepEqual(of({ "package.json": pkg({ test: "vitest", lint: "eslint .", typecheck: "tsc" }), "pnpm-lock.yaml": "" }), {
    kind: "node", setup: ["pnpm install --frozen-lockfile"], test: "pnpm test", check: ["pnpm run lint", "pnpm run typecheck"],
    notes: ['pnpm must be on the runner: GitHub\'s runners carry npm and yarn; for others add a step such as "corepack enable" to stack.setup'],
  })
  assert.deepEqual(of({ "package.json": pkg({ test: "node --test" }), "package-lock.json": "" }), { kind: "node", setup: ["npm ci"], test: "npm test", check: [], notes: [] })
  // npm's placeholder is not a test command; a package without dependencies needs no install
  const bare = of({ "package.json": pkg({ test: 'echo "Error: no test specified" && exit 1' }, {}) })
  assert.deepEqual([bare.setup, bare.test], [[], ""])
  assert.match(bare.notes.join(), /no "test" script/)
  assert.deepEqual(of({ "go.mod": "" }).test, "go test ./...")
  assert.deepEqual(of({ "Cargo.toml": "" }).test, "cargo test")
  assert.deepEqual(of({ "pyproject.toml": "[tool.ruff]\n", "uv.lock": "" }), { kind: "python", setup: ["uv sync"], test: "uv run pytest", check: ["uv run ruff check ."], notes: ["uv must be on the runner: add its installation to stack.setup"] })
  assert.deepEqual(of({ "requirements.txt": "" }).setup, ["pip install -r requirements.txt"])
  assert.deepEqual(of({ Gemfile: "", "spec/a_spec.rb": "" }).test, "bundle exec rspec")
  const none = of({ "main.c": "" })
  assert.deepEqual([none.kind, none.test], ["unknown", ""])
})

test("ciOf: the repository's own workflows by the name a workflow_run trigger needs, never the pipeline's three", () => {
  const tree = {
    ".github/workflows/ci.yml": 'name: "CI"\non:\n  pull_request:\n  push:\n',
    ".github/workflows/deploy.yaml": "on: [push]\n",
    ".github/workflows/pipeline-tick.yml": "name: pipeline-tick\non:\n  schedule:\n",
    ".github/workflows/sub/x.yml": "name: nested\n",
    "src/ci.yml": "name: no\n",
  }
  assert.deepEqual(ciOf(Object.keys(tree), (f) => tree[f]), [
    { file: ".github/workflows/ci.yml", name: "CI", pull_request: true },
    { file: ".github/workflows/deploy.yaml", name: ".github/workflows/deploy.yaml", pull_request: false },
  ])
})

test("riskyOf and uiOf: candidates for risk.level3 and stack.ui_paths, without tests and vendored code", () => {
  assert.deepEqual(riskyOf(["src/auth/login.ts", "src/auth/token.ts", "db/migrations/001.sql", "src/lib/billing.ts", "src/author.ts", "test/auth/x.test.ts", "node_modules/stripe/index.js", "app/payments/a/b.rb"]), [
    "app/payments/**",
    "db/migrations/**",
    "src/auth/**",
    "src/lib/billing.ts",
  ])
  assert.deepEqual(uiOf(["src/a.tsx", "src/b/c.tsx", "src/a.test.tsx", "src/x.css", "public/index.html", "index.html", "dist/app.css", "src/api.ts"]), [
    { glob: "src/**/*.tsx", files: 2 },
    { glob: "src/**/*.css", files: 1 },
    { glob: "public/**/*.html", files: 1 },
    { glob: "*.html", files: 1 },
  ])
})

test("scan: the checkout and what GitHub says, in one JSON; a secret's value is never asked for", () => {
  const dir = checkout({
    "package.json": JSON.stringify({ scripts: { test: "vitest" }, devDependencies: { vitest: "1" } }),
    "package-lock.json": "{}",
    ".github/workflows/ci.yml": "name: CI\non: [pull_request]\n",
    "src/auth/login.ts": "",
    "src/app.tsx": "",
    "src/app.test.tsx": "",
    "CLAUDE.md": "",
    ".npmrc": "//npm.pkg.github.com/:_authToken=${NPM_TOKEN}\n",
  })
  const { proc, calls } = fakeProc(GH)
  const s = scan({ cwd: dir }, { proc })
  assert.equal(s.repo, "acme/shop")
  assert.deepEqual(s.github, {
    default_branch: "main", private: true, owner: "acme", owner_is_organization: true, admin: true,
    merge_methods: { squash: true, merge: false, rebase: true }, actions_enabled: true, actions_allowed: "all",
    secrets: ["DEPLOY_KEY"], variables: [], app_id: "", can_push_workflows: true,
  })
  assert.deepEqual([s.stack.setup, s.stack.test], [["npm ci"], "npm test"])
  assert.deepEqual(s.ci, [{ file: ".github/workflows/ci.yml", name: "CI", pull_request: true }])
  assert.deepEqual(s.tests, { test_files: 1, source_files: 2 })
  assert.deepEqual(s.risky_paths, ["src/auth/**"])
  assert.deepEqual(s.agent_instructions, ["CLAUDE.md"])
  assert.equal(s.private_registry, true)
  assert.deepEqual(s.installed, [])
  assert.deepEqual([s.branch, s.dirty, s.problem], ["main", false, ""])
  assert.equal(s.engine.repo, engineRepo())
  // only reads, and only through the API and `auth status`
  for (const c of calls) assert.ok((c.args[0] === "api" && !c.args.includes("-X")) || c.args.join(" ") === "auth status", c.args.join(" "))
})

test("scan: no GitHub remote, or gh not answering, is said in the result; a directory that is no checkout is an error", () => {
  const s = scan({ cwd: checkout({}, "git@gitlab.com:acme/shop.git") }, { proc: fakeProc(GH).proc })
  assert.deepEqual([s.repo, s.github], ["", null])
  assert.equal(s.problem, TEXT.noRemote)
  const g = scan({ cwd: checkout({}) }, { proc: fakeProc({}).proc }).github
  assert.match(g.error, /could not be asked through the gh command line tool/)
  assert.equal(g.hint, TEXT.ghHint)
  assert.throws(() => scan({ cwd: mkdtempSync(join(tmpdir(), "init-none-")) }, { proc: fakeProc(GH).proc }), /not a git checkout/)
})

// ---------- files and check ----------

test("renderCaller: the ref goes in twice, the repository's CI joins the runs the dispatcher wakes up on, nothing else changes", () => {
  for (const c of CALLERS) {
    const before = readFileSync(join(ROOT, "templates/workflows", c.file), "utf8")
    const after = renderCaller(c.file, { ref: SHA, ci: ["CI", "Lint & types"] })
    const p = parseCaller(after)
    assert.deepEqual([p.uses.ref, p.engineRef, p.uses.reusable], [SHA, SHA, c.reusable], c.file)
    assert.ok(!after.includes(`@${TEMPLATE_REF}`) && !after.includes(`engine_ref: ${TEMPLATE_REF}`), c.file)
    const changed = after.split("\n").filter((l, i) => l !== before.split("\n")[i])
    assert.equal(changed.length, c.reusable === "tick" ? 4 : 3, `${c.file}: ${changed.join(" | ")}`)
  }
  assert.match(renderCaller("pipeline-tick.yml", { ref: SHA, ci: ["CI"] }), /^    workflows: \["pipeline-fix", "pipeline-review", "CI"\]$/m)
  assert.match(renderCaller("pipeline-tick.yml", { ref: SHA }), /^    workflows: \["pipeline-fix", "pipeline-review"\]$/m)
})

test("files: writes the four files pinned to the engine's commit when the version has no release tag, to the tag when it has; never over an existing file", () => {
  const dir = checkout({})
  const l = logs()
  const res = files({ cwd: dir, ci: ["CI", " CI ", ""], base: "trunk" }, { proc: fakeProc().proc, log: l.log })
  assert.deepEqual(res.wrote, [".github/workflows/pipeline-tick.yml", ".github/workflows/pipeline-fix.yml", ".github/workflows/pipeline-review.yml", ".coteam/pipeline.yml"])
  assert.equal(res.ref, SHA)
  assert.match(l.text(), /no release tag for this version yet/)
  assert.match(readFileSync(join(dir, ".github/workflows/pipeline-tick.yml"), "utf8"), /workflows: \["pipeline-fix", "pipeline-review", "CI"\]/)
  const config = loadConfig(readFileSync(join(dir, ".coteam/pipeline.yml"), "utf8"), readFileSync(join(ROOT, "presets/startup.yml"), "utf8"))
  assert.deepEqual([config.base, config.mode], ["trunk", "record"])
  assert.equal(check({ cwd: dir }, { log: () => {} }).ok, true)

  // a second run keeps what is there (the person has edited the config by then)
  put(dir, ".coteam/pipeline.yml", "version: 1\n")
  const again = files({ cwd: dir }, { proc: fakeProc().proc, log: () => {} })
  assert.deepEqual([again.wrote, again.kept.length], [[], 4])
  assert.equal(readFileSync(join(dir, ".coteam/pipeline.yml"), "utf8"), "version: 1\n")
  assert.equal(files({ cwd: dir, force: true }, { proc: fakeProc().proc, log: () => {} }).wrote.length, 4)

  // the release tag of this installer's version wins over the branch head
  const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version
  const tagged = files({ cwd: checkout({}) }, { proc: fakeProc({}, { remoteRefs: `${SHA}\tHEAD\n${"b".repeat(40)}\trefs/tags/v${version}\n` }).proc, log: () => {} })
  assert.equal(tagged.ref, `v${version}`)
  // a given ref is taken as it is, and a branch is called what it is
  const l2 = logs()
  assert.equal(files({ cwd: checkout({}), ref: "main" }, { proc: fakeProc().proc, log: l2.log }).ref, "main")
  assert.match(l2.text(), /is a branch, not a release tag or a commit/)
})

test("files: a CI name that would break the YAML, or the dispatcher itself, is refused before anything is written", () => {
  for (const [ci, re] of [[['a"b'], /cannot be used/], [["pipeline-tick"], /start itself forever/]]) {
    const dir = checkout({})
    assert.throws(() => files({ cwd: dir, ci }, { proc: fakeProc().proc, log: () => {} }), re)
    assert.ok(!existsSync(join(dir, ".coteam")))
  }
  assert.throws(() => files({ cwd: checkout({}) }, { proc: fakeProc({}, { remoteRefs: "" }).proc, log: () => {} }), /pass --ref with a release tag or a full commit SHA/)
})

test("check: what would go wrong after the merge is said before it", () => {
  const fresh = () => {
    const dir = checkout({})
    files({ cwd: dir, ci: ["CI"] }, { proc: fakeProc().proc, log: () => {} })
    return dir
  }
  const states = (dir) => check({ cwd: dir }, { log: () => {} }).results.map((r) => `${r.state} ${r.text}`)
  const edit = (dir, path, from, to) => {
    const text = readFileSync(join(dir, path), "utf8")
    assert.ok(text.includes(from), `${path} has no ${from}`)
    writeFileSync(join(dir, path), text.split(from).join(to))
  }
  // the starter as written: ready, with the two things a person still has to fill in
  assert.deepEqual(states(fresh()), [
    `ok ${TEXT.check.configOk({ mode: "record", base: "main" })}`,
    `warn ${TEXT.check.noOwners}`,
    `ok ${TEXT.check.workflowsOk(engineRepo(), SHA)}`,
  ])
  let dir = fresh()
  edit(dir, ".coteam/pipeline.yml", "mode: record", "mode: on")
  edit(dir, ".coteam/pipeline.yml", 'test: "npm test"', 'test: ""')
  edit(dir, ".coteam/pipeline.yml", 'check: ["npm run lint"]', "check: []")
  edit(dir, ".coteam/pipeline.yml", 'level3: ["**/auth/**", "**/migrations/**"]', "level3: []")
  const s = states(dir)
  for (const want of [`warn ${TEXT.check.notRecord("on")}`, `FAIL ${TEXT.check.testEmpty}`, `warn ${TEXT.check.checkEmpty}`, `warn ${TEXT.check.noLevel3}`]) assert.ok(s.includes(want), want)
  assert.equal(check({ cwd: dir }, { log: () => {} }).ok, false)

  dir = fresh()
  edit(dir, ".coteam/pipeline.yml", "mode: record", "moed: record")
  assert.match(states(dir)[0], /^FAIL \.coteam\/pipeline\.yml does not load: /)

  dir = fresh()
  edit(dir, ".github/workflows/pipeline-fix.yml", `engine_ref: ${SHA}`, "engine_ref: v9.9.9")
  edit(dir, ".github/workflows/pipeline-tick.yml", '"CI"]', '"pipeline-tick"]')
  const w = states(dir)
  assert.ok(w.includes(`FAIL ${TEXT.check.refMismatch("pipeline-fix.yml", SHA, "v9.9.9")}`))
  assert.ok(w.includes(`FAIL ${TEXT.check.selfRun}`))
  assert.ok(w.includes(`warn ${TEXT.check.noCi}`))

  const empty = states(checkout({}))
  assert.deepEqual(empty, [`FAIL ${TEXT.check.configMissing}`, ...CALLERS.map((c) => `FAIL ${TEXT.check.missing(c.file)}`)])
})

// ---------- app ----------

test("manifestOf: exactly the access the doctor asks for, no events, private; the name fits GitHub's limit", () => {
  const m = manifestOf({ name: "shop-pipeline", repo: "acme/shop", redirect: "http://127.0.0.1:1/done" })
  assert.deepEqual(m.default_permissions, { metadata: "read", ...NEEDED })
  for (const never of ["workflows", "secrets", "administration"]) assert.ok(!(never in m.default_permissions), never)
  assert.deepEqual([m.public, m.default_events, m.hook_attributes.active, m.redirect_url], [false, [], false, "http://127.0.0.1:1/done"])
  assert.equal(appNameOf("acme/shop"), "shop-pipeline")
  const long = appNameOf(`acme/${"x".repeat(60)}`)
  assert.ok(long.length <= 34 && long.endsWith("-pipeline"), long)
})

// A browser, as far as the installer can tell: it loads the page it is sent to, "presses the
// button" (GitHub would then come back with a code), and follows where it is sent next.
// `seen.done` settles when the browser has its last answer, which may be after the installer returned.
const browser = (seen, opts = {}) => (url) => (seen.done = visit(seen, opts, url))
async function visit(seen, { code = "code-1", state }, url) {
  const page = await (await fetch(url)).text()
  const action = /<form[^>]* action="([^"]+)"/.exec(page)[1].replace(/&amp;/g, "&")
  const manifest = JSON.parse(/name="manifest" value="([^"]+)"/.exec(page)[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"))
  Object.assign(seen, { action, manifest })
  const back = new URL(manifest.redirect_url)
  back.searchParams.set("code", code)
  back.searchParams.set("state", state ?? new URL(action).searchParams.get("state"))
  const r = await fetch(back, { redirect: "manual" })
  Object.assign(seen, { status: r.status, location: r.headers.get("location") })
}

function github({ installedAfter = 0, permissions = NEEDED, convertStatus = 201 } = {}) {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const pem = privateKey.export({ type: "pkcs8", format: "pem" })
  const calls = []
  let asked = 0
  const answer = (status, body) => ({ ok: status < 300, status, json: async () => body })
  const fetchApi = async (url, init = {}) => {
    const path = new URL(url).pathname
    calls.push(`${init.method || "GET"} ${path}`)
    if (path === "/app-manifests/code-1/conversions") return convertStatus === 201 ? answer(201, { id: 4242, slug: "shop-pipeline", pem, html_url: "https://github.com/apps/shop-pipeline", webhook_secret: "w", client_secret: "c" }) : answer(convertStatus, { message: "Not Found" })
    if (path === "/repos/acme/shop/installation") return asked++ < installedAfter ? answer(404, { message: "Not Found" }) : answer(200, { id: 7 })
    if (path === "/app/installations/7/access_tokens") return answer(201, { token: "inst", permissions })
    return answer(500, { message: `unexpected ${path}` })
  }
  return { pem, calls, fetch: fetchApi }
}
const SETTERS = { "secret set": "", "variable set": "" }

test("app: the form GitHub gets, the key straight into the secret, id and login into variables, then the installation is awaited and its access compared", async () => {
  const gh = github({ installedAfter: 2 })
  const { proc, calls } = fakeProc({ ...GH, ...SETTERS })
  const l = logs()
  const seen = {}
  const res = await app({ cwd: checkout({}) }, { proc, fetch: gh.fetch, log: l.log, open: browser(seen), sleep: async () => {} })
  assert.deepEqual(res, { ok: true, repo: "acme/shop", appId: "4242", slug: "shop-pipeline", login: "shop-pipeline[bot]", stored: ["secret PIPELINE_APP_KEY", "variable PIPELINE_APP_ID", "variable PIPELINE_BOT"], installed: true, missing: [] })
  await seen.done
  // an organisation's repository: the App is created under the organisation
  assert.match(seen.action, /^https:\/\/github\.com\/organizations\/acme\/settings\/apps\/new\?state=[0-9a-f]{48}$/)
  assert.deepEqual(seen.manifest, manifestOf({ name: "shop-pipeline", repo: "acme/shop", redirect: seen.manifest.redirect_url }))
  assert.match(seen.manifest.redirect_url, /^http:\/\/127\.0\.0\.1:\d+\/done$/)
  // the browser is sent on to the installation page
  assert.deepEqual([seen.status, seen.location], [302, "https://github.com/apps/shop-pipeline/installations/new"])
  const writes = calls.filter((c) => c.args[0] !== "api" && c.args[0] !== "auth")
  assert.deepEqual(writes.map((c) => c.args.join(" ")), [
    "secret set PIPELINE_APP_KEY --repo acme/shop",
    "variable set PIPELINE_APP_ID --repo acme/shop --body 4242",
    "variable set PIPELINE_BOT --repo acme/shop --body shop-pipeline[bot]",
  ])
  // the key travels on stdin, and is neither printed nor an argument
  assert.equal(writes[0].input, gh.pem)
  assert.ok(!l.text().includes("PRIVATE KEY") && !JSON.stringify(calls.map((c) => c.args)).includes("PRIVATE KEY"))
  assert.deepEqual(gh.calls.filter((c) => c.endsWith("/installation")).length, 3)
  assert.match(l.text(), /App created: shop-pipeline \(App ID 4242\)/)
  assert.ok(l.text().includes(TEXT.app.permsOk))
})

test("app: a personal repository creates the App under the person; a token that lacks access is named", async () => {
  const gh = github({ permissions: { ...NEEDED, actions: "read", checks: undefined } })
  const { proc } = fakeProc({ ...GH, "api repos/acme/shop": { ...REPO_INFO, owner: { login: "acme", type: "User" } }, ...SETTERS })
  const seen = {}
  const l = logs()
  const res = await app({ cwd: tmpdir(), repo: "acme/shop", name: "my bot" }, { proc, fetch: gh.fetch, log: l.log, open: browser(seen), sleep: async () => {} })
  assert.match(seen.action, /^https:\/\/github\.com\/settings\/apps\/new\?state=/)
  assert.equal(seen.manifest.name, "my bot")
  assert.deepEqual([res.ok, res.installed, res.missing], [false, true, ["actions", "checks"]])
  assert.ok(l.text().includes(TEXT.app.permsShort(["actions", "checks"])))
})

test("app: refused before anything is created when the person is no admin, an App is already set up, or gh does not answer", async () => {
  const never = { fetch: async () => assert.fail("GitHub was asked"), open: async () => assert.fail("a browser was opened"), log: () => {} }
  const cwd = checkout({})
  await assert.rejects(app({ cwd }, { ...never, proc: fakeProc({ ...GH, "api repos/acme/shop": { ...REPO_INFO, permissions: { admin: false } } }).proc }), /you are not an admin of acme\/shop/)
  await assert.rejects(app({ cwd }, { ...never, proc: fakeProc({ ...GH, "api repos/acme/shop/actions/variables": { variables: [{ name: "PIPELINE_APP_ID", value: "77" }] } }).proc }), /already has PIPELINE_APP_ID = 77/)
  await assert.rejects(app({ cwd }, { ...never, proc: fakeProc({}).proc }), /gh auth login/)
  await assert.rejects(app({ cwd: checkout({}, "") }, { ...never, proc: fakeProc(GH).proc }), /no GitHub remote/)
})

test("app: a request with another state is ignored; a key that cannot be stored is saved for the person instead of lost; a missing installation is not an error", async () => {
  // a page on the person's machine that guesses the port cannot finish the flow
  const gh = github({ installedAfter: 1e9 })
  const { proc } = fakeProc({ ...GH, "variable set": "", "secret set": { rc: 1, stdout: "", stderr: "HTTP 403: Resource not accessible" } })
  const l = logs()
  const seen = {}
  const forged = {}
  const open = async (url) => {
    await browser(forged, { state: "0".repeat(48) })(url)
    await browser(seen)(url)
  }
  let t = Date.now()
  const now = () => new Date((t += 4 * 60000))
  const res = await app({ cwd: checkout({}) }, { proc, fetch: gh.fetch, log: l.log, open, sleep: async () => {}, now })
  assert.equal(forged.status, 400)
  assert.ok(l.text().includes(TEXT.app.badState))
  assert.equal(gh.calls.filter((c) => c.includes("conversions")).length, 1)
  assert.deepEqual([res.ok, res.installed, res.stored], [false, false, ["variable PIPELINE_APP_ID", "variable PIPELINE_BOT"]])
  const saved = /saved to (\S+\.pem)/.exec(l.text())[1]
  assert.equal(readFileSync(saved, "utf8"), gh.pem)
  assert.ok(!l.text().includes("PRIVATE KEY"))
  assert.match(l.text(), /was not installed on acme\/shop within 10 minutes/)
})

test("app: GitHub refusing the code fails the run and tells the browser", async () => {
  const gh = github({ convertStatus: 404 })
  const seen = {}
  await assert.rejects(app({ cwd: checkout({}) }, { proc: fakeProc({ ...GH, ...SETTERS }).proc, fetch: gh.fetch, log: () => {}, open: browser(seen), sleep: async () => {} }), /GitHub did not hand over the App \(404 Not Found\)/)
  await seen.done
  assert.equal(seen.status, 500)
})

// ---------- the command line ----------

test("main init: scan prints JSON, files and check print lines, an unknown step prints the steps", async () => {
  const run = async (argv, cwd) => {
    const out = []
    const err = []
    const rc = await main(argv, { cwd, env: {}, out: (s) => out.push(s), err: (s) => err.push(s) })
    return { rc, out: out.join("\n"), err: err.join("\n") }
  }
  const dir = checkout({ "go.mod": "module x\n" }, "")
  const s = await run(["init", "scan"], dir)
  assert.equal(s.rc, 0)
  assert.equal(JSON.parse(s.out).stack.kind, "go")
  const f = await run(["init", "files", "--ref", "v1.2.3", "--ci", "CI,Lint", "--base", "dev"], dir)
  assert.equal(f.rc, 0, f.err)
  assert.match(readFileSync(join(dir, ".github/workflows/pipeline-tick.yml"), "utf8"), /"CI", "Lint"\]/)
  assert.match(readFileSync(join(dir, ".github/workflows/pipeline-review.yml"), "utf8"), /engine_ref: v1\.2\.3/)
  const c = await run(["init", "check"], dir)
  assert.equal(c.rc, 0)
  assert.match(c.out, /Ready to commit: 2 ok, 1 warning, 0 failed\./)
  assert.equal((await run(["init", "check"], checkout({}))).rc, 1)
  for (const argv of [["init"], ["init", "frobnicate"]]) {
    const u = await run(argv, dir)
    assert.equal(u.rc, 1)
    assert.match(u.err, /usage: main\.mjs init <step>/)
  }
})

// ---------- the plugin ----------

test("the repository is a Claude Code plugin and its own marketplace: the manifests agree and the skill calls only steps that exist", () => {
  const json = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"))
  const plugin = json(".claude-plugin/plugin.json")
  const market = json(".claude-plugin/marketplace.json")
  const pkg = json("package.json")
  assert.equal(plugin.name, "coteam-pipeline")
  assert.equal(plugin.version, pkg.version)
  assert.equal(plugin.license, "MIT")
  assert.ok(market.owner?.name)
  // installing fails when the marketplace entry and the manifest disagree on the name
  assert.deepEqual(market.plugins.map((p) => [p.name, p.source]), [[plugin.name, "./"]])
  assert.deepEqual(readdirSync(join(ROOT, "skills")), ["init"])

  const skill = readFileSync(join(ROOT, "skills/init/SKILL.md"), "utf8")
  const front = /^---\n([\s\S]*?)\n---\n/.exec(skill)
  assert.ok(front, "front matter")
  assert.match(front[1], /^description: .{40,}$/m)
  // it creates things on GitHub: only a person starts it
  assert.match(front[1], /^disable-model-invocation: true$/m)
  assert.ok(!/[一-鿿]/.test(skill), "English only")
  // the engine is run from the plugin's own copy
  assert.ok(skill.includes('node "${CLAUDE_PLUGIN_ROOT}/cli/main.mjs"'))
  const steps = [...skill.matchAll(/\binit (scan|files|check|app|[a-z-]+)\b(?= |`|$)/gm)].map((m) => m[1])
  for (const step of ["scan", "files", "check", "app"]) assert.ok(steps.includes(step), `the skill never runs init ${step}`)
  const flags = [...skill.matchAll(/`[^`\n]*\binit (?:files|app)\b([^`\n]*)`/g)].flatMap((m) => [...m[1].matchAll(/--([a-z-]+)/g)].map((f) => f[1]))
  for (const flag of flags) assert.ok(TEXT.usage.includes(`--${flag}`), `the skill passes --${flag}, which init does not take`)
  // the things it must never do are said in so many words
  for (const rule of [/never.*`mode: on`|`mode: on`.*never/i, /never merge/i, /never (ask|print|read).*(key|secret)/i, /`record`/]) assert.match(skill, rule)
  // every document it sends the reader to exists
  for (const m of skill.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/((?:docs|templates|presets)\/[\w./-]+)/g)) assert.ok(existsSync(join(ROOT, m[1])), m[1])
})
