// Is the machine the agent's job runs on fit to run the agent? The agent part of both roles
// asks before anything from the repository runs (no setup command, no agent).
//
// Two things are refused:
//   - a self-hosted runner for a public repository, unless the config says otherwise
//     (self_hosted.allow_public). A self-hosted machine keeps what a job leaves behind, and
//     on it the agent sits next to whatever else the runner's user can read.
//   - an agent CLI that cannot be started, or is older than the engine was written for. On
//     GitHub's machines the workflow installs the pinned version; on a self-hosted one the
//     machine's own CLI is used, with the login it already has.
// A refusal is reported as the agent being unavailable ("runner"): nothing is charged to the
// issue, and the tick waits a while before it tries again (core/ledger.mjs claudeCooldown).

// The oldest Claude Code CLI the engine works with. The workflows install a newer, pinned one.
export const MIN_CLAUDE = "2.1.0"

export const TEXT = {
  publicRepo: (repo) =>
    `${repo} is public and this job runs on a self-hosted runner. The agent runs the repository's code and stays on that machine; for a public repository that is refused. Run the agent's job on GitHub's machines (leave PIPELINE_AGENT_RUNS_ON empty), or, if you accept the risk, set self_hosted.allow_public: true in .coteam/pipeline.yml.`,
  visibility: (repo, why) => `could not tell whether ${repo} is public (${why}); a self-hosted runner is only used for a repository known to be private`,
  noCli: (bin, why) => `the agent CLI "${bin}" cannot be started on this machine (${why}). Install Claude Code for the runner's user, put it on the runner's PATH, or name it in PIPELINE_CLAUDE_BIN (the runner's .env file).`,
  oldCli: (bin, got, min) => `the agent CLI "${bin}" is version ${got}; the engine needs ${min} or later`,
  noVersion: (bin, said) => `the agent CLI "${bin}" did not say which version it is (it said: ${said})`,
}

const firstLine = (e) => String(e?.message || e).split("\n")[0].slice(0, 200)

// "2.1.302 (Claude Code)" -> [2, 1, 302]; null when there is no version in it.
export function versionOf(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text || ""))
  return m ? m.slice(1, 4).map(Number) : null
}

export function atLeast(v, min) {
  const want = versionOf(min)
  for (let i = 0; i < 3; i++) if (v[i] !== want[i]) return v[i] > want[i]
  return true
}

export const isSelfHosted = (env) => String(env?.PIPELINE_RUNNER_ENVIRONMENT || env?.RUNNER_ENVIRONMENT || "").toLowerCase() === "self-hosted"

// -> "" when the agent may run here, otherwise why not (one paragraph, for the job log).
//   env: the job's environment (PIPELINE_RUNNER_ENVIRONMENT, PIPELINE_REPO_PRIVATE: set by the
//   workflow); gh: io.gh (asked for the visibility when the workflow did not say); config: the
//   loaded config; run: proc.run; bin: the agent CLI.
export function machineProblem({ env, gh, config, run, bin = "claude" }) {
  if (isSelfHosted(env) && !config?.self_hosted?.allow_public) {
    // The workflow passes what the event says (github.event.repository.private); asking
    // GitHub needs the gh CLI, which a self-hosted machine may not have.
    let priv = { true: true, false: false }[String(env?.PIPELINE_REPO_PRIVATE ?? "").trim().toLowerCase()]
    if (priv === undefined) {
      try {
        priv = gh.get(`/repos/${gh.repo}`)?.private
      } catch (e) {
        return TEXT.visibility(gh.repo, firstLine(e))
      }
    }
    if (priv !== true) return typeof priv === "boolean" ? TEXT.publicRepo(gh.repo) : TEXT.visibility(gh.repo, "GitHub did not say")
  }
  let r
  try {
    r = run(bin, ["--version"], { timeoutMs: 60000 })
  } catch (e) {
    return TEXT.noCli(bin, firstLine(e))
  }
  if (r.rc !== 0) return TEXT.noCli(bin, `exit ${r.rc}: ${String(r.stderr || "").trim().slice(-200)}`)
  const v = versionOf(r.stdout)
  if (!v) return TEXT.noVersion(bin, String(r.stdout || "").trim().slice(0, 100))
  if (!atLeast(v, MIN_CLAUDE)) return TEXT.oldCli(bin, v.join("."), MIN_CLAUDE)
  return ""
}

