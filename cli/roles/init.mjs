// The installer's mechanical half. The other half is the Claude Code skill in skills/init/,
// which talks to the person, decides what goes into the config and calls these four steps:
//
//   scan({ cwd }, deps)                         -> facts about the checkout and the repository on GitHub
//   files({ cwd, ref, ci, base, force }, deps)  -> writes the three caller workflows and the starter config
//   check({ cwd }, deps)                        -> { ok, results }: the files in the working tree, before they are merged
//   app({ cwd, repo, name, ... }, deps)         -> creates the GitHub App in the person's browser (GitHub's
//                                                  "manifest" flow), stores its key and id in the repository
//
// Unlike every other role this one runs on a person's machine, as that person: GitHub is
// reached through their own `gh` login, and nothing here runs in CI or starts an agent.
//
// The App's private key exists in this process's memory only: GitHub hands it over once, it
// goes to `gh secret set` on stdin, and it is never printed (the skill's output is read by a
// model) and never written to disk, unless storing it fails, in which case losing it would
// leave an App nobody holds the key of.
//
// deps (all injectable for tests): { proc(cmd, args, opts) -> { rc, stdout, stderr }, fetch, log(line), open(url), now() }
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadConfig, presetOf } from "../core/config.mjs"
import { mintAppToken } from "../io/app-token.mjs"
import { run as runProc } from "../io/proc.mjs"
import { BOT_VARIABLE, CALLERS, NEEDED, parseCaller } from "./doctor.mjs"

const ENGINE_ROOT = fileURLToPath(new URL("../..", import.meta.url))
const CONFIG_PATH = ".coteam/pipeline.yml"
// What the templates carry where the installed release goes.
export const TEMPLATE_REF = "v0.2.0"
// GitHub's limit on the name of an App.
const APP_NAME_MAX = 34
const GITHUB = "https://github.com"

