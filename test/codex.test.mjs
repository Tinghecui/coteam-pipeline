import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { agentEnv, runAgent } from "../cli/io/agent.mjs"
import { AGENT_NAMES, AGENTS } from "../cli/io/agents.mjs"
import { CODEX, codexArgs, codexResetsAt, codexResult, SANDBOX_MARK, sandboxWorks, strictSchema, stripNulls } from "../cli/io/codex.mjs"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const schemaOf = (name) => JSON.parse(readFileSync(join(ROOT, "prompts", `${name}.schema.json`), "utf8"))
const files = { schema: "/w/x.schema.json", last: "/w/x.last.txt" }
const lines = (...events) => events.map((e) => JSON.stringify(e)).join("\n") + "\n"
const done = (usage = { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 300 }) => ({ type: "turn.completed", usage })
const item = (type, extra = {}) => ({ type: "item.completed", item: { id: "i", type, ...extra } })

test("the registry: claude and codex, by the names the config uses", () => {
  assert.deepEqual(AGENT_NAMES, ["claude", "codex"])
  assert.equal(AGENTS.codex, CODEX)
  assert.equal(AGENTS.claude.name, "claude")
})

test("codexArgs: exec with JSON events, no session left behind, the prompt on stdin; the sandbox by role", () => {
  const exec = codexArgs({ model: "gpt-x", schema: "{}", tools: "all", files })
  assert.deepEqual(exec, ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "--color", "never", "--dangerously-bypass-approvals-and-sandbox", "--model", "gpt-x", "--output-schema", files.schema, "--output-last-message", files.last, "-"])
  const review = codexArgs({ schema: "{}", tools: "readonly", files })
  assert.ok(review.includes("--sandbox") && review[review.indexOf("--sandbox") + 1] === "read-only")
  assert.ok(review.includes("--ignore-rules"))
  assert.ok(!review.includes("--dangerously-bypass-approvals-and-sandbox"))
  assert.ok(!review.includes("--model"), "no model named: the CLI's default")
  assert.equal(review.at(-1), "-")
  assert.throws(() => codexArgs({ tools: "everything", files }), /tools must be/)
})

test("strictSchema: every field required, the optional ones may be null; our two schemas come out whole", () => {
  for (const name of ["executor", "reviewer"]) {
    const s = schemaOf(name)
    const strict = strictSchema(s)
    const walk = (node, path) => {
      if (node.anyOf) return node.anyOf.forEach((n, i) => walk(n, `${path}|${i}`))
      if (node.properties) {
        assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort(), path)
        assert.equal(node.additionalProperties, false, path)
        for (const [k, v] of Object.entries(node.properties)) walk(v, `${path}.${k}`)
      }
      if (node.items) walk(node.items, `${path}[]`)
    }
    walk(strict, name)
    // what was required stays as it was; what was not may now be null
    for (const k of s.required) assert.equal(strict.properties[k].anyOf, undefined, `${name}.${k}`)
    for (const k of Object.keys(s.properties).filter((k) => !s.required.includes(k))) assert.deepEqual(strict.properties[k].anyOf[1], { type: "null" }, `${name}.${k}`)
  }
  assert.deepEqual(Object.keys(strictSchema(schemaOf("reviewer")).properties).filter((k) => strictSchema(schemaOf("reviewer")).properties[k].anyOf), ["ask", "options", "recommend"])
  // the schema we were given is not changed
  const s = schemaOf("executor")
  strictSchema(s)
  assert.equal(s.required.includes("cannot_fix"), false)
})

test("stripNulls: a field the model left null is left out, at any depth", () => {
  assert.deepEqual(stripNulls({ verdict: "approve", ask: null, options: null, problems: [{ kind: "logic", where: null }] }), { verdict: "approve", problems: [{ kind: "logic" }] })
})

