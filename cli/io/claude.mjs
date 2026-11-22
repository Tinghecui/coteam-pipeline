// The agent CLI: `claude -p --output-format stream-json`, run in its own session with a time
// limit. Whatever it left running (a dev server, a watcher) is killed when it ends.
//
// The agent gets the model credential and an ordinary shell environment, nothing else: no
// code-host token, no CI runtime token, no pipeline variable. Pushing, commenting and opening
// pull requests are done by the role after the agent has exited.
import { spawn, spawnSync } from "node:child_process"
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { unavailableReason } from "../core/ledger.mjs"

// ---------- environment ----------

// Removed whatever they hold: the code host's and the CI runner's own variables (tokens, and
// files such as the step summary that a test runner would happily write into), and ours.
const STRIP_PREFIX = /^(GITHUB_|ACTIONS_|GH_|PIPELINE_)/
// Anything else that is named like a secret goes too: a workflow may carry a registry token
// or a deploy key the agent has no business reading.
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|_KEY|_PAT)$/i
// The model credential and the CLI's own settings stay.
const MODEL_ENV = /^(ANTHROPIC_|CLAUDE_)/
// No self-update in the middle of a run; long builds and test suites must not be cut off by
// the CLI's default command timeout.
const FIXED_ENV = { DISABLE_AUTOUPDATER: "1", BASH_DEFAULT_TIMEOUT_MS: "1800000", BASH_MAX_TIMEOUT_MS: "2700000" }

// The environment the agent (and anything that runs code the agent wrote) is given.
export function agentEnv(env, extra = FIXED_ENV) {
  const out = {}
  for (const [k, v] of Object.entries(env || {})) {
    // A secret the workflow passes but the repository does not have arrives as "": the CLI
    // must not take an empty API key for the credential it should use.
    if (v === undefined || v === null || (MODEL_ENV.test(k) && v === "")) continue
    if (STRIP_PREFIX.test(k)) continue
    if (SECRET_NAME.test(k) && !MODEL_ENV.test(k)) continue
    out[k] = String(v)
  }
  return { ...out, ...extra }
}

// The CLI binary, and whether the environment carries a credential for it (for `doctor`).
export const BIN = "claude"
export const hasModelCredential = (env) => Boolean(env?.ANTHROPIC_API_KEY || env?.CLAUDE_CODE_OAUTH_TOKEN || env?.ANTHROPIC_AUTH_TOKEN)

// ---------- command line ----------

// "all": the executor. The shell is open as a whole: it has to run package managers, builds
// and tests, and allowing by command prefix stops nothing (any of them can run anything). The
// real boundary is that it holds no token. Publishing and network tools are still refused by name.
// "readonly": the reviewer. Reads files and history; settings and tool servers that the
// checkout itself could define are not loaded, because the pull request under review can change them.
const TOOLS = {
  all: {
    flags: [],
    allowed: "Read,Edit,MultiEdit,Write,Glob,Grep,LS,TodoWrite,Bash",
    disallowed: "Bash(git push:*),Bash(git commit:*),Bash(git stash:*),Bash(git config:*),Bash(gh:*),Bash(curl:*),Bash(wget:*),WebFetch,WebSearch",
  },
  readonly: {
    flags: ["--setting-sources", "user", "--strict-mcp-config"],
    allowed: "Read,Glob,Grep,LS,Bash(git diff:*),Bash(git log:*),Bash(git show:*),Bash(git blame:*),Bash(git grep:*),Bash(git ls-files:*),Bash(git status:*)",
    disallowed:
      "Edit,MultiEdit,Write,NotebookEdit,WebFetch,WebSearch,Task,Bash(git push:*),Bash(git commit:*),Bash(git config:*),Bash(git checkout:*),Bash(git reset:*),Bash(git stash:*),Bash(gh:*),Bash(curl:*),Bash(wget:*)",
  },
}

// Directories the CLI may create in the checkout for itself. They are never part of a change.
export const SCRATCH_PATHS = [".claude"]