export const TEXT = {
  usage: [
    "usage: main.mjs init <step>",
    "  init scan                                  facts about this checkout, as JSON",
    "  init files [--ref R] [--ci \"CI,Lint\"] [--base B] [--force]",
    "                                             write the three workflows and the starter config",
    "  init check                                 check those files in the working tree",
    "  init app [--repo owner/name] [--name N] [--no-open] [--force] [--timeout MINUTES]",
    "                                             create the GitHub App in your browser and store its key and id",
  ].join("\n"),
  notGit: "this directory is not a git checkout",
  noRemote: 'the checkout has no GitHub remote named "origin" (the code must be on GitHub); pass --repo owner/name if the remote has another name',
  noGh: (why) => `GitHub could not be asked through the gh command line tool: ${why}`,
  ghHint: "Install gh (https://cli.github.com) and log in with: gh auth login",
  files: {
    wrote: (path) => `wrote ${path}`,
    kept: (path) => `kept  ${path} (it exists; --force overwrites it)`,
    ref: (repo, ref, how) => `engine: ${repo}@${ref} (${how})`,
    refRelease: "the release this installer belongs to",
    refCommit: "no release tag for this version yet, so the engine's current commit is pinned",
    refGiven: "as given",
    noRef: (repo, why) => `the engine's ref could not be worked out from ${repo} (${why}); pass --ref with a release tag or a full commit SHA`,
    badCi: (name) => `a workflow name given in --ci cannot be used: ${JSON.stringify(name)}`,
    selfCi: "pipeline-tick must not be listed in --ci: it would start itself forever",
    next: `Now edit ${CONFIG_PATH} (stack, owners, risk) and run: init check`,
  },
  check: {
    configOk: (c) => `${CONFIG_PATH} loads (mode ${c.mode}, base ${c.base})`,
    configMissing: `${CONFIG_PATH} is missing`,
    configBad: (why) => `${CONFIG_PATH} does not load: ${why}`,
    notRecord: (mode) => `mode is "${mode}": a new installation should start in "record", which merges nothing`,
    testEmpty: "stack.test is empty: the executor has no way to run the tests",
    checkEmpty: "stack.check is empty: nothing is run before a pull request is opened (fine only if your CI is the one gate you want)",
    noOwners: "owners is empty: the repository's admins and maintainers answer the pipeline's questions (naming them is safer)",
    noLevel3: "risk.level3 is empty: no path is held for an owner, whatever it touches",
    missing: (file) => `.github/workflows/${file} is missing`,
    noUses: (file, reusable) => `${file} does not call the engine's ${reusable} workflow`,
    refMismatch: (file, uses, input) => `${file} calls the engine at @${uses} but passes engine_ref: ${input || "(nothing)"}`,
    differ: (list) => `the three workflows do not use the same engine: ${list.join("; ")}`,
    floating: (ref) => `the engine ref "${ref}" is a branch, not a release tag or a commit: the pipeline changes whenever that branch does`,
    selfRun: "pipeline-tick.yml lists itself under workflow_run: it would start itself forever",
    noCi: "pipeline-tick.yml lists none of your own CI workflows under workflow_run: a pull request whose CI went green waits for the half-hourly schedule",
    workflowsOk: (engine, ref) => `the three workflows are in place and all use ${engine}@${ref}`,
    summary: (c) => `${c.FAIL ? "Not ready" : "Ready to commit"}: ${c.ok} ok, ${c.warn} warning${c.warn === 1 ? "" : "s"}, ${c.FAIL} failed.`,
  },
  app: {
    notAdmin: (repo) => `you are not an admin of ${repo}: storing the App's key as a secret needs admin access`,
    exists: (id) => `this repository already has PIPELINE_APP_ID = ${id}: an App is set up. Pass --force to create another one and replace it.`,
    open: (url) => `Open this page in your browser (it was opened for you if this machine has one):\n  ${url}`,
    whatNext: (owner) => `GitHub will show "Create GitHub App for ${owner}" with the name and the permissions filled in. Press the green button.`,
    waiting: "Waiting for GitHub to send you back here...",
    timeout: (minutes) => `nothing came back from GitHub within ${minutes} minutes. Nothing was created unless you pressed "Create GitHub App"; if you did, delete that App in your GitHub settings and start again.`,
    badState: "a request came back that this run did not start; it was ignored",
    created: (slug, id) => `App created: ${slug} (App ID ${id}). It will write as ${slug}[bot].`,
    stored: (names) => `stored in the repository: ${names.join(", ")}`,
    storeFailed: (name, why) => `${name} could not be stored: ${why}`,
    keySaved: (path, repo) => `The App's private key was saved to ${path} so that it is not lost. Store it with:\n  gh secret set PIPELINE_APP_KEY --repo ${repo} < ${path}\nand delete the file afterwards.`,
    install: (url, repo) => `Last step in the browser: install the App. Choose "Only select repositories", pick ${repo}, press Install.\n  ${url}`,
    installed: (repo) => `the App is installed on ${repo}`,
    notInstalled: (url, repo, minutes) => `the App was not installed on ${repo} within ${minutes} minutes. Open ${url} to install it; everything else is done.`,
    permsOk: "the App's token has exactly the access the pipeline needs",
    permsShort: (list) => `the App's token lacks: ${list.join(", ")}`,
    permsHint: "Open the App's settings, fix Repository permissions, then accept the new permissions on its installation.",
    page: {
      title: "coteam-pipeline: create the GitHub App",
      go: "Taking you to GitHub...",
      button: "Continue to GitHub",
      done: "The App was created and its key is stored. Taking you to the installation page...",
      failed: (why) => `Something went wrong: ${why}. Look at the terminal.`,
    },
    description: "The bot of the coteam-pipeline installation in this repository. It opens, reviews and merges pull requests.",
  },
}

const realDeps = (given = {}) => ({
  proc: given.proc || runProc,
  fetch: given.fetch || globalThis.fetch,
  log: given.log || ((s) => console.log(s)),
  open: given.open || openBrowser,
  now: given.now || (() => new Date()),
  sleep: given.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))),
})

function openBrowser(url) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]]
  try {
    runProc(cmd, args, { timeoutMs: 5000 })
  } catch {
    // no browser on this machine: the person opens the printed address themselves
  }
}

const firstLine = (s) => String(s || "").trim().split("\n")[0].slice(0, 200)

// "git@github.com:acme/app.git" | "https://github.com/acme/app" -> "acme/app" ("" when it is not GitHub)
export function repoOf(remote) {
  const m = /github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(remote || "").trim())
  return m ? `${m[1]}/${m[2]}` : ""
}