// ---------- doctor --runner: the machine itself ----------
//
// Run by a person on the machine the agent's job is to run on, as the runner's user
// (`main.mjs doctor --runner [--try]`). It reads files and asks programs for their version;
// it never prints what a credential file holds, only that it is there.
//   deps: { env, home, platform, uid, run, exists, read, list } (main.mjs passes the real ones)
//   tryAgent: also ask the agent CLI one tiny question (costs one request)
// -> { ok, results: [{ id, state, text, hint }] }; ok is false when a check FAILed.

export const RUNNER_TEXT = {
  title: "Pipeline doctor for this machine (the agent's job runs here)",
  summary: (c) => `${c.FAIL ? "Not ready" : "Ready"}: ${c.ok} ok, ${c.warn} warning${c.warn === 1 ? "" : "s"}, ${c.FAIL} failed.`,
  git: { ok: (v) => `git is installed (${v})`, missing: "git is not installed or not on the PATH", hint: "Install git for the runner's user." },
  cli: { ok: (bin, v) => `the agent CLI "${bin}" is version ${v}` },
  login: {
    env: (names) => `this shell has ${names.join(" and ")}; a secret the workflow passes takes its place`,
    file: (path) => `the agent CLI is logged in for this user (${path})`,
    keychain: "the agent CLI may keep its login in the macOS keychain, which cannot be read from here",
    keychainHint: "Run the doctor again with --try: it asks the CLI one tiny question.",
    none: "the agent CLI is not logged in for this user, and no model credential is set",
    noneHint: "Run `claude` once as the runner's user and log in, or give the workflow ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN as a secret.",
    tried: "the agent CLI answered a test question",
    failed: (why) => `the agent CLI did not answer a test question: ${why}`,
  },
  github: {
    env: (names) => `a GitHub token is in this user's environment: ${names.join(", ")}. The agent would see it.`,
    envHint: "Remove it from the runner's environment (its .env file, the service definition, the shell profile).",
    file: (path, what) => `${path} holds ${what}. The agent runs as this user and can read it.`,
    fileHint: "Remove it: the pipeline needs no git or GitHub credential on this machine (the job fetches with a read-only token of its own).",
    header: (keys) => `git sends an extra HTTP header for every request (${keys.join(", ")}): it may carry a credential`,
    helper: (keys) => `git has a credential helper set for this user (${keys.join(", ")}): it may hand a stored GitHub password to the agent's git`,
    helperHint: "Unset it for the runner's user (git config --global --unset credential.helper) unless you know it stores nothing for github.com.",
    ssh: (names) => `SSH keys are in ~/.ssh (${names.join(", ")}): one registered with GitHub would let the agent push`,
    sshHint: "Keep no key on this machine that GitHub accepts, or run the runner as a user of its own.",
    none: "no GitHub credential was found for this user",
  },
  other: {
    found: (paths) => `the agent can read these credentials of this user: ${paths.join(", ")}`,
    hint: "Run the runner as a user of its own that has nothing but the agent CLI's login.",
  },
  root: { warn: "the runner runs as root: the agent can change anything on this machine", hint: "Run it as an ordinary user of its own." },
}

const gitHubIn = (text) => /github\.com/i.test(String(text || ""))