// Arguments after the binary name. The prompt goes in on stdin, never on the command line.
// schema: JSON schema text (or an object) for the structured output; model "" = the CLI's default.
export function claudeArgs({ model = "", schema = null, tools, maxTurns = null }) {
  const t = TOOLS[tools]
  if (!t) throw new Error(`runClaude: tools must be "all" or "readonly", got ${JSON.stringify(tools ?? null)}`)
  const args = ["-p", "--verbose", "--output-format", "stream-json"]
  if (maxTurns) args.push("--max-turns", String(maxTurns))
  if (model) args.push("--model", String(model))
  args.push(...t.flags, "--allowedTools", t.allowed, "--disallowedTools", t.disallowed)
  if (schema) args.push("--json-schema", typeof schema === "string" ? schema : JSON.stringify(schema))
  return args
}

// ---------- result ----------

// stream-json text -> messages. Lines that are not JSON (a stray warning) are skipped.
export function parseStream(text) {
  return String(text || "")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        const m = JSON.parse(l)
        return m && typeof m === "object" ? [m] : []
      } catch {
        return []
      }
    })
}

const filled = (o) => (o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).length ? o : null)

// The structured output of a run: the result message's, or (when the run was cut short by the
// turn or time limit after the agent had already answered) the last answer found in the transcript.
export function structuredOutput(msgs) {
  const r = (msgs || []).filter((m) => m?.type === "result").pop()
  if (filled(r?.structured_output)) return r.structured_output
  const calls = (msgs || [])
    .filter((m) => m?.type === "assistant" && Array.isArray(m.message?.content))
    .flatMap((m) => m.message.content)
    .filter((c) => c?.type === "tool_use" && c.name === "StructuredOutput" && filled(c.input))
  return calls.length ? calls[calls.length - 1].input : null
}

// msgs: the messages of one run; rc: the CLI's exit code (124 = stopped at the time limit);
// stderr: its stderr; maxTurns: the limit it was given.
// -> { ok, output, usage: { turns, usd, models, unavailable?, resets_at? }, note }
//   ok:     the run ended with a successful result inside the turn limit. A run can be not ok
//           and still carry an output (see structuredOutput); the role decides whether to use it.
//   usage:  always present, zeros when the CLI never produced a result. `unavailable` is set
//           when the CLI could not be used at all (quota, overload, login): the role records the
//           outcome "unavailable" and the tick cools down.
//   note:   one line for the job log.
export function claudeResult(msgs, { rc = 0, stderr = "", maxTurns = null } = {}) {
  const r = (msgs || []).filter((m) => m?.type === "result").pop() || null
  const un = unavailableReason(msgs, { rc, stderr })
  const usage = {
    turns: Number(r?.num_turns) || 0,
    usd: Number(r?.total_cost_usd) || 0,
    models: Object.keys(r?.modelUsage || {}),
    ...(un ? { unavailable: un.reason, ...(un.resetsAt ? { resets_at: un.resetsAt } : {}) } : {}),
  }
  const over = Boolean(r && maxTurns && Number(r.num_turns) > Number(maxTurns))
  const ok = Boolean(r && r.subtype === "success" && !r.is_error && !over && !un)
  let note
  if (un) note = `unavailable: ${un.reason}${un.resetsAt ? ` until ${un.resetsAt}` : ""}${un.detail ? ` (${un.detail.slice(0, 200)})` : ""}`
  else if (!r) note = `no result message (exit code ${rc}, ${(msgs || []).length} messages)`
  else
    note =
      `${r.subtype}${r.is_error ? " (error)" : ""}, ${r.num_turns ?? "?"} turns${over ? ` (over the limit of ${maxTurns})` : ""}, about $${usage.usd.toFixed(2)}` +
      (r.is_error && typeof r.result === "string" ? `: ${r.result.replace(/\s+/g, " ").slice(0, 300)}` : "")
  if (Number(rc) === 124) note += "; stopped at the time limit"
  return { ok, output: structuredOutput(msgs), usage, note }
}

// ---------- run ----------

const killGroup = (pid, signal) => {
  try {
    process.kill(-pid, signal)
  } catch {
    // already gone
  }
}