// ---------- scan ----------

const TEST_FILE = /(^|\/)(tests?|__tests__|spec|specs)\/|[._-](test|spec)\.[a-z]+$|_test\.(go|py|rb)$|(^|\/)test_[^/]+\.py$/i
const SOURCE_FILE = /\.(js|jsx|mjs|cjs|ts|tsx|vue|svelte|py|go|rs|rb|java|kt|swift|php|cs|ex|exs)$/i
const VENDORED = /(^|\/)(node_modules|vendor|dist|build|\.next|target)\//
const RISKY = /^(auth|authn|authz|login|logins|session|sessions|oauth|sso|password|passwords|payment|payments|billing|checkout|stripe|paypal|migration|migrations|migrate|secret|secrets|crypto|permission|permissions|acl|rbac|security)$/i
const UI_EXT = ["tsx", "jsx", "vue", "svelte", "css", "scss", "html"]

// The commands a codebase most likely uses, from the files at its root. A proposal for the
// skill to check against the repository's CI, not a finding.
export function stackOf(files, read) {
  const has = (f) => files.includes(f)
  const notes = []
  if (has("package.json")) {
    let pkg = {}
    try {
      pkg = JSON.parse(read("package.json"))
    } catch {
      notes.push("package.json could not be parsed")
    }
    const scripts = pkg.scripts || {}
    const [pm, install] = has("pnpm-lock.yaml")
      ? ["pnpm", "pnpm install --frozen-lockfile"]
      : has("yarn.lock")
        ? ["yarn", "yarn install --frozen-lockfile"]
        : has("bun.lockb") || has("bun.lock")
          ? ["bun", "bun install --frozen-lockfile"]
          : has("package-lock.json")
            ? ["npm", "npm ci"]
            : ["npm", "npm install"]
    const real = (name) => typeof scripts[name] === "string" && !/no test specified/.test(scripts[name])
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length
    if (!real("test")) notes.push('package.json has no "test" script')
    if (pm !== "npm") notes.push(`${pm} must be on the runner: GitHub's runners carry npm and yarn; for others add a step such as "corepack enable" to stack.setup`)
    return {
      kind: "node",
      setup: deps || pm !== "npm" || has("package-lock.json") ? [install] : [],
      test: real("test") ? `${pm} test` : "",
      check: ["lint", "typecheck", "type-check"].filter(real).map((s) => `${pm} run ${s}`),
      notes,
    }
  }
  if (has("go.mod")) return { kind: "go", setup: [], test: "go test ./...", check: ["go vet ./..."], notes }
  if (has("Cargo.toml")) return { kind: "rust", setup: [], test: "cargo test", check: ["cargo clippy -- -D warnings"], notes }
  if (has("pyproject.toml") || has("requirements.txt") || has("setup.py")) {
    const py = has("pyproject.toml") ? read("pyproject.toml") : ""
    const setup = has("uv.lock") ? "uv sync" : has("poetry.lock") ? "poetry install" : has("requirements.txt") ? "pip install -r requirements.txt" : "pip install -e ."
    const prefix = has("uv.lock") ? "uv run " : has("poetry.lock") ? "poetry run " : ""
    if (prefix) notes.push(`${prefix.trim().split(" ")[0]} must be on the runner: add its installation to stack.setup`)
    return { kind: "python", setup: [setup], test: `${prefix}pytest`, check: /\[tool\.ruff/.test(py) ? [`${prefix}ruff check .`] : [], notes }
  }
  if (has("Gemfile")) return { kind: "ruby", setup: ["bundle install"], test: files.some((f) => f.startsWith("spec/")) ? "bundle exec rspec" : "bin/rails test", check: [], notes }
  notes.push("no known project file at the root: the commands have to come from the person or from the CI workflow")
  return { kind: "unknown", setup: [], test: "", check: [], notes }
}

// The repository's own workflows (not the pipeline's): [{ file, name, pull_request }].
// `name` is what a workflow_run trigger has to list: the workflow's name, or its path when it has none.
export function ciOf(files, read) {
  const own = new Set(CALLERS.map((c) => `.github/workflows/${c.file}`))
  return files
    .filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f) && !own.has(f))
    .map((file) => {
      const text = read(file)
      const name = /^name:\s*(.+?)\s*$/m.exec(text)
      const triggers = parseCaller(text).triggers
      return { file, name: name ? name[1].replace(/^["']|["']$/g, "") : file, pull_request: triggers.some((t) => t === "pull_request" || t === "pull_request_target") }
    })
}

// Directories and files whose name says a mistake there is expensive, shortest path first.
export function riskyOf(files) {
  const seen = new Set()
  for (const f of files) {
    if (VENDORED.test(f) || TEST_FILE.test(f)) continue
    const parts = f.split("/")
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1
      const word = last ? parts[i].replace(/\.[^.]+$/, "") : parts[i]
      if (!RISKY.test(word)) continue
      seen.add(last ? f : `${parts.slice(0, i + 1).join("/")}/**`)
      break
    }
  }
  return [...seen].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b)).slice(0, 30)
}

