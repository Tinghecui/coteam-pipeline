// The real `io` object every role is given (docs/design-0.1.md, "Roles and io").
//
// Nothing in cli/ may load code from the engine's checkout once a role has started: the agent
// runs as the same user and can rewrite those files. cli/main.mjs imports every module up
// front, no module uses a dynamic import(), and the one child process that runs engine code
// (the token renewal below) is given that code as text read here, at load time.
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve, parse as parsePath } from "node:path"
import { fileURLToPath } from "node:url"
import { loadConfig, presetOf } from "../core/config.mjs"
import { agentEnv, runClaude, SCRATCH_PATHS } from "./claude.mjs"
import { makeGh } from "./gh.mjs"
import { makeGit } from "./git.mjs"
import { makeLedger } from "./ledger-io.mjs"
import { must, run, shell } from "./proc.mjs"

// The engine's own checkout (prompts/, presets/: text, read before the agent starts).
export const HOME = resolve(fileURLToPath(new URL("../..", import.meta.url)))
export const CONFIG_PATH = ".coteam/pipeline.yml"
// An installation token lasts an hour and the executor may run for two: take a new one after this long.
const TOKEN_REFRESH_MS = 40 * 60000

// The program the token child runs: cli/io/app-token.mjs as it was when this module was
// loaded (before any agent ran), followed by a few lines that read the request from stdin
// ({ appId, repo, pem, login, apiUrl }) and answer with one line of JSON on stdout
// ({ token, permissions, login }). It is handed to `node -e` as text, never as a file path.
const MINT_DRIVER = `
// ---- driver (cli/io/real.mjs) ----
try {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  const q = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  const api = q.apiUrl ? { apiUrl: q.apiUrl } : {}
  const minted = await mintAppToken({ appId: q.appId, pem: q.pem, repo: q.repo, ...api })
  let login = ""
  if (q.login) {
    try {
      login = await appLogin({ appId: q.appId, pem: q.pem, ...api })
    } catch {
      // the token is still good; the caller goes on without knowing the app's login
    }
  }
  process.stdout.write(JSON.stringify({ token: minted.token, permissions: minted.permissions, login }) + "\\n")
} catch (e) {
  process.stderr.write(String(e?.message || e) + "\\n")
  process.exitCode = 1
}
`
export const MINT_SOURCE = `${readFileSync(new URL("./app-token.mjs", import.meta.url), "utf8")}\n${MINT_DRIVER}`
export const MINT_ARGS = ["--input-type=module", "-e"]

// -> a function returning the bot token to use right now.
// PIPELINE_TOKEN is used as given. With PIPELINE_APP_ID + PIPELINE_APP_KEY a token is minted
// for this repository in a child process (so everything here stays synchronous) and renewed
// as it ages. The child is `node -e <MINT_SOURCE>`: the key and the request go in on stdin,
// never on a command line and never in the child's environment, and the code it runs is the
// text in this process's memory, not whatever cli/ holds on disk by then. A renewal happens
// after the agent has run for a while, and the agent can write to the engine's checkout; a
// file started from there would be handed the App's private key.
// The function also carries `app` (is this an app's token?), `login()`: the login an app
// writes under, "<app-slug>[bot]", asked for together with the first token and kept ("" when
// it could not be read, and for a plain token, whose owner is asked with GET /user instead),
// and `permissions()`: what GitHub said the app's token may do (null for a plain token,
// which does not say).
export function tokenSource({ env, repo, source = MINT_SOURCE, now = () => new Date(), runProc = run }) {
  if (env.PIPELINE_TOKEN) return Object.assign(() => env.PIPELINE_TOKEN, { app: false, login: () => "", permissions: () => null })
  if (!env.PIPELINE_APP_ID || !env.PIPELINE_APP_KEY) throw new Error("no bot token: set PIPELINE_TOKEN, or PIPELINE_APP_ID and PIPELINE_APP_KEY")
  // A key pasted into a one-line secret arrives with its line breaks written as "\n".
  const pem = String(env.PIPELINE_APP_KEY).replace(/\\n/g, "\n")
  let token = ""
  let at = 0
  // null = not asked yet. Asked once: the slug of an app does not change while a run lasts.
  let login = null
  let permissions = null
  const get = () => {
    const t = now().getTime()
    if (token && t - at < TOKEN_REFRESH_MS) return token
    const request = { appId: String(env.PIPELINE_APP_ID), repo, pem, login: login === null, ...(env.GITHUB_API_URL ? { apiUrl: env.GITHUB_API_URL } : {}) }
    // Started in the file system's root, not in a directory the agent has written to.
    const r = runProc(process.execPath, [...MINT_ARGS, source], { input: JSON.stringify(request), env: { PATH: env.PATH || "", HOME: env.HOME || "" }, cwd: parsePath(process.cwd()).root, timeoutMs: 60000 })
    let answer = null
    try {
      answer = JSON.parse(r.stdout.trim().split("\n").pop() || "null")
    } catch {
      // not an answer: reported below
    }
    if (r.rc !== 0 || !answer || typeof answer.token !== "string" || !answer.token.trim()) throw new Error(`could not mint the bot token: ${r.stderr.trim().slice(-300) || `exit ${r.rc}`}`)
    token = answer.token.trim()
    if (login === null) login = /^[\w.-]+\[bot\]$/.test(String(answer.login || "").trim()) ? String(answer.login).trim() : ""
    permissions = answer.permissions && typeof answer.permissions === "object" && !Array.isArray(answer.permissions) ? answer.permissions : null
    at = t
    return token
  }
  return Object.assign(get, {
    app: true,
    login: () => {
      if (login === null) get()
      return login || ""
    },
    permissions: () => {
      if (!token) get()
      return permissions
    },
  })
}