test("codexResult: a finished run -> its answer from the -o file, tokens, no money", () => {
  const raw = lines({ type: "thread.started", thread_id: "t" }, { type: "turn.started" }, item("command_execution", { command: "npm test" }), item("file_change"), item("agent_message", { text: "{}" }), done())
  const r = codexResult(raw, { rc: 0, last: '{"verdict":"approve","level":0,"ask":null}', model: "gpt-x" })
  assert.equal(r.ok, true)
  assert.deepEqual(r.output, { verdict: "approve", level: 0 })
  assert.deepEqual(r.usage, { turns: 3, usd: 0, models: ["gpt-x"], tokens: { input: 1200, cached: 800, output: 300 } })
  assert.match(r.note, /^done, 3 steps, 1200 tokens in \(800 cached\), 300 out$/)
  // no -o file: the last agent message, even inside a code fence
  const fenced = codexResult(lines(item("agent_message", { text: '```json\n{"summary":"x"}\n```' }), done()), { rc: 0 })
  assert.deepEqual(fenced.output, { summary: "x" })
  assert.deepEqual(fenced.usage.models, ["codex"])
  // an answer that is not JSON: no output, not ok (the role reports "no result")
  const prose = codexResult(lines(item("agent_message", { text: "All done!" }), done()), { rc: 0, last: "All done!" })
  assert.deepEqual([prose.ok, prose.output], [false, null])
})

test("codexResult: out of quota, logged out, never started; a hiccup it got over is not an outage", () => {
  const now = new Date("2026-11-22T10:00:00Z")
  const quota = codexResult(lines({ type: "turn.started" }, { type: "turn.failed", error: { message: "You've hit your usage limit. Upgrade to Pro or try again in 2 hours 30 minutes." } }), { rc: 1, now })
  assert.equal(quota.ok, false)
  assert.equal(quota.usage.unavailable, "quota")
  assert.equal(quota.usage.resets_at, "2026-11-22T12:30:00.000Z")
  assert.match(quota.note, /^unavailable: quota until 2026-11-22T12:30:00\.000Z/)
  const login = codexResult(lines({ type: "error", message: "unexpected status 401 Unauthorized: Missing bearer" }), { rc: 1, now })
  assert.equal(login.usage.unavailable, "auth")
  // nothing on stdout: stderr is all there is
  assert.equal(codexResult("", { rc: 1, stderr: "Error: Not logged in", now }).usage.unavailable, "auth")
  assert.equal(codexResult("", { rc: 127, stderr: "could not start codex: ENOENT", now }).usage.unavailable, "not_started")
  // a stream error it retried, then finished: fine
  const retried = codexResult(lines({ type: "error", message: "stream disconnected, rate limit; retrying 1/5" }, item("agent_message", { text: '{"a":1}' }), done()), { rc: 0, now })
  assert.equal(retried.ok, true)
  assert.equal(retried.usage.unavailable, undefined)
  // stopped at the time limit: not an outage, whatever it said
  const slow = codexResult(lines({ type: "error", message: "usage limit" }), { rc: 124, now })
  assert.equal(slow.usage.unavailable, undefined)
  assert.match(slow.note, /stopped at the time limit/)
  // an ordinary failure
  const failed = codexResult(lines({ type: "turn.failed", error: { message: "the model refused" } }), { rc: 1, now })
  assert.equal(failed.usage.unavailable, undefined)
  assert.match(failed.note, /no completed turn \(exit code 1, 1 events\): the model refused/)
})

test("codexResetsAt: in so long, or at a time; nothing usable -> null", () => {
  const now = new Date("2026-11-22T10:00:00Z")
  assert.equal(codexResetsAt("try again in 1 day 2 hours.", now), "2026-11-23T12:00:00.000Z")
  assert.equal(codexResetsAt("Try again at Nov 23rd, 2026 3:05 AM UTC.", now), "2026-11-23T03:05:00.000Z")
  assert.equal(codexResetsAt("try again later", now), null)
  assert.equal(codexResetsAt("Try again at Nov 1st, 2026 3:05 AM UTC.", now), null, "a time in the past is not believed")
})

