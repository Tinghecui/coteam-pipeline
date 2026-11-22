// The entry point, and the io modules it wires together (app token, ledger branch, real io).
// Nothing here talks to the network: git works against a bare repository in a temp directory.
import assert from "node:assert/strict"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { createVerify, generateKeyPairSync } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { appJwt, appLogin, mintAppToken } from "../cli/io/app-token.mjs"
import { SCRATCH_PATHS } from "../cli/io/claude.mjs"
import { makeGit } from "../cli/io/git.mjs"
import { makeLedger } from "../cli/io/ledger-io.mjs"
import { botLoginSource, loadRepoConfig, makeIo, MINT_ARGS, MINT_SOURCE, tokenSource } from "../cli/io/real.mjs"
import { main, parseArgs, takeSecrets } from "../cli/main.mjs"

const MAIN = resolve(fileURLToPath(new URL("../cli/main.mjs", import.meta.url)))
const CLI = dirname(MAIN)
const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } }).trim()
const put = (dir, path, text) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), text)
}
// A bare "remote" with one commit on main, and a checkout of it.
function repo(files = { "README.md": "# demo\n" }) {
  const root = mkdtempSync(join(tmpdir(), "main-test-"))
  const remote = join(root, "remote.git")
  const work = join(root, "work")
  sh(root, "init", "-q", "--bare", "-b", "main", remote)
  sh(root, "init", "-q", "-b", "main", work)
  sh(work, "remote", "add", "origin", remote)
  for (const [p, t] of Object.entries(files)) put(work, p, t)
  sh(work, "add", "-A")
  sh(work, "commit", "-q", "-m", "first")
  sh(work, "push", "-q", "origin", "HEAD:main")
  return { root, remote, work }
}
const capture = () => {
  const out = []
  const err = []
  return { out, err, ctx: { out: (s) => out.push(s), err: (s) => err.push(s) } }
}

// ---------- arguments and commands ----------

test("parseArgs: --flag value, --flag=value, bare flags, positionals", () => {
  assert.deepEqual(parseArgs(["fix", "--issue", "12", "--row", "--pr", "--dry"]), { positional: ["fix"], flags: { issue: "12", row: true, pr: true, dry: true } })
  assert.deepEqual(parseArgs(["spec", "check", "a.md", "--x=1"]), { positional: ["spec", "check", "a.md"], flags: { x: "1" } })
})

test("main: usage errors exit 1 without touching anything", async () => {
  for (const [argv, re] of [
    [["fix"], /fix needs --issue/],
    [["fix", "--issue", "abc"], /--issue must be a number/],
    [["fix", "--issue", "--row", "--pr"], /fix needs --issue/],
    [["review"], /review needs --pr/],
    [["frobnicate"], /unknown command: frobnicate/],
    [["spec"], /usage: main\.mjs spec check/],
  ]) {
    const c = capture()
    assert.equal(await main(argv, { ...c.ctx, env: {}, cwd: tmpdir() }), 1)
    assert.match(c.err.join("\n"), re)
  }
  const c = capture()
  assert.equal(await main([], { ...c.ctx, env: {} }), 1)
  assert.match(c.out.join("\n"), /usage: main\.mjs <command>/)
})

test("main: a role needs the environment; without it the run fails with the reason", async () => {
  const c = capture()
  assert.equal(await main(["fix", "--issue", "5"], { ...c.ctx, env: {}, cwd: tmpdir() }), 1)
  assert.match(c.err.join("\n"), /GITHUB_REPOSITORY must be set/)
})

const SPEC = [
  "## Summary",
  "",
  "**Problem**: the list drops its last entry.",
  "",
  "**Cause**: the loop stops one step early.",
  "",
  "**Fix**: let the loop run to the end.",
  "",
  "**Risk and how to verify**: low; open the list and count.",
  "",
  "## Requirement",
  "",
  "Show every entry.",
  "",
  "## Acceptance criteria",
  "",
  "- three entries are shown",
  "",
  "## Decisions",
  "",
  "none",
  "",
  "## Open questions",
  "",
  "none",
  "",
  "## Out of scope",
  "",
  "none",
  "",
  "## Current state",
  "",
  "The loop is in the list module.",
  "",
  "## PR split",
  "",
  "| # | What | Where | Depends on | How to verify |",
  "|---|---|---|---|---|",
  "| 1 | Fix the loop | `src/list.js` | none | count the entries |",
  "",
  "## Risks",
  "",
  "none",
  "",
].join("\n")

test("spec check <file>: works without a token, prints the problems, exit code says the result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "main-test-"))
  put(dir, "good.md", SPEC)
  put(dir, "bad.md", SPEC.replace("| 1 | Fix the loop | `src/list.js` |", "| 1 | Fix the loop | `.github/workflows/ci.yml` |").replace("## Open questions\n\nnone", "## Open questions\n\nWhich colour?"))
  const good = capture()
  assert.equal(await main(["spec", "check", "good.md"], { ...good.ctx, env: {}, cwd: dir }), 0, good.out.join("\n"))
  assert.deepEqual(good.out, ["The spec has no problems."])
  const bad = capture()
  assert.equal(await main(["spec", "check", "bad.md"], { ...bad.ctx, env: {}, cwd: dir }), 1)
  assert.match(bad.out[0], /The spec has 2 problems:/)
  assert.match(bad.out.join("\n"), /Open questions/)
  assert.match(bad.out.join("\n"), /\.github\/workflows\/ci\.yml.*may not touch/)
  // from stdin
  const piped = capture()
  assert.equal(await main(["spec", "check", "-"], { ...piped.ctx, env: {}, cwd: dir, stdin: async () => "just a task" }), 1)
  assert.match(piped.out.join("\n"), /Not a spec issue/)
  // as a real process, with an empty environment
  const r = spawnSync(process.execPath, [MAIN, "spec", "check", "good.md"], { cwd: dir, env: { PATH: process.env.PATH }, encoding: "utf8" })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), "The spec has no problems.")
})

