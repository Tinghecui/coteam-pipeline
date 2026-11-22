#!/usr/bin/env node
// Entry point. Workflows call `node cli/main.mjs <command>`:
//   fix --issue N [--row R] [--pr P] [--dry]    executor: one issue (or one row of a spec issue); --pr = rework that PR
//   review --pr N [--dry]                       reviewer
//   fix|review prepare ... --order DIR          the same in three parts, one per job of the workflow (cli/core/handoff.mjs):
//   fix|review agent --order DIR --result DIR     prepare writes the work order, agent runs the agent and leaves a result,
//   fix|review publish --order DIR --sha256 H --result DIR   publish checks both and writes to GitHub
//   tick [--dry]                                dispatcher
//   status [--repo owner/name] [--json]         the status board as the next round would write it (it only reads;
//                                               on a person's machine it uses their `gh` login)
//   spec check <file | - | issue number>        check a spec issue's format (a file or stdin needs no token)
//   doctor [--fix]                              check the installation of this repository on GitHub (it only reads;
//                                               --fix creates the labels that are missing)
//   doctor --runner [--cli claude,codex] [--try]
//                                               check this machine for running the agent's job (a self-hosted
//                                               runner), as the runner's user; --try asks each agent CLI one question
//   app-token <app-id> <owner/repo> [--login]   PEM on stdin -> an installation token on stdout
//                                               (--login: and on a second line the app's login, "<slug>[bot]")
//   init <scan | files | check | app>           the installer's steps, run on a person's machine by the
//                                               Claude Code skill in skills/init (cli/roles/init.mjs)
// Exit code: 0 = done (including "nothing to do"), 1 = failed.
//
// Every module of the engine is imported here, statically, before anything runs. The agent
// that `fix` and `review` start runs as the same user and can write to the engine's checkout;
// whatever the engine does after the agent (pushing, commenting, renewing the bot token) must
// run code that was loaded before it. (The workflows run the agent in a job of its own, which
// holds no bot token at all; this rule is what protects a whole `fix` or `review` run in one
// process, and costs nothing to keep.) So: no dynamic import() anywhere under cli/, and no
// child process that is started from a file of the engine (test/main.test.mjs checks both).
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { loadConfig, presetOf } from "./core/config.mjs"
import { BUNDLE_FILE, MAX_RESULT_BYTES, openOrder, ORDER_FILE, RESULT_FILE, sealOrder } from "./core/handoff.mjs"
import { ALWAYS_FORBIDDEN, forbiddenHits } from "./core/policy.mjs"
import { checkSpec } from "./core/spec.mjs"
import { appLogin, mintAppToken } from "./io/app-token.mjs"
import { checkMachine, RUNNER_TEXT } from "./io/machine.mjs"
import { run as runProc } from "./io/proc.mjs"
import { AGENT_NAMES, AGENTS } from "./io/agents.mjs"
import { agentBin, HOME, makeIo } from "./io/real.mjs"
import * as doctorRole from "./roles/doctor.mjs"
import * as fixRole from "./roles/fix.mjs"
import * as initRole from "./roles/init.mjs"
import * as reviewRole from "./roles/review.mjs"
import * as tickRole from "./roles/tick.mjs"

const ROLES = { fix: fixRole, review: reviewRole, tick: tickRole }
const PARTS = ["prepare", "agent", "publish"]

