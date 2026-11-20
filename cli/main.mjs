#!/usr/bin/env node
// Entry point. Workflows call `node cli/main.mjs <command>`:
//   fix --issue N [--row R] [--pr P] [--dry]    executor: one issue (or one row of a spec issue); --pr = rework that PR
//   review --pr N [--dry]                       reviewer
//   tick [--dry]                                dispatcher
//   spec check <file | - | issue number>        check a spec issue's format (a file or stdin needs no token)
//   doctor [--fix]                              check the installation of this repository on GitHub (it only reads;
//                                               --fix creates the labels that are missing)
//   app-token <app-id> <owner/repo> [--login]   PEM on stdin -> an installation token on stdout
//                                               (--login: and on a second line the app's login, "<slug>[bot]")
// Exit code: 0 = done (including "nothing to do"), 1 = failed.
//
// Every module of the engine is imported here, statically, before anything runs. The agent
// that `fix` and `review` start runs as the same user and can write to the engine's checkout;
// whatever the engine does after the agent (pushing, commenting, renewing the bot token) must
// run code that was loaded before it. So: no dynamic import() anywhere under cli/, and no
// child process that is started from a file of the engine (test/main.test.mjs checks both).
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadConfig, presetOf } from "./core/config.mjs"
import { ALWAYS_FORBIDDEN, forbiddenHits } from "./core/policy.mjs"
import { checkSpec } from "./core/spec.mjs"
import { appLogin, mintAppToken } from "./io/app-token.mjs"
import { makeIo } from "./io/real.mjs"
import * as doctorRole from "./roles/doctor.mjs"
import * as fixRole from "./roles/fix.mjs"
import * as reviewRole from "./roles/review.mjs"
import * as tickRole from "./roles/tick.mjs"

const ROLES = { fix: fixRole, review: reviewRole, tick: tickRole }

export const TEXT = {
  usage: [
    "usage: main.mjs <command>",
    "  fix --issue N [--row R] [--pr P] [--dry]",
    "  review --pr N [--dry]",
    "  tick [--dry]",
    "  spec check <file | - | issue number>",
    "  doctor [--fix]",
    "  app-token <app-id> <owner/repo> [--login]   (PEM on stdin)",
  ].join("\n"),
  unknown: (cmd) => `unknown command: ${cmd}`,
  notNumber: (flag, v) => `--${flag} must be a number, got "${v}"`,
  fixNeeds: "fix needs --issue N (or --pr P to rework a pull request)",
  reviewNeeds: "review needs --pr N",
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

// The installation check (cli/roles/doctor.mjs). It needs the repository's name and a token
// like every role, but not a working config: a config that is missing or does not load is
// one of the things it reports. Its lines are the output; no JSON summary is printed.
async function doctor({ fix }, { env, cwd, out }) {
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
    body = target === "-" ? await stdin() : readFileSync(join(cwd, target), "utf8")
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
        const opts = { issue: num(flags, "issue"), row: num(flags, "row"), pr: num(flags, "pr"), dry }
        if (!opts.issue && !opts.pr) throw new Error(TEXT.fixNeeds)
        return await role("fix", opts, io)
      }
      case "review": {
        const pr = num(flags, "pr")
        if (!pr) throw new Error(TEXT.reviewNeeds)
        return await role("review", { pr, dry }, io)
      }
      case "tick":
        return await role("tick", { dry }, io)
      case "spec":
        if (rest[0] !== "check") throw new Error(TEXT.specUsage)
        return await specCheck(rest[1], io)
      case "doctor":
        return await doctor({ fix: bool(flags, "fix") }, io)
      case "app-token":
        return await appToken(rest, io, { login: bool(flags, "login") })
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