// A `gh` that answers every read with nothing and writes down what it was asked, and
// whether the process that started it (the engine) still has the bot token in the environment
// it was started with.
function fakeGh() {
  const bin = mkdtempSync(join(tmpdir(), "main-test-bin-"))
  const log = join(bin, "gh.log")
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      'echo "$*" >> "$FAKE_GH_LOG"',
      '[ "$GH_TOKEN" = "bot-token-for-test" ] || echo "no-token" >> "$FAKE_GH_LOG"',
      "if [ -r /proc/$PPID/environ ] && tr '\\0' '\\n' < /proc/$PPID/environ | grep -q '^PIPELINE_TOKEN='; then echo exposed >> \"$FAKE_GH_LOG\"; fi",
      'case "$*" in *--slurp*) echo "[[]]" ;; *) echo "{}" ;; esac',
      "",
    ].join("\n"),
  )
  chmodSync(join(bin, "gh"), 0o755)
  return { bin, read: () => (existsSync(log) ? readFileSync(log, "utf8") : ""), env: { PATH: `${bin}:${process.env.PATH}`, FAKE_GH_LOG: log } }
}

test("doctor: runs the installation check (cli/roles/doctor.mjs) with --fix passed on; the bot token does not stay in the process environment", { skip: process.platform === "win32" }, () => {
  const { remote, work, root } = repo({ ".coteam/pipeline.yml": "version: 1\npreset: startup\nmode: record\n" })
  const gh = fakeGh()
  const env = { ...gh.env, HOME: root, PIPELINE_TOKEN: "bot-token-for-test", GITHUB_REPOSITORY: "o/r", PIPELINE_REPO_URL: remote, RUNNER_TEMP: root }
  const r = spawnSync(process.execPath, [MAIN, "doctor"], { cwd: work, env, encoding: "utf8" })
  assert.match(r.stdout, /^Pipeline doctor for o\/r$/m, r.stderr)
  assert.match(r.stdout, /^ok {4}\.coteam\/pipeline\.yml loads \(mode record, base main\)$/m)
  // the fake repository has no labels: that fails, and nothing was written
  assert.match(r.stdout, /^FAIL {2}10 labels are missing: pipeline, /m)
  assert.match(r.stdout, /^Not ready: /m)
  assert.equal(r.status, 1)
  assert.ok(!r.stdout.includes("{\"ok\""), "the doctor prints its lines, not a JSON summary")
  assert.ok(!(r.stdout + r.stderr).includes("bot-token-for-test"))
  const asked = gh.read()
  assert.match(asked, /^api --paginate --slurp repos\/o\/r\/labels\?per_page=100$/m)
  assert.ok(!/-X (POST|PATCH|PUT|DELETE)/.test(asked), asked)
  assert.ok(!asked.includes("no-token"), "gh is given the token in its own environment")
  if (typeof process.execve === "function" && process.platform === "linux") {
    assert.ok(!asked.includes("exposed"), "the engine re-executed itself without the token")
    // the hand-over file is gone
    assert.deepEqual(execFileSync("find", [root, "-name", "secrets.json"], { encoding: "utf8" }), "")
    // where the process cannot replace itself, the token stays where it was put
    const kept = fakeGh()
    spawnSync(process.execPath, [MAIN, "doctor"], { cwd: work, env: { ...env, ...kept.env, PIPELINE_NO_REEXEC: "1" }, encoding: "utf8" })
    assert.ok(kept.read().includes("exposed"))
  }

  // --fix reaches the role: the missing labels are created
  const fixing = fakeGh()
  const f = spawnSync(process.execPath, [MAIN, "doctor", "--fix"], { cwd: work, env: { ...env, ...fixing.env }, encoding: "utf8" })
  assert.match(f.stdout, /^ok {4}created 10 labels: pipeline, /m, f.stderr)
  assert.equal((fixing.read().match(/^api -X POST repos\/o\/r\/labels --input -$/gm) || []).length, 10)
})

