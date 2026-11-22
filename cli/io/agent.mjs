// Running an agent CLI: in its own session with a time limit, the prompt on stdin, its output in
// a file outside the checkout. Whatever it left running (a dev server, a watcher) is killed when
// it ends. What differs between CLIs (arguments, reading the output, which variables carry its
// credential) is an adapter: cli/io/claude.mjs, cli/io/codex.mjs.
//
// The agent gets its own model credential and an ordinary shell environment, nothing else: no
// code-host token, no CI runtime token, no pipeline variable, and not the credential of another
// CLI. Pushing, commenting and opening pull requests are done by the role after the agent has exited.
//
// An adapter: {
//   name, bin,                      the CLI's name and its default binary
//   keepEnv,                        RegExp: the variables of its credential and settings
//   fixedEnv,                       variables always set for it
//   credentialEnv(env) -> object    variables derived from the environment (say, a second name for the key)
//   scratch,                        directories it creates in the checkout for itself
//   prepare({ files, schema }) -> { path: text }   optional: files to write before it starts
//   args({ model, schema, tools, maxTurns, files }) -> [arg]
//                                   files: { schema, last }: paths it may write to or read from
//   result(raw, { rc, stderr, maxTurns, last, now, model }) -> { ok, output, usage, note }
//                                   raw: its stdout; last: the file `files.last`, as text ("" if none)
// }
import { spawn, spawnSync } from "node:child_process"
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// ---------- environment ----------

// Removed whatever they hold: the code host's and the CI runner's own variables (tokens, and
// files such as the step summary that a test runner would happily write into), and ours.
const STRIP_PREFIX = /^(GITHUB_|ACTIONS_|GH_|PIPELINE_)/
// Anything else that is named like a secret goes too: a workflow may carry a registry token
// or a deploy key the agent has no business reading.
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|_KEY|_PAT)$/i
// Every CLI's credential, so that one CLI's run does not get another's.
const ANY_MODEL_ENV = /^(ANTHROPIC_|CLAUDE_|OPENAI_|CODEX_)/
const CLAUDE_ENV = /^(ANTHROPIC_|CLAUDE_)/

// The environment the agent (and anything that runs code the agent wrote) is given.
//   keep: the variables of the agent's own credential and settings (default: Claude Code's)
export function agentEnv(env, extra = {}, keep = CLAUDE_ENV) {
  const out = {}
  for (const [k, v] of Object.entries(env || {})) {
    // A secret the workflow passes but the repository does not have arrives as "": the CLI
    // must not take an empty API key for the credential it should use.
    if (v === undefined || v === null || (keep.test(k) && v === "")) continue
    if (STRIP_PREFIX.test(k)) continue
    if (ANY_MODEL_ENV.test(k) && !keep.test(k)) continue
    if (SECRET_NAME.test(k) && !keep.test(k)) continue
    out[k] = String(v)
  }
  return { ...out, ...extra }
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

const readOr = (path, fallback = "") => {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return fallback
  }
}

// adapter: see the top of this file.
// opts: { tag, prompt, cwd, model, minutes, schema, tools: "all"|"readonly", maxTurns }
// deps: { env, workDir, bin, log, graceMs, now } — bound once by makeIo; tests pass their own.
//   env: the caller's environment (filtered here, see agentEnv); workDir: where the transcript
//   goes (outside the checkout); bin: the CLI binary; graceMs: time between asking it to stop
//   and killing it once the time limit is reached.
// Returns a Promise of { ok, output, usage, rc, rawPath, errPath, note }. It never rejects for
// something the CLI did: a CLI that cannot even be started comes back as usage.unavailable.
export function runAgent(adapter, opts, deps = {}) {
  const { tag = "agent", prompt, cwd, model = "", minutes, schema = null, tools, maxTurns = null, sandbox } = opts || {}
  const { env = process.env, workDir, bin = adapter.bin, log = () => {}, graceMs = 30000, now = () => new Date() } = deps
  const who = `run ${adapter.name}`
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error(`${who}: the prompt is empty`)
  if (!(Number(minutes) > 0)) throw new Error(`${who}: minutes must be > 0`)
  if (!workDir) throw new Error(`${who}: no workDir for the transcript`)
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(tag)) throw new Error(`${who}: bad tag ${JSON.stringify(tag)}`)
  mkdirSync(workDir, { recursive: true })
  const files = { schema: join(workDir, `${tag}.schema.json`), last: join(workDir, `${tag}.last.txt`) }
  const args = adapter.args({ model, schema, tools, maxTurns, files, sandbox })
  for (const [path, text] of Object.entries(adapter.prepare ? adapter.prepare({ files, schema }) : {})) writeFileSync(path, text)
  const rawPath = join(workDir, `${tag}.jsonl`)
  const errPath = join(workDir, `${tag}.err`)
  writeFileSync(files.last, "")
  const childEnv = agentEnv(env, { ...adapter.fixedEnv, ...(adapter.credentialEnv ? adapter.credentialEnv(env) : {}) }, adapter.keepEnv)

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
      // an unreadable transcript is the same as an empty one
      const raw = readOr(rawPath)
      const stderr = readOr(errPath)
      const res = adapter.result(raw, { rc, stderr, maxTurns, last: readOr(files.last), now: now(), model })
      log(`${tag}: ${res.note}`)
      const tail = stderr.trim().split("\n").slice(-20).join("\n")
      if (tail) log(`${tag} stderr (end):\n${tail}`)
      resolve({ ok: res.ok, output: res.output, usage: res.usage, rc, rawPath, errPath, note: res.note })
    }

    let child
    try {
      // detached = its own session and process group, so the whole tree can be killed at once
      child = spawn(bin, args, { cwd, env: childEnv, detached: true, stdio: ["pipe", out, err] })
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

// stdout of a CLI that writes one JSON object per line -> the objects. Lines that are not JSON
// (a stray warning) are skipped.
export function parseLines(text) {
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
