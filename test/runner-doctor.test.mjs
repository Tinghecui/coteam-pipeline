import assert from "node:assert/strict"
import { test } from "node:test"
import { checkMachine, RUNNER_TEXT } from "../cli/io/machine.mjs"

const HOME = "/home/runner"
// A machine described by its files and the answers of its programs. Nothing is read for real.
function machine({ files = {}, dirs = {}, env = {}, platform = "linux", uid = 1001, answers = {} } = {}) {
  const asked = []
  const run = (cmd, args, opts = {}) => {
    asked.push([cmd, ...args].join(" "))
    const key = `${cmd} ${args[0]}`
    if (key in answers) {
      const a = answers[key]
      if (a instanceof Error) throw a
      return typeof a === "function" ? a(opts) : a
    }
    if (cmd === "git" && args[0] === "--version") return { rc: 0, stdout: "git version 2.43.0\n", stderr: "" }
    if (cmd === "git" && args[0] === "config") return { rc: 1, stdout: "", stderr: "" }
    if (args[0] === "--version") return { rc: 0, stdout: "2.1.302 (Claude Code)\n", stderr: "" }
    throw new Error(`unexpected ${cmd} ${args.join(" ")}`)
  }
  const read = (p) => {
    if (!(p in files)) throw new Error(`ENOENT ${p}`)
    return files[p]
  }
  const deps = { env, home: HOME, platform, uid, run, exists: (p) => p in files || p in dirs, read, list: (d) => dirs[d] || [] }
  return { deps, asked }
}
const ids = (res) => Object.fromEntries(res.results.map((r) => [r.id, r.state]))

test("a clean machine: git, the CLI and its login are there, and nothing else to read", () => {
  const { deps, asked } = machine({ files: { [`${HOME}/.claude/.credentials.json`]: '{"secret":"never printed"}' } })
  const res = checkMachine(deps)
  assert.deepEqual(ids(res), { git: "ok", cli: "ok", login: "ok", github: "ok" })
  assert.equal(res.ok, true)
  assert.match(res.results[1].text, /the agent CLI "claude" is version 2\.1\.302/)
  assert.ok(!JSON.stringify(res).includes("never printed"), "what a credential file holds is never in the output")
  // without --try the agent is never asked anything
  assert.ok(!asked.some((a) => a.includes("-p")))
})

test("login: from the environment, a config dir of its own, the keychain, or none; --try asks once", () => {
  assert.equal(ids(checkMachine(machine({ env: { CLAUDE_CODE_OAUTH_TOKEN: "t" } }).deps)).login, "info")
  assert.equal(ids(checkMachine(machine({ env: { CLAUDE_CONFIG_DIR: "/srv/cc" }, files: { "/srv/cc/.credentials.json": "{}" } }).deps)).login, "ok")
  assert.equal(ids(checkMachine(machine({ platform: "darwin" }).deps)).login, "warn")
  const none = checkMachine(machine().deps)
  assert.equal(ids(none).login, "FAIL")
  assert.equal(none.ok, false)
  const good = machine({ platform: "darwin", answers: { "claude -p": (opts) => ({ rc: 0, stdout: JSON.stringify({ type: "result", is_error: false, result: opts.input.includes("OK") ? "OK" : "?" }), stderr: "" }) } })
  const tried = checkMachine(good.deps, { tryAgent: true })
  assert.equal(ids(tried)["login.try"], "ok")
  const bad = machine({ platform: "darwin", answers: { "claude -p": { rc: 1, stdout: JSON.stringify({ is_error: true, result: "Invalid API key · Please run /login" }), stderr: "" } } })
  assert.match(checkMachine(bad.deps, { tryAgent: true }).results.find((r) => r.id === "login.try").text, /did not answer a test question: Invalid API key/)
})

test("the CLI: missing or too old fails; PIPELINE_CLAUDE_BIN names another one", () => {
  const missing = machine({ answers: { "claude --version": Object.assign(new Error("spawnSync claude ENOENT"), { code: "ENOENT" }) } })
  assert.equal(ids(checkMachine(missing.deps)).cli, "FAIL")
  const old = machine({ answers: { "claude --version": { rc: 0, stdout: "2.0.9 (Claude Code)", stderr: "" } } })
  assert.match(checkMachine(old.deps).results.find((r) => r.id === "cli").text, /version 2\.0\.9; the engine needs 2\.1\.0/)
  const other = machine({ answers: { "/opt/cc/bin/claude --version": { rc: 0, stdout: "2.2.0", stderr: "" } } })
  assert.match(checkMachine(other.deps, { bin: "/opt/cc/bin/claude" }).results.find((r) => r.id === "cli").text, /"\/opt\/cc\/bin\/claude" is version 2\.2\.0/)
  assert.equal(ids(checkMachine(machine({ answers: { "git --version": { rc: 127, stdout: "", stderr: "" } } }).deps)).git, "FAIL")
})