test("doctor: a config that is missing or does not load is a line of the report; every other role stops there with the reason", { skip: process.platform === "win32" }, () => {
  const run = (dir, remote, cmd) => {
    const gh = fakeGh()
    const r = spawnSync(process.execPath, [MAIN, ...cmd], { cwd: dir, env: { ...gh.env, HOME: dir, PIPELINE_TOKEN: "bot-token-for-test", GITHUB_REPOSITORY: "o/r", PIPELINE_REPO_URL: remote, RUNNER_TEMP: dir }, encoding: "utf8" })
    return { ...r, asked: gh.read() }
  }
  const broken = repo({ ".coteam/pipeline.yml": "version: 1\nmode: sometimes\n" })
  const b = run(broken.work, broken.remote, ["doctor"])
  assert.equal(b.status, 1)
  assert.match(b.stdout, /^FAIL {2}\.coteam\/pipeline\.yml does not load: Invalid pipeline config/m, b.stderr)
  // the other checks went on, with the defaults
  assert.match(b.stdout, /^FAIL {2}stack\.test is empty/m)
  assert.match(b.stdout, /labels are missing/)
  const none = repo()
  const n = run(none.work, none.remote, ["doctor"])
  assert.match(n.stdout, /^FAIL {2}\.coteam\/pipeline\.yml does not load: no \.coteam\/pipeline\.yml on branch "main"$/m, n.stderr)

  for (const cmd of [["tick"], ["fix", "--issue", "5"], ["review", "--pr", "7"]]) {
    const t = run(broken.work, broken.remote, cmd)
    assert.equal(t.status, 1, cmd.join(" "))
    assert.match(t.stderr, /Invalid pipeline config/)
    assert.equal(t.asked, "", "nothing was asked of GitHub")
  }
  // without a repository or a token there is nothing the doctor could look at
  const c = capture()
  return main(["doctor"], { ...c.ctx, env: { GITHUB_REPOSITORY: "o/r" }, cwd: broken.work }).then((rc) => {
    assert.equal(rc, 1)
    assert.match(c.err.join("\n"), /no bot token: set PIPELINE_TOKEN, or PIPELINE_APP_ID and PIPELINE_APP_KEY/)
  })
})

test("takeSecrets: reads the hand-over file once and deletes it", () => {
  const dir = mkdtempSync(join(tmpdir(), "main-test-"))
  const file = join(dir, "s.json")
  writeFileSync(file, JSON.stringify({ PIPELINE_TOKEN: "t" }))
  assert.deepEqual(takeSecrets({ A: "1", PIPELINE_SECRETS_FILE: file }), { A: "1", PIPELINE_TOKEN: "t" })
  assert.equal(existsSync(file), false)
  assert.deepEqual(takeSecrets({ A: "1" }), { A: "1" })
})

// ---------- app token ----------

test("app token: a signed JWT, then an installation token for the one repository", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const pem = privateKey.export({ type: "pkcs8", format: "pem" })
  const now = new Date("2026-11-15T12:00:00Z")
  const jwt = appJwt({ appId: 123, pem, now })
  const [h, p, sig] = jwt.split(".")
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url")), { alg: "RS256", typ: "JWT" })
  const t = Math.floor(now.getTime() / 1000)
  assert.deepEqual(JSON.parse(Buffer.from(p, "base64url")), { iat: t - 60, exp: t + 540, iss: "123" })
  assert.ok(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, "base64url")))
  assert.throws(() => appJwt({ appId: "x", pem }), /app id must be a number/)
  assert.throws(() => appJwt({ appId: 1, pem: "nothing" }), /not a PEM private key/)

  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.authorization, body: init.body })
    if (url.endsWith("/repos/o/r/installation")) return { ok: true, json: async () => ({ id: 9 }) }
    return { ok: true, json: async () => ({ token: "inst-token", permissions: { contents: "write", metadata: "read" } }) }
  }
  // the token, and what GitHub says it may do
  assert.deepEqual(await mintAppToken({ appId: 123, pem, repo: "o/r", fetch, now, apiUrl: "https://api.example.invalid/" }), { token: "inst-token", permissions: { contents: "write", metadata: "read" } })
  const bare = async (url) => ({ ok: true, json: async () => (url.endsWith("/installation") ? { id: 9 } : { token: "t", permissions: "all" }) })
  assert.deepEqual(await mintAppToken({ appId: 123, pem, repo: "o/r", fetch: bare, now }), { token: "t", permissions: {} })
  assert.deepEqual(calls.map((c) => [c.method, c.url, c.body]), [
    ["GET", "https://api.example.invalid/repos/o/r/installation", undefined],
    ["POST", "https://api.example.invalid/app/installations/9/access_tokens", '{"repositories":["r"]}'],
  ])
  assert.equal(calls[0].auth, `Bearer ${jwt}`)
  await assert.rejects(mintAppToken({ appId: 123, pem, repo: "o/r", now, fetch: async () => ({ ok: false, status: 404, json: async () => ({ message: "Not Found" }) }) }), /-> 404 Not Found/)
  await assert.rejects(mintAppToken({ appId: 123, pem, repo: "not a repo", fetch }), /owner\/name/)

  // the login the app writes under: its slug, read as the app itself
  const asked = []
  const app = (body, ok = true) => async (url, init) => {
    asked.push([init.method, url, init.headers.authorization])
    return { ok, status: ok ? 200 : 401, json: async () => body }
  }
  assert.equal(await appLogin({ appId: 123, pem, now, apiUrl: "https://api.example.invalid", fetch: app({ slug: "acme-pipeline" }) }), "acme-pipeline[bot]")
  assert.deepEqual(asked, [["GET", "https://api.example.invalid/app", `Bearer ${jwt}`]])
  await assert.rejects(appLogin({ appId: 123, pem, now, fetch: app({}) }), /carried no slug/)
  await assert.rejects(appLogin({ appId: 123, pem, now, fetch: app({ slug: "a b<!--" }) }), /carried no slug/)
  await assert.rejects(appLogin({ appId: 123, pem, now, fetch: app({ message: "Bad credentials" }, false) }), /GET \/app -> 401 Bad credentials/)
})

