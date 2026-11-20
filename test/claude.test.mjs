import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { agentEnv, claudeArgs, claudeResult, parseStream, runClaude, structuredOutput } from "../cli/io/claude.mjs"

const result = (over = {}) => ({ type: "result", subtype: "success", is_error: false, num_turns: 12, total_cost_usd: 1.234, modelUsage: { "model-a": {} }, ...over })

test("agentEnv: no code-host, CI or pipeline variable reaches the agent", () => {
  const env = agentEnv({
    PATH: "/usr/bin",
    HOME: "/home/x",
    LANG: "C.UTF-8",
    CI: "true",
    GITHUB_TOKEN: "t1",
    GITHUB_STEP_SUMMARY: "/tmp/summary",
    GITHUB_REPOSITORY: "o/r",
    ACTIONS_RUNTIME_TOKEN: "t2",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid",
    GH_TOKEN: "t3",
    GH_HOST: "example.invalid",
    PIPELINE_TOKEN: "t4",
    PIPELINE_APP_ID: "1",
    PIPELINE_APP_KEY: "pem",
    NPM_TOKEN: "t5",
    DEPLOY_KEY: "k",
    DB_PASSWORD: "p",
    ANTHROPIC_API_KEY: "model-key",
    CLAUDE_CODE_OAUTH_TOKEN: "model-token",
    EMPTY: undefined,
  })
  assert.deepEqual(Object.keys(env).sort(), [
    "ANTHROPIC_API_KEY",
    "BASH_DEFAULT_TIMEOUT_MS",
    "BASH_MAX_TIMEOUT_MS",
    "CI",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "DISABLE_AUTOUPDATER",
    "HOME",
    "LANG",
    "PATH",
  ])
  assert.equal(env.ANTHROPIC_API_KEY, "model-key")
  // the plain variant, for shell lines from the config
  assert.deepEqual(agentEnv({ PATH: "/bin", GH_TOKEN: "x" }, {}), { PATH: "/bin" })
})

test("claudeArgs: executor and reviewer tool sets, schema, model and turn limit", () => {
  const all = claudeArgs({ model: "m-1", schema: '{"type":"object"}', tools: "all", maxTurns: 400 })
  assert.deepEqual(all.slice(0, 8), ["-p", "--verbose", "--output-format", "stream-json", "--max-turns", "400", "--model", "m-1"])
  const at = (args, flag) => args[args.indexOf(flag) + 1]
  assert.equal(at(all, "--allowedTools"), "Read,Edit,MultiEdit,Write,Glob,Grep,LS,TodoWrite,Bash")
  assert.match(at(all, "--disallowedTools"), /Bash\(git push:\*\).*Bash\(gh:\*\).*WebFetch/)
  assert.equal(at(all, "--json-schema"), '{"type":"object"}')
  assert.ok(!all.includes("--strict-mcp-config"))

  const ro = claudeArgs({ tools: "readonly", schema: { type: "object" } })
  assert.ok(!ro.includes("--model") && !ro.includes("--max-turns"))
  assert.deepEqual(ro.slice(4, 7), ["--setting-sources", "user", "--strict-mcp-config"])
  assert.ok(!at(ro, "--allowedTools").split(",").some((t) => ["Edit", "Write", "Bash"].includes(t)))
  assert.match(at(ro, "--disallowedTools"), /^Edit,MultiEdit,Write/)
  assert.equal(at(ro, "--json-schema"), '{"type":"object"}')
  assert.throws(() => claudeArgs({ tools: "everything" }), /"all" or "readonly"/)
})

test("parseStream skips lines that are not JSON objects", () => {
  assert.deepEqual(parseStream('{"type":"system"}\nwarning: something\n\n42\n{"type":"result"}\n'), [{ type: "system" }, { type: "result" }])
})

test("claudeResult: a successful run", () => {
  const out = { summary: "x" }
  const r = claudeResult([{ type: "system" }, result({ structured_output: out })], { rc: 0, maxTurns: 400 })
  assert.equal(r.ok, true)
  assert.deepEqual(r.output, out)
  assert.deepEqual(r.usage, { turns: 12, usd: 1.234, models: ["model-a"] })
  assert.match(r.note, /success, 12 turns, about \$1\.23/)
})

test("claudeResult: over the turn limit is not ok, but the answer in the transcript is kept", () => {
  const answer = { summary: "from the transcript" }
  const msgs = [
    { type: "assistant", message: { content: [{ type: "tool_use", name: "StructuredOutput", input: { summary: "first try" } }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "..." }, { type: "tool_use", name: "StructuredOutput", input: answer }] } },
    result({ subtype: "error_max_turns", num_turns: 401 }),
  ]
  const r = claudeResult(msgs, { rc: 1, maxTurns: 400 })
  assert.equal(r.ok, false)
  assert.deepEqual(r.output, answer)
  assert.equal(r.usage.turns, 401)
  assert.deepEqual(structuredOutput([result({ structured_output: {} })]), null)
  // success, but more turns than allowed
  assert.equal(claudeResult([result({ num_turns: 9 })], { maxTurns: 8 }).ok, false)
})