test("GitHub credentials the agent could use fail; helpers, SSH keys and other credentials warn; names only", () => {
  const files = {
    [`${HOME}/.claude/.credentials.json`]: "{}",
    [`${HOME}/.git-credentials`]: "https://me:ghp_SECRET@github.com\n",
    [`${HOME}/.netrc`]: "machine api.github.com login me password ghp_SECRET\n",
    [`${HOME}/.config/gh/hosts.yml`]: "github.com:\n  user: me\n  oauth_token: gho_SECRET\n",
    [`${HOME}/.aws/credentials`]: "[default]\naws_secret_access_key=SECRET\n",
    [`${HOME}/.npmrc`]: "//registry.npmjs.org/:_authToken=npm_SECRET\n",
    [`${HOME}/.docker/config.json`]: '{"auths":{}}',
  }
  const m = machine({
    files,
    dirs: { [`${HOME}/.ssh`]: ["id_ed25519", "id_ed25519.pub", "known_hosts", "config"] },
    env: { GH_TOKEN: "ghp_SECRET" },
    uid: 0,
    answers: { "git config": { rc: 0, stdout: "credential.helper store\nhttp.https://github.com/.extraheader AUTHORIZATION: basic SECRET\n", stderr: "" } },
  })
  const res = checkMachine(m.deps)
  assert.deepEqual(ids(res), { git: "ok", cli: "ok", login: "ok", "github.env": "FAIL", "github.git-credentials": "FAIL", "github..netrc": "FAIL", "github.gh": "FAIL", "github.header": "FAIL", "github.helper": "warn", "github.ssh": "warn", other: "warn", root: "warn" })
  const out = JSON.stringify(res)
  assert.ok(!/SECRET|basic/.test(out), out)
  assert.match(res.results.find((r) => r.id === "github.ssh").text, /\(id_ed25519\)/)
  assert.match(res.results.find((r) => r.id === "other").text, /~\/\.aws\/credentials, ~\/\.npmrc$/)
  assert.match(res.results.find((r) => r.id === "github.header").text, /http\.https:\/\/github\.com\/\.extraheader/)
  assert.equal(RUNNER_TEXT.summary(res.counts), "Not ready: 3 ok, 4 warnings, 5 failed.")
})

test("--cli codex: the Codex CLI, its login file or key, and its one-question try", () => {
  const codexAnswers = { "codex --version": { rc: 0, stdout: "codex-cli 0.170.0\n", stderr: "" } }
  const clis = [{ cli: "claude", bin: "claude" }, { cli: "codex", bin: "codex" }]
  const both = checkMachine(machine({ files: { [`${HOME}/.claude/.credentials.json`]: "{}", [`${HOME}/.codex/auth.json`]: '{"tokens":"never printed"}' }, answers: codexAnswers }).deps, { clis })
  assert.deepEqual(ids(both), { git: "ok", cli: "ok", login: "ok", "cli.codex": "ok", "login.codex": "ok", github: "ok" })
  assert.ok(!JSON.stringify(both).includes("never printed"))
  // CODEX_HOME elsewhere, or a key in the environment
  assert.equal(ids(checkMachine(machine({ env: { CODEX_HOME: "/srv/cx" }, files: { "/srv/cx/auth.json": "{}" }, answers: codexAnswers }).deps, { clis: [clis[1]] }))["login.codex"], "ok")
  assert.equal(ids(checkMachine(machine({ env: { OPENAI_API_KEY: "k" }, answers: codexAnswers }).deps, { clis: [clis[1]] }))["login.codex"], "info")
  const none = checkMachine(machine({ answers: codexAnswers }).deps, { clis: [clis[1]] })
  assert.equal(ids(none)["login.codex"], "FAIL")
  assert.match(none.results.find((r) => r.id === "login.codex").hint, /codex login/)
  // too old
  const old = checkMachine(machine({ answers: { "codex --version": { rc: 0, stdout: "codex-cli 0.120.3\n", stderr: "" } } }).deps, { clis: [clis[1]] })
  assert.match(old.results.find((r) => r.id === "cli.codex").text, /version 0\.120\.3; the engine needs 0\.162\.0/)
  // --try: one question, answered or not
  const answered = { ...codexAnswers, "codex exec": { rc: 0, stdout: '{"type":"turn.started"}\n{"type":"turn.completed","usage":{}}\n', stderr: "" } }
  assert.equal(ids(checkMachine(machine({ files: { [`${HOME}/.codex/auth.json`]: "{}" }, answers: answered }).deps, { clis: [clis[1]], tryAgent: true }))["login.codex.try"], "ok")
  const refused = { ...codexAnswers, "codex exec": { rc: 1, stdout: '{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit."}}\n', stderr: "" } }
  const r = checkMachine(machine({ files: { [`${HOME}/.codex/auth.json`]: "{}" }, answers: refused }).deps, { clis: [clis[1]], tryAgent: true })
  assert.match(r.results.find((x) => x.id === "login.codex.try").text, /"codex" did not answer a test question: You've hit your usage limit\./)
})