export const TEXT = {
  usage: [
    "usage: main.mjs <command>",
    "  fix --issue N [--row R] [--pr P] [--dry]",
    "  review --pr N [--dry]",
    "  fix|review prepare ... --order DIR | agent --order DIR --result DIR | publish --order DIR --sha256 H --result DIR",
    "  tick [--dry]",
    "  status [--repo owner/name] [--json]",
    "  spec check <file | - | issue number>",
    "  doctor [--fix] | doctor --runner [--cli claude,codex] [--try]",
    "  app-token <app-id> <owner/repo> [--login]   (PEM on stdin)",
    "  init <scan | files | check | app>           (the installer's steps; `init` alone lists them)",
  ].join("\n"),
  unknown: (cmd) => `unknown command: ${cmd}`,
  notNumber: (flag, v) => `--${flag} must be a number, got "${v}"`,
  fixNeeds: "fix needs --issue N (or --pr P to rework a pull request)",
  reviewNeeds: "review needs --pr N",
  partNeeds: (flag) => `this part needs --${flag} DIR`,
  notOrder: (name) => `the work order is not one for "${name}"`,
  noRepo: "status: say which repository (--repo owner/name), or run it in a checkout whose origin is on GitHub",
  noToken: "status: no token (set PIPELINE_TOKEN or GH_TOKEN, or log in with `gh auth login`)",
  unknownCli: (names, known) => `doctor --runner: no agent CLI called ${names.join(", ")} (known: ${known.join(", ")})`,
  specOk: "The spec has no problems.",
  specProblems: (n) => `The spec has ${n} problem${n === 1 ? "" : "s"}:`,
  specUsage: "usage: main.mjs spec check <file | - | issue number>",
  tokenUsage: "usage: main.mjs app-token <app-id> <owner/repo> [--login] < private-key.pem",
  noLogin: (why) => `warning: the app's login could not be read (${why})`,
  exposed:
    "warning: the bot token is in this process's environment, where a process started by the agent can read it. Use Node >= 22.15 (the engine then re-executes itself without it) or hand the secrets over in PIPELINE_SECRETS_FILE.",
}

// ---------- arguments ----------

// `--flag value` pairs and positionals. A flag followed by another flag or by nothing is `true`
// (`--dry`); so is a flag whose value expanded to nothing in a workflow (`--row ${{ inputs.row }}`).
export function parseArgs(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--") && a.length > 2) {
      const eq = a.indexOf("=")
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1)
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) flags[a.slice(2)] = argv[++i]
      else flags[a.slice(2)] = true
    } else positional.push(a)
  }
  return { positional, flags }
}

// A numeric flag: absent, `true` or "" -> undefined; digits -> number; anything else is an error.
function num(flags, name) {
  const v = flags[name]
  if (v === undefined || v === true || String(v).trim() === "") return undefined
  if (!/^\d+$/.test(String(v).trim())) throw new Error(TEXT.notNumber(name, v))
  return Number(v)
}
const bool = (flags, name) => flags[name] !== undefined && flags[name] !== false && !/^(false|0|no|)$/i.test(String(flags[name]))

// ---------- secrets ----------

// Carried from the workflow into this process only; never left where the agent can read them.
const CARRIED = ["PIPELINE_TOKEN", "PIPELINE_APP_KEY"]
// Not needed by the engine and not to be inherited by anything it starts.
const DROPPED = ["GITHUB_TOKEN", "GH_TOKEN", "GH_ENTERPRISE_TOKEN", "ACTIONS_RUNTIME_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"]

// The environment the engine works with: the given one plus the secrets file, if any. The
// file is deleted as soon as it is read.
export function takeSecrets(env) {
  const file = env.PIPELINE_SECRETS_FILE
  if (!file) return { ...env }
  const secrets = JSON.parse(readFileSync(file, "utf8"))
  rmSync(file, { force: true })
  const { PIPELINE_SECRETS_FILE: _, ...rest } = env
  return { ...rest, ...secrets }
}

// A process the agent starts runs as the same user and can read the environment this process
// was started with (it stays readable for the life of the process, whatever is unset later).
// So before a role that runs the agent: put the secrets in a private file, replace this
// process by a fresh one whose environment never held them, and let that one read and delete
// the file. Returns only when no re-execution is needed or possible.
function reexecWithoutSecrets(argv) {
  const env = process.env
  if (env.PIPELINE_SECRETS_FILE || ![...CARRIED, ...DROPPED].some((k) => env[k])) return true
  if (typeof process.execve !== "function" || process.platform === "win32" || env.PIPELINE_NO_REEXEC) return false
  const dir = mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), "pipeline-secrets-"))
  const file = join(dir, "secrets.json")
  writeFileSync(file, JSON.stringify(Object.fromEntries(CARRIED.filter((k) => env[k]).map((k) => [k, env[k]]))), { mode: 0o600 })
  const clean = Object.fromEntries(Object.entries(env).filter(([k]) => !CARRIED.includes(k) && !DROPPED.includes(k)))
  process.execve(process.execPath, [process.execPath, ...process.execArgv, fileURLToPath(import.meta.url), ...argv], { ...clean, PIPELINE_SECRETS_FILE: file })
  return false
}

// ---------- commands ----------