// Where the files that change what users see are: [{ glob, files }], most files first.
export function uiOf(files) {
  const count = new Map()
  for (const f of files) {
    if (VENDORED.test(f) || TEST_FILE.test(f)) continue
    const ext = UI_EXT.find((e) => f.toLowerCase().endsWith(`.${e}`))
    if (!ext) continue
    const top = f.includes("/") ? f.split("/")[0] : ""
    const glob = top ? `${top}/**/*.${ext}` : `*.${ext}`
    count.set(glob, (count.get(glob) || 0) + 1)
  }
  return [...count].map(([glob, n]) => ({ glob, files: n })).sort((a, b) => b.files - a.files).slice(0, 8)
}

function ghJson(proc, args) {
  let r
  try {
    r = proc("gh", args, { timeoutMs: 30000 })
  } catch (e) {
    return { ok: false, why: firstLine(e?.message || e) }
  }
  if (r.rc !== 0) return { ok: false, why: firstLine(r.stderr) || `gh exited with ${r.rc}` }
  try {
    return { ok: true, value: r.stdout.trim() ? JSON.parse(r.stdout) : null }
  } catch {
    return { ok: false, why: "gh did not answer with JSON" }
  }
}

// What GitHub says about the repository, through the person's own gh login.
function githubFacts(repo, proc) {
  const info = ghJson(proc, ["api", `repos/${repo}`])
  if (!info.ok) return { error: TEXT.noGh(info.why), hint: TEXT.ghHint }
  const v = info.value || {}
  const names = (path, key) => {
    const r = ghJson(proc, ["api", `repos/${repo}/${path}?per_page=100`])
    return r.ok ? (r.value?.[key] || []).map((x) => x.name) : null
  }
  const actions = ghJson(proc, ["api", `repos/${repo}/actions/permissions`])
  const variables = ghJson(proc, ["api", `repos/${repo}/actions/variables?per_page=100`])
  let scopes = null
  try {
    const s = proc("gh", ["auth", "status"], { timeoutMs: 15000 })
    const m = /Token scopes:\s*(.+)/.exec(`${s.stdout}\n${s.stderr}`)
    if (m) scopes = m[1].replace(/['"]/g, "").split(",").map((x) => x.trim()).filter(Boolean)
  } catch {
    // not knowing the scopes is not a problem of its own
  }
  return {
    default_branch: v.default_branch || "",
    private: Boolean(v.private),
    owner: v.owner?.login || repo.split("/")[0],
    owner_is_organization: v.owner?.type === "Organization",
    admin: Boolean(v.permissions?.admin),
    merge_methods: { squash: v.allow_squash_merge !== false, merge: v.allow_merge_commit !== false, rebase: v.allow_rebase_merge !== false },
    actions_enabled: actions.ok ? actions.value?.enabled !== false : null,
    actions_allowed: actions.ok ? actions.value?.allowed_actions || "all" : null,
    secrets: names("actions/secrets", "secrets"),
    variables: variables.ok ? (variables.value?.variables || []).map((x) => x.name) : null,
    app_id: variables.ok ? (variables.value?.variables || []).find((x) => x.name === "PIPELINE_APP_ID")?.value || "" : "",
    // Pushing a workflow file over https needs the "workflow" scope on the person's token.
    can_push_workflows: scopes ? scopes.includes("workflow") : null,
  }
}

function checkout(cwd, proc) {
  const git = (args) => proc("git", args, { cwd })
  const ls = git(["ls-files", "-z"])
  if (ls.rc !== 0) throw new Error(TEXT.notGit)
  return { git, files: ls.stdout.split("\0").filter(Boolean) }
}

export function scan({ cwd }, given) {
  const { proc } = realDeps(given)
  const { git, files } = checkout(cwd, proc)
  const read = (f) => {
    try {
      return readFileSync(join(cwd, f), "utf8")
    } catch {
      return ""
    }
  }
  const repo = repoOf(git(["remote", "get-url", "origin"]).stdout)
  const code = files.filter((f) => !VENDORED.test(f))
  const tests = code.filter((f) => TEST_FILE.test(f) && SOURCE_FILE.test(f))
  const npmrc = files.includes(".npmrc") ? read(".npmrc") : ""
  const pkg = JSON.parse(readFileSync(join(ENGINE_ROOT, "package.json"), "utf8"))
  return {
    repo,
    problem: repo ? "" : TEXT.noRemote,
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim(),
    dirty: git(["status", "--porcelain"]).stdout.trim() !== "",
    github: repo ? githubFacts(repo, proc) : null,
    stack: stackOf(files, read),
    ci: ciOf(files, read),
    tests: { test_files: tests.length, source_files: code.filter((f) => SOURCE_FILE.test(f) && !TEST_FILE.test(f)).length },
    risky_paths: riskyOf(files),
    ui_paths: uiOf(files),
    agent_instructions: ["CLAUDE.md", "AGENTS.md"].filter((f) => files.includes(f)),
    // The agent is given no registry token (docs/install.md, "Known limits").
    private_registry: /_authToken|_auth\s*=/.test(npmrc) || (/registry\s*=/.test(npmrc) && !/registry\s*=\s*https:\/\/registry\.npmjs\.org/.test(npmrc)),
    installed: [CONFIG_PATH, ...CALLERS.map((c) => `.github/workflows/${c.file}`)].filter((f) => existsSync(join(cwd, f))),
    engine: { repo: engineRepo(), version: pkg.version },
  }
}

// ---------- files ----------

const template = (path) => readFileSync(join(ENGINE_ROOT, "templates", path), "utf8")

// The engine repository, as the templates name it.
export function engineRepo() {
  return parseCaller(template("workflows/pipeline-tick.yml")).uses.repo
}

const PINNED = /^(v?\d+\.\d+\.\d+([-.+][\w.-]+)?|[0-9a-f]{40})$/

// The ref to install: the release tag of this installer's version when it exists, else the
// commit the engine's default branch is at now (a full SHA: pinned all the same).
function resolveRef(repo, proc) {
  const version = JSON.parse(readFileSync(join(ENGINE_ROOT, "package.json"), "utf8")).version
  const tag = `v${version}`
  let r
  try {
    r = proc("git", ["ls-remote", `${GITHUB}/${repo}`, "HEAD", `refs/tags/${tag}`], { timeoutMs: 30000 })
  } catch (e) {
    throw new Error(TEXT.files.noRef(repo, firstLine(e?.message || e)))
  }
  if (r.rc !== 0) throw new Error(TEXT.files.noRef(repo, firstLine(r.stderr) || `git exited with ${r.rc}`))
  const rows = r.stdout.split("\n").map((l) => l.trim().split(/\s+/))
  if (rows.some(([, name]) => name === `refs/tags/${tag}`)) return { ref: tag, how: TEXT.files.refRelease }
  const head = rows.find(([sha, name]) => name === "HEAD" && /^[0-9a-f]{40}$/.test(sha || ""))
  if (!head) throw new Error(TEXT.files.noRef(repo, "the remote named no HEAD"))
  return { ref: head[0], how: TEXT.files.refCommit }
}

// One caller template with the ref put in, and for the dispatcher the repository's own CI
// workflows added to the runs it wakes up on.
export function renderCaller(file, { ref, ci = [] }) {
  let text = template(`workflows/${file}`).split(`@${TEMPLATE_REF}`).join(`@${ref}`).split(`engine_ref: ${TEMPLATE_REF}`).join(`engine_ref: ${ref}`)
  // The first line says where to copy the template to; in its place it says where it came from.
  text = text.replace(/^# Copy to [^\n]*\n/, "# Written by the coteam-pipeline installer from the engine's template of the same name.\n")
  if (file === "pipeline-tick.yml" && ci.length) {
    const list = ["pipeline-fix", "pipeline-review", ...ci].map((n) => JSON.stringify(n)).join(", ")
    text = text.replace('workflows: ["pipeline-fix", "pipeline-review"]', `workflows: [${list}]`)
  }
  return text
}

export function files({ cwd, ref, ci = [], base, force = false }, given) {
  const { proc, log } = realDeps(given)
  const names = [...new Set(ci.map((n) => String(n).trim()).filter(Boolean))]
  for (const n of names) {
    if (/["\n\r\\]/.test(n) || n.length > 200) throw new Error(TEXT.files.badCi(n))
    if (n === "pipeline-tick") throw new Error(TEXT.files.selfCi)
  }
  const repo = engineRepo()
  const picked = ref ? { ref: String(ref), how: TEXT.files.refGiven } : resolveRef(repo, proc)
  log(TEXT.files.ref(repo, picked.ref, picked.how))
  if (!PINNED.test(picked.ref)) log(`warn  ${TEXT.check.floating(picked.ref)}`)
  const out = [
    ...CALLERS.map((c) => [`.github/workflows/${c.file}`, renderCaller(c.file, { ref: picked.ref, ci: names })]),
    [CONFIG_PATH, base ? template("pipeline.yml").replace(/^base: .*$/m, `base: ${base}`) : template("pipeline.yml")],
  ]
  const wrote = []
  const kept = []
  for (const [path, text] of out) {
    const full = join(cwd, path)
    if (existsSync(full) && !force) {
      kept.push(path)
      log(TEXT.files.kept(path))
      continue
    }
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, text)
    wrote.push(path)
    log(TEXT.files.wrote(path))
  }
  if (wrote.includes(CONFIG_PATH)) log(TEXT.files.next)
  return { ok: true, ref: picked.ref, engine: repo, wrote, kept }
}

// ---------- check ----------

// The four files as they are in the working tree. The doctor checks the same things on the
// base branch, which is too late for a pull request that has not been merged yet.
export function check({ cwd }, given) {
  const { log } = realDeps(given)
  const T = TEXT.check
  const results = []
  const add = (state, text) => {
    results.push({ state, text })
    log(`${state.padEnd(4)}  ${text}`)
  }
  const file = join(cwd, CONFIG_PATH)
  if (!existsSync(file)) add("FAIL", T.configMissing)
  else {
    try {
      const text = readFileSync(file, "utf8")
      const name = presetOf(text)
      const preset = name ? join(ENGINE_ROOT, "presets", `${name}.yml`) : ""
      const config = loadConfig(text, preset && existsSync(preset) ? readFileSync(preset, "utf8") : null)
      add("ok", T.configOk(config))
      if (config.mode !== "record") add("warn", T.notRecord(config.mode))
      if (!String(config.stack.test || "").trim()) add("FAIL", T.testEmpty)
      if (!(config.stack.check || []).length) add("warn", T.checkEmpty)
      if (!(config.owners || []).length) add("warn", T.noOwners)
      if (!(config.risk.level3 || []).length) add("warn", T.noLevel3)
    } catch (e) {
      add("FAIL", T.configBad(firstLine(e?.message || e)))
    }
  }
  const engines = []
  let bad = false
  for (const c of CALLERS) {
    const full = join(cwd, ".github/workflows", c.file)
    if (!existsSync(full)) {
      bad = true
      add("FAIL", T.missing(c.file))
      continue
    }
    const text = readFileSync(full, "utf8")
    const p = parseCaller(text)
    if (!p.uses || p.uses.reusable !== c.reusable) {
      bad = true
      add("FAIL", T.noUses(c.file, c.reusable))
      continue
    }
    engines.push({ file: c.file, repo: p.uses.repo, ref: p.uses.ref })
    if (p.engineRef !== p.uses.ref) {
      bad = true
      add("FAIL", T.refMismatch(c.file, p.uses.ref, p.engineRef))
    }
    if (c.reusable === "tick") {
      const runs = /^\s*workflows:\s*\[([^\]]*)\]/m.exec(text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n"))
      const listed = runs ? runs[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean) : []
      if (listed.includes("pipeline-tick")) {
        bad = true
        add("FAIL", T.selfRun)
      }
      if (!listed.some((n) => !/^pipeline-(fix|review|tick)$/.test(n))) add("warn", T.noCi)
    }
  }
  if (engines.length === CALLERS.length) {
    if (new Set(engines.map((e) => `${e.repo.toLowerCase()}@${e.ref}`)).size > 1) add("FAIL", T.differ(engines.map((e) => `${e.file}: ${e.repo}@${e.ref}`)))
    else {
      if (!bad) add("ok", T.workflowsOk(engines[0].repo, engines[0].ref))
      if (!PINNED.test(engines[0].ref)) add("warn", T.floating(engines[0].ref))
    }
  }
  const counts = { ok: 0, warn: 0, FAIL: 0 }
  for (const r of results) counts[r.state]++
  log(T.summary(counts))
  return { ok: counts.FAIL === 0, results, counts }
}

// ---------- app ----------

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const page = (body) => `<!doctype html><meta charset="utf-8"><title>${esc(TEXT.app.page.title)}</title><body style="font:16px system-ui;margin:3em">${body}</body>`

// What GitHub is asked to create: an App with exactly the access the engine needs
// (cli/roles/doctor.mjs NEEDED), no events, installable on its owner's account only.
export function manifestOf({ name, repo, redirect }) {
  return {
    name,
    description: TEXT.app.description,
    url: `${GITHUB}/${repo}`,
    // The App receives no events; GitHub's form still wants an address in this field.
    hook_attributes: { url: `${GITHUB}/${repo}`, active: false },
    redirect_url: redirect,
    public: false,
    default_permissions: { metadata: "read", ...NEEDED },
    default_events: [],
  }
}

export const appNameOf = (repo) => `${repo.split("/")[1]}`.slice(0, APP_NAME_MAX - "-pipeline".length).replace(/[._-]+$/, "") + "-pipeline"

export async function app(opts, given) {
  const deps = realDeps(given)
  const { proc, log, fetch } = deps
  const T = TEXT.app
  const minutes = Number(opts.timeoutMinutes) > 0 ? Number(opts.timeoutMinutes) : 10
  const repo = opts.repo || repoOf(checkout(opts.cwd, proc).git(["remote", "get-url", "origin"]).stdout)
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(TEXT.noRemote)

  // Everything that can be refused is asked before anything is created.
  const facts = githubFacts(repo, proc)
  if (facts.error) throw new Error(`${facts.error}\n${facts.hint}`)
  if (!facts.admin) throw new Error(T.notAdmin(repo))
  if (facts.app_id && !opts.force) throw new Error(T.exists(facts.app_id))

  const name = String(opts.name || appNameOf(repo)).slice(0, APP_NAME_MAX)
  const state = randomBytes(24).toString("hex")
  // An App that is installable "only on this account" must belong to the account that owns
  // the repository: the organisation for an organisation's repository.
  const target = facts.owner_is_organization ? `${GITHUB}/organizations/${facts.owner}/settings/apps/new` : `${GITHUB}/settings/apps/new`

  const created = await new Promise((resolve, reject) => {
    let base = ""
    const server = createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1")
      // `sent` runs once the browser has the whole answer: the server is only closed after that.
      const send = (code, body, headers = {}, sent) => res.writeHead(code, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", connection: "close", ...headers }).end(body, sent)
      if (req.method === "GET" && url.pathname === "/") {
        const manifest = JSON.stringify(manifestOf({ name, repo, redirect: `${base}/done` }))
        return send(200, page(`<p>${esc(T.page.go)}</p><form id="f" method="post" action="${esc(`${target}?state=${state}`)}"><input type="hidden" name="manifest" value="${esc(manifest)}"><button>${esc(T.page.button)}</button></form><script>document.getElementById("f").submit()</script>`))
      }
      if (req.method === "GET" && url.pathname === "/done") {
        if (url.searchParams.get("state") !== state || !/^[\w-]+$/.test(url.searchParams.get("code") || "")) {
          log(T.badState)
          return send(400, page(`<p>${esc(T.page.failed(T.badState))}</p>`))
        }
        return convert(url.searchParams.get("code")).then(
          (a) => send(302, page(`<p>${esc(T.page.done)}</p>`), { location: `${a.html_url}/installations/new` }, () => finish(() => resolve(a))),
          (e) => send(500, page(`<p>${esc(T.page.failed(firstLine(e?.message || e)))}</p>`), {}, () => finish(() => reject(e))),
        )
      }
      send(404, page(""))
    })
    const timer = setTimeout(() => finish(() => reject(new Error(T.timeout(minutes)))), minutes * 60000)
    const finish = (then) => {
      clearTimeout(timer)
      server.close()
      server.closeAllConnections?.()
      then()
    }
    // The key is traded for the one-time code here, and stored before the browser is told
    // anything: once this returns, the App is usable or the reason it is not has been printed.
    const convert = async (code) => {
      const r = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
        method: "POST",
        headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "coteam-pipeline" },
        signal: AbortSignal.timeout(30000),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || !j.id || !j.pem || !j.slug) throw new Error(`GitHub did not hand over the App (${r.status} ${j.message || ""})`.trim())
      const a = { id: String(j.id), slug: String(j.slug), pem: String(j.pem), html_url: String(j.html_url || `${GITHUB}/apps/${j.slug}`) }
      log(T.created(a.slug, a.id))
      store(a)
      return a
    }
    const store = (a) => {
      const set = (args, input) => {
        const r = proc("gh", args, { input, timeoutMs: 30000 })
        if (r.rc !== 0) throw new Error(firstLine(r.stderr) || `gh exited with ${r.rc}`)
      }
      const stored = []
      try {
        set(["secret", "set", "PIPELINE_APP_KEY", "--repo", repo], a.pem)
        stored.push("secret PIPELINE_APP_KEY")
      } catch (e) {
        log(T.storeFailed("PIPELINE_APP_KEY", firstLine(e?.message || e)))
        const path = join(mkdtempSync(join(tmpdir(), "coteam-pipeline-")), `${a.slug}.pem`)
        writeFileSync(path, a.pem, { mode: 0o600 })
        log(T.keySaved(path, repo))
      }
      for (const [k, v] of [["PIPELINE_APP_ID", a.id], [BOT_VARIABLE, `${a.slug}[bot]`]]) {
        try {
          set(["variable", "set", k, "--repo", repo, "--body", v])
          stored.push(`variable ${k}`)
        } catch (e) {
          log(T.storeFailed(k, firstLine(e?.message || e)))
        }
      }
      if (stored.length) log(T.stored(stored))
      a.stored = stored
    }
    server.on("error", (e) => finish(() => reject(e)))
    server.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${server.address().port}`
      log(T.open(`${base}/`))
      log(T.whatNext(facts.owner))
      log(T.waiting)
      if (!opts.noOpen) Promise.resolve(deps.open(`${base}/`)).catch(() => {})
    })
  })

  // Installing is the person's click; wait for it, then ask GitHub what the App's token may do.
  const installUrl = `${created.html_url}/installations/new`
  log(T.install(installUrl, repo))
  const result = { ok: false, repo, appId: created.id, slug: created.slug, login: `${created.slug}[bot]`, stored: created.stored, installed: false, missing: [] }
  const until = deps.now().getTime() + minutes * 60000
  for (;;) {
    try {
      const { permissions } = await mintAppToken({ appId: created.id, pem: created.pem, repo, fetch, now: deps.now() })
      result.installed = true
      log(T.installed(repo))
      const rank = { read: 1, write: 2, admin: 3 }
      result.missing = Object.keys(NEEDED).filter((k) => (rank[permissions[k]] || 0) < rank[NEEDED[k]])
      if (result.missing.length) {
        log(T.permsShort(result.missing))
        log(T.permsHint)
      } else log(T.permsOk)
      break
    } catch (e) {
      // "not installed yet" is GitHub answering 404 to the App; anything else will not get better by waiting
      if (!/-> 404\b/.test(String(e?.message || e))) throw e
      if (deps.now().getTime() >= until) {
        log(T.notInstalled(installUrl, repo, minutes))
        break
      }
      await deps.sleep(3000)
    }
  }
  result.ok = result.installed && !result.missing.length && result.stored.length === 3
  return result
}