// -> a function returning the login(s) the pipeline's marks are believed from ("" = not
// known), worked out on first use and kept. Several logins are separated by commas.
//   the account the token really writes as:
//     an app's token:  "<app-slug>[bot]" (tokenSource asks for the slug when it mints)
//     a plain token:   the login of the user it belongs to (GET /user)
//   PIPELINE_BOT:      optional. Logins named there are believed as well (the bot the
//                      repository used before, say); they come first, and they are all there
//                      is when the account cannot be worked out.
// The account the pipeline really writes as is always in the answer when it can be found,
// whatever PIPELINE_BOT says: a role that does not believe its own marks repeats itself for
// ever (with a mistyped PIPELINE_BOT the tick opened a new decision item on every round).
// A PIPELINE_BOT that does not name that account is reported in the log.
// Not known is a safe answer, not an error: the roles then fall back to believing no verdict
// that the commit status does not name (core/marks.mjs believedReviews).
export function botLoginSource({ env, token, gh, log = () => {} }) {
  let known = null
  const firstLine = (e) => String(e?.message || e).split("\n")[0].slice(0, 200)
  return () => {
    if (known !== null) return known
    const given = String(env.PIPELINE_BOT || "").split(",").map((s) => s.trim()).filter(Boolean)
    let real = ""
    try {
      real = String((token.app ? token.login() : gh.get("/user")?.login) || "")
    } catch (e) {
      if (!given.length) log(`the pipeline's own login is not known: ${token.app ? firstLine(e) : `GET /user failed (${firstLine(e)})`}; set PIPELINE_BOT`)
    }
    const lower = (x) => x.toLowerCase()
    if (real && given.length && !given.map(lower).includes(lower(real)))
      log(`warning: PIPELINE_BOT is "${given.join(", ")}" but the pipeline writes as "${real}"; marks by "${real}" are believed as well. Set PIPELINE_BOT to "${real}".`)
    known = [...given, ...(real && !given.map(lower).includes(lower(real)) ? [real] : [])].join(",")
    return known
  }
}

// One object whose methods always go to a helper built with the current token.
function withToken(token, make, names) {
  let made = null
  let madeFor = null
  const current = () => {
    const t = token()
    if (t !== madeFor) [made, madeFor] = [make(t), t]
    return made
  }
  return Object.fromEntries(names.map((k) => [k, (...a) => current()[k](...a)]))
}