async function role(name, opts, { env, cwd, out }) {
  const io = makeIo({ env, cwd })
  const res = await ROLES[name].run(opts, io)
  out(JSON.stringify(res ?? { ok: false }))
  return res?.ok ? 0 : 1
}

// One of the three parts of an agent role, as one job of the workflow runs it. What passes
// between the jobs is files in two directories: the order (prepare -> agent, publish) and
// the result (agent -> publish).
//   prepare  writes the order and reports `go`, the order's digest and the engine's own
//            commit through GITHUB_OUTPUT.
//            go=false: the run ended here and the other two jobs are skipped.
//   agent    reads the order, leaves the result (and, for the executor, the bundle). It
//            always exits 0 when it got that far: what happened is for publish to say.
//   publish  reads the order only if its digest is the one prepare reported, and the result
//            as untrusted text, a plain file of a sane size or nothing at all.
async function rolePart(name, part, opts, flags, { env, cwd, out }) {
  const dir = (flag) => {
    if (typeof flags[flag] !== "string" || !flags[flag].trim()) throw new Error(TEXT.partNeeds(flag))
    return resolve(cwd, flags[flag].trim())
  }
  const plainFile = (path) => {
    try {
      return lstatSync(path).isFile()
    } catch {
      return false
    }
  }
  const role = ROLES[name]
  const done = (res) => {
    out(JSON.stringify(res ?? { ok: false }))
    return res?.ok ? 0 : 1
  }
  if (part === "prepare") {
    const orderDir = dir("order")
    const first = role.prepare(opts, makeIo({ env, cwd }))
    const sealed = first.go ? sealOrder(first.order) : null
    if (sealed) {
      mkdirSync(orderDir, { recursive: true })
      writeFileSync(join(orderDir, ORDER_FILE), sealed.text)
    }
    // The commit of the engine this job runs: the other two jobs check out the same one, so
    // a branch or tag that moves in the middle of a run cannot give them another engine.
    const head = runProc("git", ["-C", HOME, "rev-parse", "HEAD"]).stdout.trim()
    const engine = /^[0-9a-f]{40,64}$/.test(head) ? head : ""
    // agent_cli: which CLI the agent's job installs (on GitHub's machines) and runs.
    const cli = AGENT_NAMES.includes(first.order?.cli) ? first.order.cli : ""
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `go=${first.go ? "true" : "false"}\norder_sha256=${sealed?.sha256 || ""}\nengine_sha=${engine}\nagent_cli=${cli}\n`)
    return first.go ? done({ ok: true, go: true, order_sha256: sealed.sha256 }) : done(first.result)
  }
  if (part === "agent") {
    const order = JSON.parse(readFileSync(join(dir("order"), ORDER_FILE), "utf8"))
    if (order?.role !== name) throw new Error(TEXT.notOrder(name))
    const resultDir = dir("result")
    mkdirSync(resultDir, { recursive: true })
    const result = await role.agent(order, makeIo({ env, cwd }), { bundle: join(resultDir, BUNDLE_FILE) })
    writeFileSync(join(resultDir, RESULT_FILE), JSON.stringify(result))
    return done({ ok: true, outcome: result.outcome || result.error || "ran" })
  }
  const order = openOrder(readFileSync(join(dir("order"), ORDER_FILE), "utf8"), String(flags.sha256 || "").trim(), name)
  const resultDir = dir("result")
  const file = join(resultDir, RESULT_FILE)
  const result = plainFile(file) && lstatSync(file).size <= MAX_RESULT_BYTES ? readFileSync(file, "utf8") : null
  const bundle = join(resultDir, BUNDLE_FILE)
  return done(role.publish(order, result, makeIo({ env, cwd }), { bundle: plainFile(bundle) ? bundle : "" }))
}