export function checkMachine({ env = {}, home = "", platform = "", uid = -1, run, exists, read, list }, { bin = "claude", tryAgent = false } = {}) {
  const T = RUNNER_TEXT
  const results = []
  const add = (id, state, text, hint = "") => results.push({ id, state, text, hint })
  const at = (...parts) => [home, ...parts].join("/")
  const safe = (fn, fallback) => {
    try {
      return fn()
    } catch {
      return fallback
    }
  }

  // ---- git and the agent CLI ----
  const g = safe(() => run("git", ["--version"], { timeoutMs: 30000 }), null)
  if (g && g.rc === 0) add("git", "ok", T.git.ok(String(g.stdout).trim().replace(/^git version /, "")))
  else add("git", "FAIL", T.git.missing, T.git.hint)
  const cli = machineProblem({ env: {}, gh: null, config: null, run, bin })
  if (cli) add("cli", "FAIL", cli)
  else add("cli", "ok", T.cli.ok(bin, versionOf(safe(() => run(bin, ["--version"], { timeoutMs: 60000 }).stdout, "")).join(".")))

  // ---- the agent CLI's login ----
  const modelEnv = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"].filter((k) => String(env[k] || "").trim())
  const credFile = `${String(env.CLAUDE_CONFIG_DIR || "").trim() || at(".claude")}/.credentials.json`
  if (modelEnv.length) add("login", "info", T.login.env(modelEnv))
  else if (exists(credFile)) add("login", "ok", T.login.file(credFile))
  else if (platform === "darwin") add("login", "warn", T.login.keychain, T.login.keychainHint)
  else add("login", "FAIL", T.login.none, T.login.noneHint)
  if (tryAgent && !cli) {
    const r = safe(() => run(bin, ["-p", "--max-turns", "1", "--output-format", "json"], { input: "Reply with the single word OK.", timeoutMs: 180000 }), { rc: 127, stdout: "", stderr: "could not be started" })
    let res = null
    try {
      res = JSON.parse(String(r.stdout || "").trim().split("\n").pop() || "null")
    } catch {
      // not JSON: said below
    }
    if (r.rc === 0 && res && !res.is_error) add("login.try", "ok", T.login.tried)
    else add("login.try", "FAIL", T.login.failed(String(res?.result || r.stderr || `exit ${r.rc}`).replace(/\s+/g, " ").trim().slice(0, 200)), T.login.noneHint)
  }

  // ---- GitHub credentials the agent could pick up ----
  let found = false
  const fail = (...a) => {
    found = true
    add(...a)
  }
  const tokens = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_PAT"].filter((k) => String(env[k] || "").trim())
  if (tokens.length) fail("github.env", "FAIL", T.github.env(tokens), T.github.envHint)
  const fileHas = (path, test) => exists(path) && test(safe(() => read(path), ""))
  if (fileHas(at(".git-credentials"), gitHubIn)) fail("github.git-credentials", "FAIL", T.github.file("~/.git-credentials", "a password for github.com"), T.github.fileHint)
  for (const name of [".netrc", "_netrc"]) if (fileHas(at(name), (t) => /^\s*(machine\s+(\S*\.)?github\.com|default)\b/im.test(t))) fail(`github.${name}`, "FAIL", T.github.file(`~/${name}`, "a login for github.com"), T.github.fileHint)
  const ghDir = String(env.GH_CONFIG_DIR || "").trim() || `${String(env.XDG_CONFIG_HOME || "").trim() || at(".config")}/gh`
  if (fileHas(`${ghDir}/hosts.yml`, (t) => /^github\.com:/m.test(t))) fail("github.gh", "FAIL", T.github.file(`${ghDir}/hosts.yml`, "a gh login for github.com"), T.github.fileHint)
  const cfg = safe(() => run("git", ["config", "--global", "--get-regexp", "^(credential\\..*|http\\..*extraheader)$"], { timeoutMs: 30000 }), null)
  const keys = cfg && cfg.rc === 0 ? String(cfg.stdout).split("\n").map((l) => l.split(/\s/)[0]).filter(Boolean) : []
  const headers = keys.filter((k) => /extraheader$/i.test(k))
  const helpers = keys.filter((k) => /^credential\./i.test(k))
  if (headers.length) fail("github.header", "FAIL", T.github.header(headers), T.github.fileHint)
  if (helpers.length) fail("github.helper", "warn", T.github.helper(helpers), T.github.helperHint)
  const sshKeys = safe(() => list(at(".ssh")), []).filter((n) => /^id_[\w-]+$/.test(n))
  if (sshKeys.length) fail("github.ssh", "warn", T.github.ssh(sshKeys), T.github.sshHint)
  if (!found) add("github", "ok", T.github.none)

  // ---- other credentials of this user ----
  const others = [
    [".aws/credentials", () => true],
    [".config/gcloud", () => true],
    [".kube/config", () => true],
    [".azure", () => true],
    [".docker/config.json", (t) => /"auths"\s*:\s*\{\s*"/.test(t) || /credsStore|credHelpers/.test(t)],
    [".npmrc", (t) => /_authToken|_auth\s*=/.test(t)],
    [".pypirc", (t) => /password/i.test(t)],
  ].filter(([p, test]) => exists(at(p)) && (p.endsWith("gcloud") || p.endsWith("azure") || test(safe(() => read(at(p)), ""))))
  if (others.length) add("other", "warn", T.other.found(others.map(([p]) => `~/${p}`)), T.other.hint)

  if (uid === 0) add("root", "warn", T.root.warn, T.root.hint)

  const counts = { ok: 0, warn: 0, FAIL: 0, info: 0 }
  for (const r of results) counts[r.state]++
  return { ok: counts.FAIL === 0, results, counts }
}