// Kill everything the agent started: its process group, and (where `pkill` exists) every
// process of its session, which also catches children that moved to a group of their own.
function killLeftovers(pid) {
  killGroup(pid, "SIGKILL")
  try {
    spawnSync("pkill", ["-KILL", "-s", String(pid)], { stdio: "ignore", timeout: 5000 })
  } catch {
    // no pkill here: the group kill above has to do
  }
}

// opts: { tag, prompt, cwd, model, minutes, schema, tools: "all"|"readonly", maxTurns }
// deps: { env, workDir, bin, log, graceMs } — bound once by makeIo; tests pass their own.
//   env: the caller's environment (filtered here, see agentEnv); workDir: where the transcript
//   goes (outside the checkout); bin: the CLI binary; graceMs: time between asking it to stop
//   and killing it once the time limit is reached.
// Returns a Promise of { ok, output, usage, rc, rawPath, errPath, note }. It never rejects for
// something the CLI did: a CLI that cannot even be started comes back as usage.unavailable.
export function runClaude(opts, deps = {}) {
  const { tag = "agent", prompt, cwd, model = "", minutes, schema = null, tools, maxTurns = null } = opts || {}
  const { env = process.env, workDir, bin = BIN, log = () => {}, graceMs = 30000 } = deps
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("runClaude: the prompt is empty")
  if (!(Number(minutes) > 0)) throw new Error("runClaude: minutes must be > 0")
  if (!workDir) throw new Error("runClaude: no workDir for the transcript")
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(tag)) throw new Error(`runClaude: bad tag ${JSON.stringify(tag)}`)
  const args = claudeArgs({ model, schema, tools, maxTurns })
  mkdirSync(workDir, { recursive: true })
  const rawPath = join(workDir, `${tag}.jsonl`)
  const errPath = join(workDir, `${tag}.err`)

  return new Promise((resolve) => {
    const out = openSync(rawPath, "w")
    const err = openSync(errPath, "w")
    let timedOut = false
    let settled = false
    let stopTimer = null
    let killTimer = null

    const finish = (rc, startError = "") => {
      if (settled) return
      settled = true
      clearTimeout(stopTimer)
      clearTimeout(killTimer)
      closeSync(out)
      closeSync(err)
      if (startError) writeFileSync(errPath, `${startError}\n`, { flag: "a" })
      let stderr = ""
      let raw = ""
      try {
        raw = readFileSync(rawPath, "utf8")
        stderr = readFileSync(errPath, "utf8")
      } catch {
        // an unreadable transcript is the same as an empty one
      }
      const res = claudeResult(parseStream(raw), { rc, stderr, maxTurns })
      log(`${tag}: ${res.note}`)
      const tail = stderr.trim().split("\n").slice(-20).join("\n")
      if (tail) log(`${tag} stderr (end):\n${tail}`)
      resolve({ ok: res.ok, output: res.output, usage: res.usage, rc, rawPath, errPath, note: res.note })
    }

    let child
    try {
      // detached = its own session and process group, so the whole tree can be killed at once
      child = spawn(bin, args, { cwd, env: agentEnv(env), detached: true, stdio: ["pipe", out, err] })
    } catch (e) {
      finish(127, `could not start ${bin}: ${e.message}`)
      return
    }
    child.on("error", (e) => finish(127, `could not start ${bin}: ${e.message}`))
    child.stdin.on("error", () => {})
    child.stdin.end(prompt)
    stopTimer = setTimeout(
      () => {
        timedOut = true
        killGroup(child.pid, "SIGTERM")
        killTimer = setTimeout(() => killGroup(child.pid, "SIGKILL"), graceMs)
      },
      Math.round(Number(minutes) * 60000),
    )
    // "exit", not "close": output goes to files, and a leftover background process holding
    // them open must not keep us waiting.
    child.on("exit", (code, signal) => {
      killLeftovers(child.pid)
      finish(timedOut ? 124 : (code ?? (signal === "SIGKILL" ? 137 : 143)))
    })
  })
}