// The status board, printed (cli/roles/tick.mjs status). It only reads, so on a person's machine
// it may use what they have: the repository from --repo or the checkout's origin, the token
// from PIPELINE_TOKEN, GH_TOKEN or their `gh` login.
async function status(flags, { env, cwd, out }) {
  const e = { ...env }
  if (typeof flags.repo === "string" && flags.repo.trim()) e.GITHUB_REPOSITORY = flags.repo.trim()
  if (!e.GITHUB_REPOSITORY) {
    const url = runProc("git", ["-C", cwd, "remote", "get-url", "origin"]).stdout.trim()
    const m = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url)
    if (!m) throw new Error(TEXT.noRepo)
    e.GITHUB_REPOSITORY = m[1]
  }
  if (!e.PIPELINE_TOKEN && !(e.PIPELINE_APP_ID && e.PIPELINE_APP_KEY)) {
    let t = e.GH_TOKEN || e.GITHUB_TOKEN || ""
    if (!t) {
      try {
        t = runProc("gh", ["auth", "token"]).stdout.trim()
      } catch {
        // no gh here
      }
    }
    if (!t) throw new Error(TEXT.noToken)
    e.PIPELINE_TOKEN = t
  }
  const io = makeIo({ env: e, cwd, log: out })
  const res = await tickRole.status({ json: bool(flags, "json") }, io)
  return res?.ok ? 0 : 1
}

// The installation check (cli/roles/doctor.mjs). It needs the repository's name and a token
// like every role, but not a working config: a config that is missing or does not load is
// one of the things it reports. Its lines are the output; no JSON summary is printed.
async function doctor({ fix, runner, tryAgent, cli = "" }, { env, cwd, out }) {
  if (runner) {
    const deps = { env, home: homedir(), platform: process.platform, uid: typeof process.getuid === "function" ? process.getuid() : -1, run: runProc, exists: existsSync, read: (p) => readFileSync(p, "utf8"), list: (d) => readdirSync(d) }
    // --cli claude,codex: the CLIs this machine is to run (default: claude).
    const names = String(cli || "claude").split(",").map((x) => x.trim()).filter(Boolean)
    const unknown = names.filter((n) => !AGENT_NAMES.includes(n))
    if (unknown.length) throw new Error(TEXT.unknownCli(unknown, AGENT_NAMES))
    const res = checkMachine(deps, { clis: names.map((n) => ({ cli: n, bin: agentBin(env, AGENTS[n]) })), tryAgent })
    out(RUNNER_TEXT.title)
    for (const r of res.results) {
      out(`${r.state.padEnd(4)}  ${r.text}`)
      if (r.hint) out(`      -> ${r.hint}`)
    }
    out(RUNNER_TEXT.summary(res.counts))
    return res.ok ? 0 : 1
  }
  const io = makeIo({ env, cwd, log: out, tolerateConfig: true })
  const res = await doctorRole.run({ fix }, io)
  return res?.ok ? 0 : 1
}

const forbiddenMatcher = (risk) => (path) => forbiddenHits(risk, [path]).length > 0

// The config in the working tree (not the base branch): good enough to check a draft against.
function localConfig(cwd) {
  const file = join(cwd, ".coteam/pipeline.yml")
  if (!existsSync(file)) return null
  const text = readFileSync(file, "utf8")
  const name = presetOf(text)
  const preset = name ? join(fileURLToPath(new URL("..", import.meta.url)), "presets", `${name}.yml`) : ""
  return loadConfig(text, preset && existsSync(preset) ? readFileSync(preset, "utf8") : null)
}

async function specCheck(target, { env, cwd, out, stdin }) {
  if (!target) throw new Error(TEXT.specUsage)
  let body
  let risk = { forbidden: ALWAYS_FORBIDDEN }
  if (/^\d+$/.test(target)) {
    const io = makeIo({ env, cwd })
    body = io.gh.get(`issues/${target}`).body || ""
    risk = io.config.risk
  } else {
    body = target === "-" ? await stdin() : readFileSync(resolve(cwd, target), "utf8")
    try {
      risk = localConfig(cwd)?.risk || risk
    } catch {
      // a broken local config is `doctor`'s business; the spec is still checked
    }
  }
  const problems = checkSpec(body, { isForbidden: forbiddenMatcher(risk) })
  if (!problems.length) {
    out(TEXT.specOk)
    return 0
  }
  out(TEXT.specProblems(problems.length))
  for (const p of problems) out(`- ${p}`)
  return 1
}