// The pipeline config as it is on the base branch, never as a working tree or a pull request
// head has it: a change under review must not be able to relax the rules it is judged by.
// The repository's default branch is read first; if its config names another `base`, that
// branch's copy is the one that counts.
export function loadRepoConfig({ git, home = HOME, base = "" }) {
  const readAt = (branch) => {
    git.remote(["fetch", "-q", "--no-tags", git.url, `+refs/heads/${branch}:refs/remotes/origin/${branch}`])
    const r = git.try(["show", `origin/${branch}:${CONFIG_PATH}`])
    if (r.rc !== 0) throw new Error(`no ${CONFIG_PATH} on branch "${branch}"`)
    const name = presetOf(r.stdout)
    const presetFile = name ? join(home, "presets", `${name}.yml`) : ""
    return loadConfig(r.stdout, presetFile && existsSync(presetFile) ? readFileSync(presetFile, "utf8") : null)
  }
  let first = base
  if (!first) {
    const head = git.remote(["ls-remote", "--symref", git.url, "HEAD"])
    first = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(head)?.[1] || ""
    if (!first) throw new Error("could not find the repository's default branch")
  }
  const config = readAt(first)
  return config.base === first ? config : readAt(config.base)
}

// env: the environment (GITHUB_REPOSITORY, the bot token or the app's id and key, the model
// credential); cwd: the user's repository checkout.
// Also read: GITHUB_SERVER_URL (other than github.com), PIPELINE_REPO_URL (the git remote, for
// trials against a local bare repository), PIPELINE_WORK_DIR (where agent transcripts go),
// PIPELINE_BOT (more logins whose marks are believed; the pipeline's own is worked out).
// tolerateConfig (the doctor): a config that is missing or does not load is not an error;
// io.config is then null and io.configError says why. Every other role fails right here.
export function makeIo({ env = process.env, cwd = process.cwd(), log = (line) => console.log(line), tolerateConfig = false } = {}) {
  const repo = String(env.GITHUB_REPOSITORY || "")
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("GITHUB_REPOSITORY must be set to owner/name")
  const repoDir = resolve(cwd)
  const now = () => new Date()
  const token = tokenSource({ env, repo, now })
  const url = env.PIPELINE_REPO_URL || `${String(env.GITHUB_SERVER_URL || "https://github.com").replace(/\/+$/, "")}/${repo}.git`
  const tmp = env.RUNNER_TEMP || tmpdir()

  const gh = { repo, ...withToken(token, (t) => makeGh({ repo, token: t }), ["get", "list", "post", "patch", "put", "del", "graphql", "dispatch"]) }
  const git = ({ cwd: dir = repoDir } = {}) => ({
    url,
    cwd: dir,
    ...withToken(token, (t) => makeGit({ repo, token: t, cwd: dir, url }), ["git", "try", "remote", "tryRemote"]),
  })

  const botLogin = botLoginSource({ env, token, gh, log })

  let workDir = env.PIPELINE_WORK_DIR || ""
  const claude = (opts) => {
    workDir ||= mkdtempSync(join(tmp, "pipeline-work-"))
    return runClaude(opts, { env, workDir, log })
  }
  claude.scratch = SCRATCH_PATHS

  // Shell lines from the config (stack.setup, stack.check) run code from the checkout, which
  // the agent may have written: they get the agent's environment, without any token.
  const shellEnv = agentEnv(env, {})

  let config = null
  let configError = ""
  try {
    config = loadRepoConfig({ git: git(), base: env.PIPELINE_BASE || "" })
  } catch (e) {
    if (!tolerateConfig) throw e
    configError = String(e?.message || e)
  }

  return {
    env: { ...env },
    now,
    log,
    gh,
    makeGit: git,
    proc: { run, must, shell: (line, opts = {}) => shell(line, { env: shellEnv, ...opts }) },
    fs: {
      read: (path) => readFileSync(path, "utf8"),
      write: (path, text) => {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, text)
      },
      exists: (path) => existsSync(path),
      mkdtemp: (prefix) => mkdtempSync(join(tmp, prefix)),
    },
    claude,
    ledger: makeLedger({ git: git(), url, log, label: `${env.GITHUB_WORKFLOW || "pipeline"} run ${env.GITHUB_RUN_ID || "0"}` }),
    // A random word for the delimiters around untrusted text in a prompt.
    nonce: () => randomBytes(6).toString("hex"),
    home: HOME,
    repoDir,
    config,
    ...(config ? {} : { configError }),
    // What the bot token may do, as GitHub reported it when an app's token was minted
    // ({ contents: "write", ... }); null for a plain token, or when no token could be minted.
    get tokenPermissions() {
      try {
        return token.permissions()
      } catch {
        return null
      }
    },
    // The login the pipeline writes under, "" when it cannot be worked out. Asked on first use.
    get botLogin() {
      return botLogin()
    },
  }
}