test("app-token command: the token alone, or with --login the app's login on a second line; a login that cannot be read is not an error", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const pem = privateKey.export({ type: "pkcs8", format: "pem" })
  const real = globalThis.fetch
  let slug = { ok: true, status: 200, json: async () => ({ slug: "acme-pipeline" }) }
  globalThis.fetch = async (url) => {
    if (url.endsWith("/repos/o/r/installation")) return { ok: true, json: async () => ({ id: 9 }) }
    if (url.endsWith("/access_tokens")) return { ok: true, json: async () => ({ token: "inst-token" }) }
    if (url.endsWith("/app")) return slug
    throw new Error(`unexpected ${url}`)
  }
  try {
    const call = async (argv) => {
      const out = []
      const err = []
      const rc = await main(argv, { env: { GITHUB_API_URL: "https://api.example.invalid" }, out: (s) => out.push(s), err: (s) => err.push(s), stdin: async () => pem })
      return { rc, out: out.join("\n"), err: err.join("\n") }
    }
    assert.deepEqual(await call(["app-token", "123", "o/r"]), { rc: 0, out: "inst-token", err: "" })
    assert.deepEqual(await call(["app-token", "123", "o/r", "--login"]), { rc: 0, out: "inst-token\nacme-pipeline[bot]", err: "" })
    slug = { ok: false, status: 403, json: async () => ({ message: "Forbidden" }) }
    const blind = await call(["app-token", "123", "o/r", "--login"])
    assert.deepEqual([blind.rc, blind.out], [0, "inst-token\n"])
    assert.match(blind.err, /the app's login could not be read \(app-token: GET \/app -> 403 Forbidden\)/)
  } finally {
    globalThis.fetch = real
  }
})

const answer = (o) => ({ rc: 0, stdout: `${JSON.stringify(o)}\n`, stderr: "" })

test("tokenSource: a given token as is; an app token is minted by a child that runs source text held in memory, and renewed after 40 minutes", () => {
  const given = tokenSource({ env: { PIPELINE_TOKEN: "given" }, repo: "o/r" })
  assert.deepEqual([given(), given.app, given.login(), given.permissions()], ["given", false, "", null])
  assert.throws(() => tokenSource({ env: {}, repo: "o/r" }), /no bot token/)
  let t = Date.parse("2026-11-15T12:00:00Z")
  const calls = []
  const runProc = (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    const q = JSON.parse(opts.input)
    return answer({ token: `minted-${calls.length}`, permissions: { contents: "write", n: calls.length }, login: q.login ? "acme-pipeline[bot]" : "" })
  }
  const env = { PIPELINE_APP_ID: "7", PIPELINE_APP_KEY: "-----BEGIN PRIVATE KEY-----\\nk3yb0dyk3yb0dy\\n-----END PRIVATE KEY-----", PATH: "/bin", HOME: "/home/x", GITHUB_API_URL: "https://ghe.example.invalid/api/v3", ANTHROPIC_API_KEY: "k", NODE_OPTIONS: "--require /tmp/x.js" }
  const token = tokenSource({ env, repo: "o/r", now: () => new Date(t), runProc })
  assert.equal(calls.length, 0)
  assert.equal(token(), "minted-1")
  t += 39 * 60000
  assert.equal(token(), "minted-1")
  t += 2 * 60000
  assert.equal(token(), "minted-2")
  assert.equal(calls.length, 2)
  // the app's login is asked for with the first token only, and kept; the permissions are the newest token's
  assert.deepEqual(calls.map((c) => JSON.parse(c.opts.input).login), [true, false])
  assert.deepEqual([token.app, token.login(), token.permissions()], [true, "acme-pipeline[bot]", { contents: "write", n: 2 }])
  assert.equal(calls.length, 2)

  // What the child runs: node itself, with the program as text. No argument is a file, least
  // of all one in the engine's checkout, which the agent may have rewritten by the time of a renewal.
  for (const c of calls) {
    assert.equal(c.cmd, process.execPath)
    assert.deepEqual(c.args, [...MINT_ARGS, MINT_SOURCE])
    assert.deepEqual(c.args.slice(0, 2), ["--input-type=module", "-e"])
    assert.deepEqual(c.args.filter((a) => existsSync(a) || /\.m?js$/.test(a)), [])
    assert.notEqual(resolve(c.opts.cwd), resolve(CLI, ".."), "not started in the engine's checkout")
    // the key and the request go in on stdin, with real line breaks; nothing of them on the command line or in the environment
    assert.deepEqual(JSON.parse(c.opts.input), { appId: "7", repo: "o/r", pem: "-----BEGIN PRIVATE KEY-----\nk3yb0dyk3yb0dy\n-----END PRIVATE KEY-----", login: c === calls[0], apiUrl: "https://ghe.example.invalid/api/v3" })
    assert.ok(!JSON.stringify([c.args, c.opts.env]).includes("k3yb0dy"))
    assert.deepEqual(c.opts.env, { PATH: "/bin", HOME: "/home/x" }, "no NODE_OPTIONS, no credential")
  }
  // the text is the one given when the source was built (by default: read when the module was loaded)
  const seen = []
  tokenSource({ env, repo: "o/r", source: "the program", runProc: (cmd, args) => (seen.push(args), answer({ token: "t" })) })()
  assert.deepEqual(seen, [["--input-type=module", "-e", "the program"]])

  const failing = tokenSource({ env: { PIPELINE_APP_ID: "7", PIPELINE_APP_KEY: "k" }, repo: "o/r", runProc: () => ({ rc: 1, stdout: "", stderr: "app-token: GET ... -> 401" }) })
  assert.throws(() => failing(), /could not mint the bot token: app-token: GET/)
  for (const stdout of ["", "not json", "{}", '{"token":""}', '{"token":5}']) {
    const odd = tokenSource({ env: { PIPELINE_APP_ID: "7", PIPELINE_APP_KEY: "k" }, repo: "o/r", runProc: () => ({ rc: 0, stdout, stderr: "" }) })
    assert.throws(() => odd(), /could not mint the bot token: exit 0/, stdout)
  }
  // asking for the login or the permissions mints the first token; a login that is not "<slug>[bot]" is not taken for one
  const fresh = tokenSource({ env: { PIPELINE_APP_ID: "7", PIPELINE_APP_KEY: "k" }, repo: "o/r", runProc: () => answer({ token: "tok", login: "acme[bot]", permissions: { issues: "write" } }) })
  assert.deepEqual([fresh.login(), fresh(), fresh.permissions()], ["acme[bot]", "tok", { issues: "write" }])
  const asked = tokenSource({ env: { PIPELINE_APP_ID: "7", PIPELINE_APP_KEY: "k" }, repo: "o/r", runProc: () => answer({ token: "tok", permissions: { issues: "write" } }) })
  assert.deepEqual(asked.permissions(), { issues: "write" })
  for (const login of [undefined, "", "warning: something", "mallory", 5]) {
    const blind = tokenSource({ env: { PIPELINE_APP_ID: "7", PIPELINE_APP_KEY: "k" }, repo: "o/r", runProc: () => answer({ token: "tok", login, permissions: "all" }) })
    assert.deepEqual([blind(), blind.login(), blind.permissions()], ["tok", "", null], JSON.stringify(login))
  }
})