// The token on the first line. With `login`, the app's login on the second ("" when it could
// not be read: the token is still good, and the caller falls back to not knowing its login).
async function appToken([appId, repo], { env, out, err, stdin }, { login = false } = {}) {
  if (!appId || !repo) throw new Error(TEXT.tokenUsage)
  const pem = await stdin()
  const api = env.GITHUB_API_URL ? { apiUrl: env.GITHUB_API_URL } : {}
  const { token } = await mintAppToken({ appId, pem, repo, ...api })
  let who = ""
  if (login) {
    try {
      who = await appLogin({ appId, pem, ...api })
    } catch (e) {
      err(TEXT.noLogin(e?.message || String(e)))
    }
  }
  out(login ? `${token}\n${who}` : token)
  return 0
}

// The installer's steps. They run as the person at the keyboard, with their own `gh` login:
// no bot token, no config from the base branch, no agent.
async function init([step], flags, { cwd, out }) {
  const deps = { log: out }
  const list = (v) => (typeof v === "string" ? v.split(",") : [])
  const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined)
  switch (step) {
    case "scan":
      out(JSON.stringify(initRole.scan({ cwd }, deps), null, 2))
      return 0
    case "files":
      initRole.files({ cwd, ref: text(flags.ref), ci: list(flags.ci), base: text(flags.base), force: bool(flags, "force") }, deps)
      return 0
    case "check":
      return initRole.check({ cwd }, deps).ok ? 0 : 1
    case "app": {
      const res = await initRole.app({ cwd, repo: text(flags.repo), name: text(flags.name), noOpen: bool(flags, "no-open"), force: bool(flags, "force"), timeoutMinutes: num(flags, "timeout") }, deps)
      return res.ok ? 0 : 1
    }
    default:
      throw new Error(initRole.TEXT.usage)
  }
}

const readStdin = async () => {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString("utf8")
}

// -> exit code. Everything outside comes in through `ctx`, so tests call this directly.
export async function main(argv, ctx = {}) {
  const { cwd = process.cwd(), out = (s) => console.log(s), err = (s) => console.error(s), stdin = readStdin } = ctx
  const { positional, flags } = parseArgs(argv)
  const [cmd, ...rest] = positional
  try {
    const usesAgent = cmd === "fix" || cmd === "review"
    const safe = ctx.env || !["fix", "review", "tick", "doctor"].includes(cmd) ? true : reexecWithoutSecrets(argv)
    const env = takeSecrets(ctx.env || process.env)
    if (!ctx.env) for (const k of [...CARRIED, ...DROPPED, "PIPELINE_SECRETS_FILE"]) delete process.env[k]
    if (!safe && usesAgent) err(TEXT.exposed)
    const io = { env, cwd, out, err, stdin }
    const dry = bool(flags, "dry")
    switch (cmd) {
      case "fix": {
        const part = PARTS.includes(rest[0]) ? rest[0] : ""
        const opts = { issue: num(flags, "issue"), row: num(flags, "row"), pr: num(flags, "pr"), dry }
        if (part !== "agent" && part !== "publish" && !opts.issue && !opts.pr) throw new Error(TEXT.fixNeeds)
        return part ? await rolePart("fix", part, opts, flags, io) : await role("fix", opts, io)
      }
      case "review": {
        const part = PARTS.includes(rest[0]) ? rest[0] : ""
        const pr = num(flags, "pr")
        if (part !== "agent" && part !== "publish" && !pr) throw new Error(TEXT.reviewNeeds)
        return part ? await rolePart("review", part, { pr, dry }, flags, io) : await role("review", { pr, dry }, io)
      }
      case "tick":
        return await role("tick", { dry }, io)
      case "status":
        return await status(flags, io)
      case "spec":
        if (rest[0] !== "check") throw new Error(TEXT.specUsage)
        return await specCheck(rest[1], io)
      case "doctor":
        return await doctor({ fix: bool(flags, "fix"), runner: bool(flags, "runner"), tryAgent: bool(flags, "try"), cli: typeof flags.cli === "string" ? flags.cli : "" }, io)
      case "app-token":
        return await appToken(rest, io, { login: bool(flags, "login") })
      case "init":
        return await init(rest, flags, io)
      case undefined:
      case "help":
        out(TEXT.usage)
        return cmd ? 0 : 1
      default:
        throw new Error(`${TEXT.unknown(cmd)}\n${TEXT.usage}`)
    }
  } catch (e) {
    err(e?.message || String(e))
    return 1
  }
}

const invoked = () => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}
if (invoked()) process.exitCode = await main(process.argv.slice(2))