test("claudeResult: unavailable (quota, never started) is reported in usage", () => {
  const quota = claudeResult(
    [{ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1794787200 } }, result({ subtype: "error_during_execution", is_error: true, num_turns: 1, total_cost_usd: 0 })],
    { rc: 1 },
  )
  assert.equal(quota.ok, false)
  assert.equal(quota.usage.unavailable, "quota")
  assert.equal(quota.usage.resets_at, new Date(1794787200000).toISOString())
  const dead = claudeResult([], { rc: 127, stderr: "could not start" })
  assert.deepEqual(dead.usage, { turns: 0, usd: 0, models: [], unavailable: "not_started" })
  assert.equal(dead.output, null)
  // stopped at the time limit: an ordinary failure, not an outage
  const late = claudeResult([{ type: "system" }], { rc: 124 })
  assert.equal(late.usage.unavailable, undefined)
  assert.match(late.note, /time limit/)
})

// A stand-in for the CLI: a script that plays back a canned transcript.
function fakeCli(dir, body) {
  const bin = join(dir, "fake-agent")
  writeFileSync(bin, `#!/usr/bin/env node\n${body}\n`)
  chmodSync(bin, 0o755)
  return bin
}
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const until = async (cond, ms = 3000) => {
  const end = Date.now() + ms
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25))
  return cond()
}

test("runClaude: prompt on stdin, filtered environment, transcript on disk, leftovers killed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-test-"))
  const bin = fakeCli(
    dir,
    `
    const { spawn } = require("node:child_process")
    const { writeFileSync } = require("node:fs")
    let prompt = ""
    process.stdin.on("data", (d) => (prompt += d))
    process.stdin.on("end", () => {
      // something left running in the background, as a dev server would be
      const bg = spawn("sleep", ["60"], { stdio: "ignore" })
      writeFileSync(${JSON.stringify(join(dir, "seen.json"))}, JSON.stringify({ prompt, args: process.argv.slice(2), env: process.env, cwd: process.cwd(), bg: bg.pid }))
      console.log(JSON.stringify({ type: "system", subtype: "init" }))
      console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 3, total_cost_usd: 0.5, modelUsage: { "model-a": {} }, structured_output: { answer: 42 } }))
      process.exit(0)
    })`,
  )
  const logs = []
  const res = await runClaude(
    { tag: "executor", prompt: "do the work", cwd: dir, model: "m-1", minutes: 1, schema: '{"type":"object"}', tools: "all", maxTurns: 10 },
    { env: { PATH: process.env.PATH, HOME: dir, GITHUB_TOKEN: "secret-1", PIPELINE_TOKEN: "secret-2", ANTHROPIC_API_KEY: "model-key" }, workDir: join(dir, "work"), bin, log: (l) => logs.push(l) },
  )
  assert.equal(res.ok, true)
  assert.equal(res.rc, 0)
  assert.deepEqual(res.output, { answer: 42 })
  assert.deepEqual(res.usage, { turns: 3, usd: 0.5, models: ["model-a"] })
  assert.equal(res.rawPath, join(dir, "work", "executor.jsonl"))
  assert.equal(parseStream(readFileSync(res.rawPath, "utf8")).length, 2)
  const seen = JSON.parse(readFileSync(join(dir, "seen.json"), "utf8"))
  assert.equal(seen.prompt, "do the work")
  assert.equal(seen.cwd, dir)
  assert.ok(seen.args.includes("--json-schema") && !seen.args.includes("do the work"))
  assert.equal(seen.env.ANTHROPIC_API_KEY, "model-key")
  assert.equal(seen.env.GITHUB_TOKEN, undefined)
  assert.equal(seen.env.PIPELINE_TOKEN, undefined)
  assert.ok(!JSON.stringify(seen.env).includes("secret-"))
  assert.ok(await until(() => !alive(seen.bg)), "the background process was left running")
  assert.ok(logs.some((l) => /executor: success, 3 turns/.test(l)))
})

test("runClaude: stopped at the time limit -> rc 124, not ok, not an outage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-test-"))
  const bin = fakeCli(dir, `console.log(JSON.stringify({ type: "system", subtype: "init" })); setTimeout(() => {}, 60000)`)
  const res = await runClaude({ tag: "reviewer", prompt: "p", cwd: dir, minutes: 0.005, tools: "readonly" }, { env: { PATH: process.env.PATH }, workDir: dir, bin, graceMs: 200 })
  assert.equal(res.rc, 124)
  assert.equal(res.ok, false)
  assert.equal(res.output, null)
  assert.equal(res.usage.unavailable, undefined)
})

test("runClaude: a CLI that cannot be started is 'unavailable', not a crash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-test-"))
  const res = await runClaude({ tag: "executor", prompt: "p", cwd: dir, minutes: 1, tools: "all" }, { env: { PATH: process.env.PATH }, workDir: dir, bin: join(dir, "no-such-binary") })
  assert.equal(res.ok, false)
  assert.equal(res.rc, 127)
  assert.equal(res.usage.unavailable, "not_started")
  assert.match(readFileSync(res.errPath, "utf8"), /could not start/)
})

test("runClaude refuses bad calls before starting anything", () => {
  assert.throws(() => runClaude({ prompt: "", minutes: 1, tools: "all" }, { workDir: "/tmp/x" }), /prompt is empty/)
  assert.throws(() => runClaude({ prompt: "p", minutes: 0, tools: "all" }, { workDir: "/tmp/x" }), /minutes/)
  assert.throws(() => runClaude({ prompt: "p", minutes: 1, tools: "all" }, {}), /workDir/)
  assert.throws(() => runClaude({ tag: "../x", prompt: "p", minutes: 1, tools: "all" }, { workDir: "/tmp/x" }), /bad tag/)
})