// The same child for real: started the way tokenSource starts it, against a local server
// standing in for the API.
test("the token child: the in-memory program trades the key for a token, the app's login and the token's permissions", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const pem = privateKey.export({ type: "pkcs8", format: "pem" })
  const seen = []
  let refuse = false
  const server = createServer((req, res) => {
    seen.push([req.method, req.url, req.headers.authorization || ""])
    const send = (code, body) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body))
    if (refuse) return send(401, { message: "Bad credentials" })
    if (req.url === "/repos/o/r/installation") return send(200, { id: 9 })
    if (req.url === "/app/installations/9/access_tokens") return send(201, { token: "inst-token", permissions: { contents: "write", issues: "write", metadata: "read" } })
    if (req.url === "/app") return send(200, { slug: "acme-pipeline" })
    return send(404, { message: "Not Found" })
  })
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  const apiUrl = `http://127.0.0.1:${server.address().port}`
  const child = (request) =>
    new Promise((done, fail) => {
      // an empty directory as cwd and a bare environment: the program needs nothing from the engine's checkout
      const c = spawn(process.execPath, [...MINT_ARGS, MINT_SOURCE], { cwd: mkdtempSync(join(tmpdir(), "main-test-")), env: { PATH: process.env.PATH }, stdio: ["pipe", "pipe", "pipe"] })
      let [out, err] = ["", ""]
      c.stdout.on("data", (d) => (out += d))
      c.stderr.on("data", (d) => (err += d))
      c.on("error", fail)
      c.on("close", (rc) => done({ rc, out, err }))
      c.stdin.end(JSON.stringify(request))
    })
  try {
    const r = await child({ appId: "123", repo: "o/r", pem, login: true, apiUrl })
    assert.equal(r.rc, 0, r.err)
    assert.deepEqual(JSON.parse(r.out), { token: "inst-token", permissions: { contents: "write", issues: "write", metadata: "read" }, login: "acme-pipeline[bot]" })
    assert.deepEqual(seen.map((x) => x.slice(0, 2)), [["GET", "/repos/o/r/installation"], ["POST", "/app/installations/9/access_tokens"], ["GET", "/app"]])
    // signed with the key that came in on stdin
    const [h, p, sig] = seen[0][2].replace(/^Bearer /, "").split(".")
    assert.ok(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, "base64url")))
    seen.length = 0
    assert.deepEqual(JSON.parse((await child({ appId: "123", repo: "o/r", pem, login: false, apiUrl })).out).login, "")
    assert.equal(seen.length, 2, "the login is not asked for again")
    refuse = true
    const bad = await child({ appId: "123", repo: "o/r", pem, login: true, apiUrl })
    assert.equal(bad.rc, 1)
    assert.equal(bad.out, "")
    assert.match(bad.err, /^app-token: GET \/repos\/o\/r\/installation -> 401 Bad credentials$/m)
    assert.ok(!bad.err.includes("PRIVATE KEY"))
  } finally {
    server.close()
  }
})

// ---------- nothing is loaded from the engine's checkout after the agent has run ----------