test("the environment: Codex gets its own key (also as CODEX_API_KEY), never Claude's; Claude never gets Codex's", () => {
  const env = { PATH: "/bin", HOME: "/h", OPENAI_API_KEY: "sk-o", ANTHROPIC_API_KEY: "sk-a", CLAUDE_CODE_OAUTH_TOKEN: "t", CODEX_HOME: "/h/.codex", GH_TOKEN: "g", NPM_TOKEN: "n" }
  assert.deepEqual(agentEnv(env, { ...CODEX.fixedEnv, ...CODEX.credentialEnv(env) }, CODEX.keepEnv), { PATH: "/bin", HOME: "/h", OPENAI_API_KEY: "sk-o", CODEX_HOME: "/h/.codex", CODEX_API_KEY: "sk-o" })
  const claude = AGENTS.claude
  assert.deepEqual(agentEnv(env, {}, claude.keepEnv), { PATH: "/bin", HOME: "/h", ANTHROPIC_API_KEY: "sk-a", CLAUDE_CODE_OAUTH_TOKEN: "t" })
  // an empty secret is not a key; a CODEX_API_KEY that is there is not replaced
  assert.deepEqual(CODEX.credentialEnv({ OPENAI_API_KEY: "" }), {})
  assert.deepEqual(CODEX.credentialEnv({ OPENAI_API_KEY: "a", CODEX_API_KEY: "b" }), {})
  assert.deepEqual(agentEnv({ OPENAI_API_KEY: "" }, {}, CODEX.keepEnv), {})
})

test("runAgent with Codex: schema written for it, prompt on stdin, its answer read from its -o file", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-test-"))
  const bin = join(dir, "codex")
  // a stand-in for the CLI: records its arguments, environment and stdin, writes an answer where -o says
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      `echo "$@" > "${dir}/args"`,
      `env > "${dir}/env"`,
      `cat > "${dir}/stdin"`,
      'while [ $# -gt 0 ]; do case "$1" in --output-last-message) shift; out="$1" ;; --output-schema) shift; cp "$1" "' + dir + '/schema" ;; esac; shift; done',
      `printf '{"verdict":"approve","ask":null}' > "$out"`,
      `echo '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}'`,
      `echo '{"type":"turn.completed","usage":{"input_tokens":5,"cached_input_tokens":0,"output_tokens":2}}'`,
      "",
    ].join("\n"),
  )
  chmodSync(bin, 0o755)
  const work = join(dir, "work")
  const res = await runAgent(
    CODEX,
    { tag: "reviewer", prompt: "Review this.", cwd: dir, minutes: 1, tools: "readonly", schema: readFileSync(join(ROOT, "prompts/reviewer.schema.json"), "utf8") },
    { env: { PATH: process.env.PATH, OPENAI_API_KEY: "sk-o", ANTHROPIC_API_KEY: "sk-a", GITHUB_TOKEN: "g" }, workDir: work, bin },
  )
  assert.equal(res.ok, true, res.note)
  assert.deepEqual(res.output, { verdict: "approve" })
  assert.equal(readFileSync(join(dir, "stdin"), "utf8"), "Review this.")
  assert.match(readFileSync(join(dir, "args"), "utf8"), /^exec --json .*--sandbox read-only .*--output-schema .*reviewer\.schema\.json --output-last-message .*reviewer\.last\.txt -$/m)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "schema"), "utf8")).required.sort(), ["ask", "followups", "level", "options", "problems", "recommend", "summary", "verdict"])
  const env = readFileSync(join(dir, "env"), "utf8")
  assert.match(env, /^CODEX_API_KEY=sk-o$/m)
  assert.doesNotMatch(env, /ANTHROPIC_API_KEY|GITHUB_TOKEN/)
})

test("the reviewer's sandbox: used where it starts; where it cannot (Linux without user namespaces), Codex runs without it", () => {
  const without = codexArgs({ schema: "{}", tools: "readonly", files, sandbox: false })
  assert.ok(without.includes("--dangerously-bypass-approvals-and-sandbox"))
  assert.ok(!without.includes("--sandbox"))
  assert.ok(without.includes("--ignore-rules"))
  // the executor never used it
  assert.deepEqual(codexArgs({ tools: "all", files, sandbox: true }), codexArgs({ tools: "all", files, sandbox: false }))
  const asked = []
  const ok = (cmd, args) => (asked.push([cmd, ...args].join(" ")), { rc: 0, stdout: `${SANDBOX_MARK}\n`, stderr: "" })
  assert.equal(sandboxWorks(ok, "codex", "/w"), true)
  assert.deepEqual(asked, [`codex sandbox -- echo ${SANDBOX_MARK}`])
  assert.equal(sandboxWorks(() => ({ rc: 0, stdout: "", stderr: "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n" }), "codex", "/w"), false)
  assert.equal(sandboxWorks(() => ({ rc: 1, stdout: "", stderr: "" }), "codex", "/w"), false)
  assert.equal(sandboxWorks(() => { throw new Error("ENOENT") }, "codex", "/w"), false)
})