const cliFiles = (dir = CLI) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? cliFiles(join(dir, e.name)) : e.name.endsWith(".mjs") ? [join(dir, e.name)] : []))
// A file's code without its comment lines.
const codeOf = (file) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n")

test("the engine loads all of its code before any role runs: no dynamic import, no require, every module reachable from main.mjs by static imports", () => {
  const files = cliFiles()
  assert.ok(files.length >= 20 && files.includes(join(CLI, "roles/fix.mjs")) && files.includes(join(CLI, "io/app-token.mjs")))
  for (const f of files) {
    const code = codeOf(f)
    assert.ok(!/\bimport\s*\(/.test(code), `${f}: a dynamic import() loads code when it is reached, which may be after the agent ran`)
    assert.ok(!/\brequire\s*\(|createRequire|\bimport\.meta\.resolve\b/.test(code), `${f}: require`)
    assert.ok(!/node:(vm|worker_threads|module)\b/.test(code), `${f}: another way to load code`)
  }
  const seen = new Set()
  const walk = (file) => {
    if (seen.has(file)) return
    seen.add(file)
    for (const m of readFileSync(file, "utf8").matchAll(/^(?:import|export) [^"\n]*? from "(\.[^"]+)"$/gm)) walk(resolve(dirname(file), m[1]))
  }
  walk(MAIN)
  assert.deepEqual(files.filter((f) => !seen.has(f)), [], "modules that main.mjs does not import up front")
})

test("no child process is started from a file of the engine; the token program is self-contained", () => {
  // Outside import lines, the engine's code names its own files in two places only: the text
  // of app-token.mjs read when real.mjs is loaded, and usage messages.
  const named = cliFiles().flatMap((f) =>
    codeOf(f)
      .split("\n")
      .filter((l) => /\.mjs\b/.test(l) && !/^(import|export) .* from "/.test(l) && !/usage: main\.mjs/i.test(l))
      .map((l) => `${f.slice(CLI.length + 1)}: ${l.trim()}`),
  )
  assert.deepEqual(named, ['io/real.mjs: export const MINT_SOURCE = `${readFileSync(new URL("./app-token.mjs", import.meta.url), "utf8")}\\n${MINT_DRIVER}`'])
  // ... and that text was taken when the module was loaded: it starts with the file as it is now
  const file = readFileSync(join(CLI, "io/app-token.mjs"), "utf8")
  assert.ok(MINT_SOURCE.startsWith(file))
  // it runs under `node -e`, where a relative import would be resolved against the working directory
  const imports = [...MINT_SOURCE.matchAll(/^\s*import\s[^\n]*?from\s+"([^"]+)"/gm)].map((m) => m[1])
  assert.deepEqual(imports, ["node:crypto"])
  assert.ok(!/\bimport\s*\(/.test(MINT_SOURCE))
  // the only use of the engine's own path for starting a process is the re-execution at the
  // very start of main.mjs, before any role (and so any agent) has run
  const main = codeOf(MAIN)
  assert.equal((main.match(/import\.meta\.url/g) || []).length, 3)
  assert.ok(main.indexOf("process.execve(") > 0 && main.indexOf("process.execve(") < main.indexOf("async function role("))
})

test("botLoginSource: the account the token writes as (an app's slug, or GET /user), plus PIPELINE_BOT; not known is \"\", never an error", () => {
  const asked = []
  const gh = (answer) => ({
    get: (path) => {
      asked.push(path)
      if (answer instanceof Error) throw answer
      return answer
    },
  })
  const plain = Object.assign(() => "t", { app: false, login: () => "" })
  const app = (login) => Object.assign(() => "t", { app: true, login: typeof login === "function" ? login : () => login })
  // a plain token: its user, asked once
  const user = botLoginSource({ env: {}, token: plain, gh: gh({ login: "pipeline-bot" }) })
  assert.deepEqual([user(), user(), asked], ["pipeline-bot", "pipeline-bot", ["/user"]])
  // an app: "<slug>[bot]" from the minting, and /user is never asked (an installation token has no user)
  asked.length = 0
  assert.equal(botLoginSource({ env: {}, token: app("acme-pipeline[bot]"), gh: gh(new Error("403")) })(), "acme-pipeline[bot]")
  assert.deepEqual(asked, [])

  // PIPELINE_BOT that names the account: nothing to add, nothing to say
  const logs = []
  const log = (l) => logs.push(l)
  assert.equal(botLoginSource({ env: { PIPELINE_BOT: " Acme-Pipeline[bot] " }, token: app("acme-pipeline[bot]"), gh: gh({}), log })(), "Acme-Pipeline[bot]")
  assert.deepEqual(logs, [])
  // PIPELINE_BOT that names other accounts (an earlier bot, or a typo): they count, and so does
  // the account the pipeline really writes as. A pipeline that does not believe its own marks
  // repeats every comment and every decision item on every round.
  assert.equal(botLoginSource({ env: { PIPELINE_BOT: "old-bot, acme-pipline[bot]" }, token: app("acme-pipeline[bot]"), gh: gh({}), log })(), "old-bot,acme-pipline[bot],acme-pipeline[bot]")
  assert.match(logs[0], /warning: PIPELINE_BOT is "old-bot, acme-pipline\[bot\]" but the pipeline writes as "acme-pipeline\[bot\]"/)
  assert.equal(botLoginSource({ env: { PIPELINE_BOT: "typo" }, token: plain, gh: gh({ login: "pipeline-bot" }), log })(), "typo,pipeline-bot")
  assert.equal(logs.length, 2)
  // the account cannot be worked out: PIPELINE_BOT is what there is, used as given, and that is not worth a log line
  assert.equal(botLoginSource({ env: { PIPELINE_BOT: "a, b" }, token: plain, gh: gh(new Error("HTTP 403")), log })(), "a,b")
  assert.equal(botLoginSource({ env: { PIPELINE_BOT: "a" }, token: app(""), gh: gh({}), log })(), "a")
  assert.equal(logs.length, 2)

  // not known at all: "", said in the log, asked only once
  asked.length = 0
  logs.length = 0
  const none = botLoginSource({ env: {}, token: plain, gh: gh(new Error("gh api failed (1): HTTP 403\nmore")), log })
  assert.deepEqual([none(), none(), asked.length, logs.length], ["", "", 1, 1])
  assert.match(logs[0], /own login is not known: GET \/user failed \(gh api failed \(1\): HTTP 403\); set PIPELINE_BOT/)
  assert.equal(botLoginSource({ env: {}, token: app(""), gh: gh({ login: "x" }) })(), "")
  assert.equal(botLoginSource({ env: {}, token: app(() => { throw new Error("could not mint") }), gh: gh({ login: "x" }), log })(), "")
  assert.match(logs[1], /own login is not known: could not mint; set PIPELINE_BOT/)
})

// ---------- ledger branch ----------

test("ledger: empty before the first entry, appended as commits on pipeline/ledger, retried after a lost race", () => {
  const { remote, work, root } = repo()
  const git = makeGit({ repo: "o/r", token: "", cwd: work, url: remote })
  const ledger = makeLedger({ git, sleep: () => {} })
  assert.equal(ledger.tip(), "")
  assert.deepEqual(ledger.read(), [])
  ledger.append({ at: "2026-11-15T12:00:00Z", role: "executor", issue: 5, outcome: "pr", usd: 1 })
  ledger.append({ at: "2026-11-15T12:05:00Z", role: "reviewer", issue: 5, outcome: "approve", usd: 0.2 })
  assert.deepEqual(ledger.read().map((e) => e.outcome), ["pr", "approve"])
  assert.equal(sh(root, "--git-dir", remote, "rev-list", "--count", "pipeline/ledger"), "2")
  assert.equal(sh(root, "--git-dir", remote, "ls-tree", "--name-only", "pipeline/ledger"), "ledger.jsonl")
  // the checkout's own branch and files are untouched
  assert.equal(sh(work, "status", "--porcelain"), "")
  assert.equal(sh(work, "rev-parse", "--abbrev-ref", "HEAD"), "main")

  // another run writes between our fetch and our push: the push is refused, we fetch again and both entries survive
  const other = makeLedger({ git: makeGit({ repo: "o/r", token: "", cwd: work, url: remote }), sleep: () => {} })
  let raced = false
  const slept = []
  const racing = makeLedger({
    git: {
      ...git,
      tryRemote: (args, opts) => {
        if (args[0] === "push" && !raced) {
          raced = true
          other.append({ at: "2026-11-15T12:06:00Z", role: "executor", issue: 6, outcome: "failed" })
        }
        return git.tryRemote(args, opts)
      },
    },
    sleep: (ms) => slept.push(ms),
  })
  racing.append({ at: "2026-11-15T12:07:00Z", role: "executor", issue: 7, outcome: "pr" })
  assert.deepEqual(ledger.read().map((e) => e.issue), [5, 5, 6, 7])
  assert.deepEqual(slept, [5000])
  assert.throws(() => ledger.append("not an object"), /JSON object/)
})

test("ledger: a remote that cannot be reached is an error, never 'no ledger yet'", () => {
  const { work, root } = repo()
  const gone = makeLedger({ git: makeGit({ repo: "o/r", token: "", cwd: work, url: join(root, "no-such-remote.git") }), sleep: () => {}, attempts: 2 })
  assert.throws(() => gone.read(), /ledger: cannot reach the remote/)
  assert.throws(() => gone.append({ outcome: "pr" }), /not recorded after 2 attempts: ledger: cannot reach the remote/)
})

// ---------- real io ----------

test("makeIo: config comes from the base branch (with its preset), not from the working tree", async () => {
  const { remote, work } = repo({ ".coteam/pipeline.yml": "version: 1\npreset: startup\nmode: on\nlimits:\n  daily_usd: 7\n" })
  // the working tree (think: a pull request head) says something else
  put(work, ".coteam/pipeline.yml", "version: 1\nmode: on\nrisk:\n  forbidden: []\nlimits:\n  daily_usd: 9999\n")
  const logs = []
  const io = makeIo({ env: { GITHUB_REPOSITORY: "o/r", PIPELINE_TOKEN: "t", PIPELINE_REPO_URL: remote, GITHUB_RUN_ID: "3", RUNNER_TEMP: mkdtempSync(join(tmpdir(), "main-test-")) }, cwd: work, log: (l) => logs.push(l) })
  assert.equal(io.config.limits.daily_usd, 7)
  assert.equal(io.config.mode, "on")
  // the preset named by the base branch filled in what the file left out
  assert.ok(io.config.models.executor)
  assert.equal(io.config.merge.auto_max_level, 1)
  assert.equal(io.repoDir, work)
  assert.ok(existsSync(join(io.home, "prompts/executor.md")))
  assert.match(io.nonce(), /^[0-9a-f]{12}$/)
  assert.notEqual(io.nonce(), io.nonce())
  assert.ok(io.now() instanceof Date)
  for (const k of ["get", "list", "post", "patch", "put", "del", "graphql", "dispatch"]) assert.equal(typeof io.gh[k], "function")
  // the pipeline's own login: worked out on first use (nothing was asked to build io), here simply given
  assert.equal(Object.getOwnPropertyDescriptor(io, "botLogin").value, undefined)
  assert.equal(typeof Object.getOwnPropertyDescriptor(io, "botLogin").get, "function")
  assert.equal(io.gh.repo, "o/r")
  assert.deepEqual(io.claude.scratch, SCRATCH_PATHS)
  assert.deepEqual(io.ledger.read(), [])
  assert.equal(io.makeGit({ cwd: work }).git(["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "main")
  // shell lines from the config do not see the tokens
  const r = io.proc.shell('echo "[${PIPELINE_TOKEN:-none}] [${GITHUB_REPOSITORY:-none}]"', { cwd: work })
  assert.equal(r.stdout.trim(), "[none] [none]")
  const dir = io.fs.mkdtemp("x-")
  io.fs.write(join(dir, "a/b.txt"), "hello")
  assert.equal(io.fs.read(join(dir, "a/b.txt")), "hello")
  assert.equal(io.fs.exists(join(dir, "nope")), false)

  // a plain token does not say what it may do
  assert.equal(io.tokenPermissions, null)
  assert.ok(!("configError" in io))

  assert.throws(() => makeIo({ env: { PIPELINE_TOKEN: "t" }, cwd: work }), /GITHUB_REPOSITORY must be set/)
  assert.throws(() => makeIo({ env: { GITHUB_REPOSITORY: "o/r" }, cwd: work }), /no bot token/)
  // the doctor's io still needs both
  assert.throws(() => makeIo({ env: { PIPELINE_TOKEN: "t" }, cwd: work, tolerateConfig: true }), /GITHUB_REPOSITORY must be set/)
  assert.throws(() => makeIo({ env: { GITHUB_REPOSITORY: "o/r" }, cwd: work, tolerateConfig: true }), /no bot token/)
})

test("makeIo: a config that does not load stops every role; for the doctor it is io.config = null with the reason", () => {
  const env = (remote) => ({ GITHUB_REPOSITORY: "o/r", PIPELINE_TOKEN: "t", PIPELINE_REPO_URL: remote, RUNNER_TEMP: mkdtempSync(join(tmpdir(), "main-test-")) })
  const bad = repo({ ".coteam/pipeline.yml": "version: 1\nmode: sometimes\n" })
  assert.throws(() => makeIo({ env: env(bad.remote), cwd: bad.work }), /Invalid pipeline config/)
  const io = makeIo({ env: env(bad.remote), cwd: bad.work, tolerateConfig: true })
  assert.equal(io.config, null)
  assert.match(io.configError, /Invalid pipeline config[\s\S]*mode/)
  assert.equal(typeof io.gh.get, "function")
  const none = repo()
  assert.throws(() => makeIo({ env: env(none.remote), cwd: none.work }), /no \.coteam\/pipeline\.yml on branch "main"/)
  const missing = makeIo({ env: env(none.remote), cwd: none.work, tolerateConfig: true })
  assert.deepEqual([missing.config, missing.configError], [null, 'no .coteam/pipeline.yml on branch "main"'])
  // a config that loads is the same either way
  const good = repo({ ".coteam/pipeline.yml": "version: 1\npreset: startup\n" })
  const fine = makeIo({ env: env(good.remote), cwd: good.work, tolerateConfig: true })
  assert.equal(fine.config.mode, "record")
  assert.ok(!("configError" in fine))
})

test("makeIo: with an app's id and key the token comes from the real child; a key that cannot sign is reported before GitHub is asked anything", () => {
  const good = repo({ ".coteam/pipeline.yml": "version: 1\npreset: startup\n" })
  assert.throws(() => makeIo({ env: { GITHUB_REPOSITORY: "o/r", PIPELINE_APP_ID: "1", PIPELINE_APP_KEY: "not a key", PATH: process.env.PATH, PIPELINE_REPO_URL: good.remote, GITHUB_API_URL: "http://127.0.0.1:9" }, cwd: good.work }), /could not mint the bot token: app-token: the key is not a PEM private key/)
})

test("loadRepoConfig: a missing or invalid config on the base branch is an error", () => {
  const none = repo()
  assert.throws(() => loadRepoConfig({ git: makeGit({ repo: "o/r", token: "", cwd: none.work, url: none.remote }) }), /no \.coteam\/pipeline\.yml on branch "main"/)
  const bad = repo({ ".coteam/pipeline.yml": "version: 1\nmode: sometimes\n" })
  assert.throws(() => loadRepoConfig({ git: makeGit({ repo: "o/r", token: "", cwd: bad.work, url: bad.remote }) }), /Invalid pipeline config/)
})
