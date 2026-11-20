// The installation check: is this repository set up so that the pipeline can run?
//
//   run({ fix }, io) -> { ok, results: [{ id, state, text, hint }], created: [label] }
//
// Every check prints one line (`ok`, `warn`, `FAIL`, `info`, or `skip` when the token is not
// allowed to look) and, when something is to be done, a second line saying what. The role only
// reads, with one exception: with `fix` it creates the labels that are missing. `ok` is false
// when at least one check FAILed; warnings and things that could not be checked do not fail it.
//
// io: the usual one (docs/design-0.1.md), built by cli/io/real.mjs makeIo({ tolerateConfig: true }):
//   io.config           null when the config could not be loaded, with the reason in
//   io.configError      (then the engine's defaults stand in for the remaining checks)
//   io.tokenPermissions the permissions of the bot token as GitHub reported them when it was
//                       minted, e.g. { contents: "write", issues: "write" }; null when the
//                       doctor runs on a plain token (a person's), which does not say
//   io.botLogin         the login(s) the token in use writes as, "" when not known
import { DEFAULTS } from "../core/config.mjs"
import { ciRuns, OWN_CHECK } from "../core/decide.mjs"

export const CALLERS = [
  { file: "pipeline-tick.yml", reusable: "tick" },
  { file: "pipeline-fix.yml", reusable: "fix" },
  { file: "pipeline-review.yml", reusable: "review" },
]
// Which check runs are the pipeline's own and not the repository's CI: core/decide.mjs.
export { OWN_CHECK }
// What the bot token must be allowed to do, as GitHub names the permissions of an App.
export const NEEDED = { contents: "write", issues: "write", pull_requests: "write", statuses: "write", actions: "write", checks: "read" }
export const SECRETS = ["PIPELINE_APP_KEY", "ANTHROPIC_API_KEY"]
export const VARIABLES = ["PIPELINE_APP_ID"]
export const BOT_VARIABLE = "PIPELINE_BOT"
// The ceilings of the CI jobs (.github/workflows/fix.yml, review.yml) less room for setup and checks.
export const MAX_EXECUTOR_MINUTES = 240
export const MAX_REVIEWER_MINUTES = 45
const LEVEL_COLORS = ["0e8a16", "fbca04", "d93f0b", "b60205"]

export const TEXT = {
  title: (repo) => `Pipeline doctor for ${repo}`,
  hint: (text) => `      -> ${text}`,
  summary: (c) => `${c.FAIL ? "Not ready" : "Ready"}: ${c.ok} ok, ${c.warn} warning${c.warn === 1 ? "" : "s"}, ${c.FAIL} failed, ${c.skip} could not be checked.`,
  config: {
    ok: (c) => `.coteam/pipeline.yml loads (mode ${c.mode}, base ${c.base})`,
    bad: (why) => `.coteam/pipeline.yml does not load: ${why}`,
    hint: "Fix the file on the base branch (templates/pipeline.yml in the engine is a working start). The checks below use the engine's defaults.",
  },
  stack: {
    testOk: (cmd) => `stack.test is set: ${cmd}`,
    testEmpty: "stack.test is empty: the executor has no way to run the tests",
    testHint: 'Set stack.test in .coteam/pipeline.yml to the command that runs your tests, e.g. test: "npm test".',
    checkOk: (n) => `stack.check has ${n} command${n === 1 ? "" : "s"}`,
    checkEmpty: "stack.check is empty: nothing is run before a pull request is opened",
    checkHint: 'Set stack.check to the commands that must pass (lint, type check), e.g. check: ["npm run lint"]. Leave it empty only if your CI is the one gate you want.',
    minutes: (key, got) => `limits.${key} is ${got}, but the CI job ends before a run that long can finish`,
    minutesHint: (key, max) => `Set limits.${key} to ${max} or less.`,
  },
  labels: {
    ok: (n) => `all ${n} labels exist`,
    missing: (names) => `${names.length} label${names.length === 1 ? " is" : "s are"} missing: ${names.join(", ")}`,
    hint: "Create them (or run the doctor again with --fix):",
    created: (names) => `created ${names.length} label${names.length === 1 ? "" : "s"}: ${names.join(", ")}`,
    createFailed: (name, why) => `could not create the label "${name}": ${why}`,
    createHint: "The bot needs Issues: read and write. Or create it by hand:",
    unreadable: (why) => `the labels could not be listed: ${why}`,
    desc: {
      work: "Hand this issue to the pipeline",
      decide: "A decision the pipeline needs from an owner",
      approved: "An owner released this pull request",
      redo: "Do the closed pull request's work again",
      followup: "Noted in a review, not blocking",
      level: (n) => `Risk level ${n}`,
    },
  },
  callers: {
    ok: (base, engine, ref) => `the three workflows are on "${base}" and all use ${engine}@${ref}`,
    missing: (file, base) => `.github/workflows/${file} is not on the branch "${base}"`,
    missingHint: (file) => `Copy templates/workflows/${file} from the engine to .github/workflows/${file} and merge it into the base branch.`,
    unreadable: (file, why) => `.github/workflows/${file} could not be read: ${why}`,
    noUses: (file, reusable) => `${file} does not call the engine's ${reusable}.yml (no line "uses: <owner>/<repo>/.github/workflows/${reusable}.yml@<ref>")`,
    noUsesHint: (file) => `Start again from templates/workflows/${file}.`,
    placeholder: (file) => `${file} still says OWNER: the placeholder was not replaced`,
    placeholderHint: "Replace OWNER with the owner of the engine repository you install from.",
    refMismatch: (file, uses, input) => `${file} calls the engine at @${uses} but passes engine_ref: ${input || "(nothing)"}`,
    refMismatchHint: "Both must be the same ref: the workflow comes from one and the code it runs from the other.",
    differ: (list) => `the three workflows do not use the same engine: ${list.join("; ")}`,
    differHint: "Use one repository and one ref in all three.",
    inherit: (file) => `${file} passes "secrets: inherit": every secret of the repository reaches the job the agent runs in`,
    inheritHint: "Pass the secrets by name, as in templates/workflows/.",
    runName: (file, needs) => `${file} has no run-name with ${needs}: the dispatcher cannot tell which runs are going`,
    runNameHint: (file) => `Copy the run-name line from templates/workflows/${file}.`,
    notDispatch: (file) => `${file} has no workflow_dispatch trigger: the dispatcher cannot start it`,
    extraTrigger: (file, trigger) => `${file} is also started by "${trigger}": it must be started by workflow_dispatch only`,
    extraTriggerHint: "Remove the other triggers. Only the dispatcher (or a person, from the Actions tab) starts it, with the number of the issue or pull request as input; an event cannot supply that, and a pull request event from a fork would run it on a stranger's say-so.",
    floating: (ref) => `the engine ref "${ref}" is a branch, not a release tag or a commit: the pipeline changes whenever that branch does`,
    floatingHint: "Use a release tag (v0.1.0) or a full commit SHA.",
  },
  settings: {
    ok: (kind, names) => `${kind} present: ${names.join(", ")}`,
    missing: (kind, names) => `${kind} missing: ${names.join(", ")}`,
    secretHint: (repo, name) => `gh secret set ${name} --repo ${repo}   (it asks for the value; nothing is shown)`,
    variableHint: (repo, name) => `gh variable set ${name} --repo ${repo} --body <value>`,
    cannot: (kind) => `${kind}: cannot check (this token may not list them)`,
    cannotHint: (kind, names) => `Look in Settings > Secrets and variables > Actions for: ${names.join(", ")}.`,
    // PIPELINE_BOT is optional: the engine works out the login it writes as by itself. The
    // variable does two things: the tick workflow skips events its own bot caused, and the
    // logins it names are believed in addition to the pipeline's own.
    noBot: "the variable PIPELINE_BOT is not set (optional): every comment and label the bot writes starts one more dispatcher round",
    noBotHint: (repo, login) => `Harmless, but it uses runner minutes. To skip those rounds: gh variable set PIPELINE_BOT --repo ${repo} --body "${login || "<app-slug>[bot]"}"`,
    otherBot: (value, login) => `the variable PIPELINE_BOT is "${value}", but the App writes as "${login}": the dispatcher does not skip the events its own bot causes`,
    otherBotHint: (repo, login) => `gh variable set PIPELINE_BOT --repo ${repo} --body "${login}"`,
  },
  bot: {
    known: (login) => `the token in use writes as ${login} (the pipeline believes only marks written by its own login)`,
    unknown: "the login this token writes as could not be worked out: marks in comments would be read whoever wrote them (a review still counts only when the commit status names it)",
    unknownHint: "With the App's id and key the engine reads the App's login itself. With another kind of token, set PIPELINE_BOT to the login that token writes as.",
  },
  access: {
    read: (what) => `the bot can read ${what}`,
    noRead: (what, why) => `the bot cannot read ${what}: ${why}`,
    readHint: (perm) => `Give the App the repository permission "${perm}" and accept the new permissions on its installation.`,
    write: (list) => `the bot token may write: ${list.join(", ")}`,
    noWrite: (name, got) => `the bot token has ${name}: ${got || "no access"}, but needs ${NEEDED[name]}`,
    userPush: "the token belongs to a user with push access (this says nothing about the App: its permissions are checked exactly when the doctor runs with PIPELINE_APP_ID and PIPELINE_APP_KEY)",
    userNoPush: "the token belongs to a user without push access to this repository",
    cannotWrite: "write access: cannot check without writing (GitHub does not say what this token may write)",
    cannotWriteHint: "Compare the App's permissions with docs/install.md, or run the doctor with PIPELINE_APP_ID and PIPELINE_APP_KEY instead of PIPELINE_TOKEN: GitHub then says exactly what the App's token may do.",
    extra: (name) => `the bot token also has "${name}: write", which the pipeline does not need`,
    extraHint: (name) => (name === "workflows" ? "Without it the bot cannot change workflow files even if everything else went wrong. Remove it from the App." : "Remove it from the App."),
    mergeMethod: (method) => `the repository does not allow the merge method "${method}" (merge.method)`,
    mergeMethodHint: "Allow it in Settings > General > Pull Requests, or change merge.method.",
    what: { issues: "issues", pulls: "pull requests", contents: "contents", statuses: "commit statuses", checks: "check runs", actions: "Actions workflows" },
    perm: { issues: "Issues", pulls: "Pull requests", contents: "Contents", statuses: "Commit statuses", checks: "Checks", actions: "Actions" },
  },
  ci: {
    ok: (names) => `the base branch has CI checks: ${names.slice(0, 5).join(", ")}${names.length > 5 ? ", ..." : ""}`,
    noneOn: 'mode is "on" and the repository has no CI checks at all: the review is the only thing between the agent and a merge',
    noneOnHint: "Add a CI workflow that runs your tests on pull requests, or stay in record mode.",
    noneRecord: "no CI checks were found on the base branch (this matters once mode is \"on\")",
    cannot: "CI checks: cannot check (the head of the base branch could not be read)",
  },
  protection: {
    on: (base) => `the branch "${base}" is protected`,
    onHint: (context) => `Make sure the bot may merge into it. To require the review, add the status check "${context}" to the rule.`,
    off: (base) => `the branch "${base}" has no protection (informational)`,
    offHint: (context) => `Nothing stops a direct push. Consider a rule that requires pull requests and the status check "${context}".`,
  },
}

const firstLine = (e) => String(e?.message || e).split("\n")[0].slice(0, 200)
const lower = (s) => String(s || "").toLowerCase()
const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`
// YAML comments out of the way, so a commented example line is not taken for the real one.
const uncommented = (text) =>
  String(text || "")
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n")

// The labels the pipeline needs: [{ name, color, description }].
export function neededLabels(config) {
  const L = config.labels
  const D = TEXT.labels.desc
  return [
    { name: L.work, color: "1d76db", description: D.work },
    { name: L.decide, color: "d93f0b", description: D.decide },
    { name: L.approved, color: "0e8a16", description: D.approved },
    { name: L.redo, color: "5319e7", description: D.redo },
    { name: L.followup, color: "c5def5", description: D.followup },
    ...[0, 1, 2, 3].map((n) => ({ name: `${L.level_prefix}${n}`, color: LEVEL_COLORS[n], description: D.level(n) })),
  ]
}

export const labelCommand = (repo, l) => `gh label create ${shq(l.name)} --repo ${repo} --color ${l.color} --description ${shq(l.description)}`

// What a caller workflow says about the engine it runs.
// -> { uses: { repo, reusable, ref } | null, engineRef, inherit, runName, dispatch, triggers: [name] }
export function parseCaller(text) {
  const t = uncommented(text)
  const u = /^\s*uses:\s*["']?([\w.-]+\/[\w.-]+)\/\.github\/workflows\/([\w-]+)\.ya?ml@([^\s"'#]+)/m.exec(t)
  const ref = /^\s*engine_ref:\s*["']?([^\s"'#]+)/m.exec(t)
  const run = /^run-name:\s*(.+)$/m.exec(t)
  // Top-level triggers: the keys one level under `on:` (or the inline forms `on: x` / `on: [x, y]`).
  const triggers = []
  const on = /^on:[ \t]*(.*)$/m.exec(t)
  if (on) {
    if (on[1].trim()) triggers.push(...on[1].replace(/[[\]"']/g, "").split(",").map((s) => s.trim()).filter(Boolean))
    else {
      const body = t.slice(on.index + on[0].length).split("\n")
      let indent = null
      for (const line of body) {
        if (!line.trim()) continue
        const m = /^(\s+)([\w-]+):/.exec(line)
        if (!/^\s/.test(line)) break
        if (!m) continue
        indent ??= m[1].length
        if (m[1].length === indent) triggers.push(m[2])
      }
    }
  }
  return {
    uses: u ? { repo: u[1], reusable: u[2], ref: u[3] } : null,
    engineRef: ref ? ref[1] : "",
    inherit: /^\s*secrets:\s*["']?inherit\b/m.test(t),
    runName: run ? run[1].trim() : "",
    dispatch: triggers.includes("workflow_dispatch"),
    triggers,
  }
}

const PINNED = /^(v?\d+\.\d+\.\d+([-.+][\w.-]+)?|[0-9a-f]{40})$/

export async function run(opts, io) {
  const fix = Boolean(opts?.fix)
  const gh = io.gh
  const repo = gh.repo
  const results = []
  const created = []
  const add = (id, state, text, hint = "") => {
    const hints = (Array.isArray(hint) ? hint : [hint]).filter(Boolean)
    results.push({ id, state, text, hint: hints.join("\n") })
    io.log(`${state.padEnd(4)}  ${text}`)
    for (const h of hints) io.log(TEXT.hint(h))
  }
  // A read that may be refused: -> { ok, value } | { ok: false, why, missing }
  const read = async (fn) => {
    try {
      return { ok: true, value: await fn() }
    } catch (e) {
      const why = firstLine(e)
      return { ok: false, why, missing: /\b404\b|Not Found/i.test(String(e?.message || e)) }
    }
  }

  io.log(TEXT.title(repo))

  // ---- config ----
  const config = io.config || DEFAULTS
  if (io.config) add("config", "ok", TEXT.config.ok(config))
  else add("config", "FAIL", TEXT.config.bad(io.configError || "it is missing or invalid"), TEXT.config.hint)
  const base = config.base

  // ---- stack ----
  if (String(config.stack.test || "").trim()) add("stack.test", "ok", TEXT.stack.testOk(config.stack.test))
  else add("stack.test", "FAIL", TEXT.stack.testEmpty, TEXT.stack.testHint)
  if ((config.stack.check || []).length) add("stack.check", "ok", TEXT.stack.checkOk(config.stack.check.length))
  else add("stack.check", "warn", TEXT.stack.checkEmpty, TEXT.stack.checkHint)
  for (const [key, max] of [["executor_minutes", MAX_EXECUTOR_MINUTES], ["reviewer_minutes", MAX_REVIEWER_MINUTES]]) {
    if (config.limits[key] > max) add(`limits.${key}`, "warn", TEXT.stack.minutes(key, config.limits[key]), TEXT.stack.minutesHint(key, max))
  }

  // ---- labels ----
  const wanted = neededLabels(config)
  const have = await read(() => gh.list("labels?per_page=100"))
  if (!have.ok) add("labels", "skip", TEXT.labels.unreadable(have.why), [TEXT.labels.hint, ...wanted.map((l) => labelCommand(repo, l))])
  else {
    // GitHub compares label names without regard to case.
    const names = new Set(have.value.map((l) => lower(l.name)))
    let missing = wanted.filter((l) => !names.has(lower(l.name)))
    if (fix && missing.length) {
      const failed = []
      for (const l of missing) {
        const r = await read(() => gh.post("labels", { name: l.name, color: l.color, description: l.description }))
        if (r.ok) created.push(l.name)
        else failed.push({ l, why: r.why })
      }
      if (created.length) add("labels.created", "ok", TEXT.labels.created(created))
      for (const f of failed) add("labels", "FAIL", TEXT.labels.createFailed(f.l.name, f.why), [TEXT.labels.createHint, labelCommand(repo, f.l)])
      missing = failed.length ? null : []
    }
    if (missing && missing.length) add("labels", "FAIL", TEXT.labels.missing(missing.map((l) => l.name)), [TEXT.labels.hint, ...missing.map((l) => labelCommand(repo, l))])
    else if (missing) add("labels", "ok", TEXT.labels.ok(wanted.length))
  }

  // ---- the three caller workflows on the base branch ----
  const engines = []
  let callersOk = true
  for (const c of CALLERS) {
    const bad = (state, text, hint) => {
      if (state === "FAIL") callersOk = false
      add(`workflow.${c.reusable}`, state, text, hint)
    }
    const r = await read(() => gh.get(`contents/.github/workflows/${c.file}?ref=${encodeURIComponent(base)}`))
    if (!r.ok) {
      if (r.missing) bad("FAIL", TEXT.callers.missing(c.file, base), TEXT.callers.missingHint(c.file))
      else {
        callersOk = false
        add(`workflow.${c.reusable}`, "skip", TEXT.callers.unreadable(c.file, r.why))
      }
      continue
    }
    const text = Buffer.from(String(r.value?.content || ""), r.value?.encoding === "base64" || !r.value?.encoding ? "base64" : "utf8").toString("utf8")
    const p = parseCaller(text)
    if (!p.uses || p.uses.reusable !== c.reusable) {
      bad("FAIL", TEXT.callers.noUses(c.file, c.reusable), TEXT.callers.noUsesHint(c.file))
      continue
    }
    engines.push({ file: c.file, repo: p.uses.repo, ref: p.uses.ref })
    if (/^OWNER\//.test(p.uses.repo)) bad("FAIL", TEXT.callers.placeholder(c.file), TEXT.callers.placeholderHint)
    if (p.engineRef !== p.uses.ref) bad("FAIL", TEXT.callers.refMismatch(c.file, p.uses.ref, p.engineRef), TEXT.callers.refMismatchHint)
    if (p.inherit) bad("warn", TEXT.callers.inherit(c.file), TEXT.callers.inheritHint)
    if (c.reusable !== "tick") {
      if (!p.dispatch) bad("FAIL", TEXT.callers.notDispatch(c.file), TEXT.callers.noUsesHint(c.file))
      const extra = p.triggers.filter((t) => t !== "workflow_dispatch")
      if (extra.length) bad("FAIL", TEXT.callers.extraTrigger(c.file, extra[0]), TEXT.callers.extraTriggerHint)
      const needs = c.reusable === "fix" ? /#\$\{\{\s*inputs\.issue\b|#\{0\}'\s*,\s*inputs\.issue\b/ : /#\$\{\{\s*inputs\.pr\b|#\{0\}'\s*,\s*inputs\.pr\b/
      if (!needs.test(p.runName)) bad("FAIL", TEXT.callers.runName(c.file, c.reusable === "fix" ? '"#<issue>"' : '"PR #<number>"'), TEXT.callers.runNameHint(c.file))
    }
  }
  if (engines.length === CALLERS.length) {
    const kinds = new Set(engines.map((e) => `${lower(e.repo)}@${e.ref}`))
    if (kinds.size > 1) {
      callersOk = false
      add("workflow.engine", "FAIL", TEXT.callers.differ(engines.map((e) => `${e.file}: ${e.repo}@${e.ref}`)), TEXT.callers.differHint)
    } else {
      if (callersOk) add("workflow.engine", "ok", TEXT.callers.ok(base, engines[0].repo, engines[0].ref))
      if (!PINNED.test(engines[0].ref)) add("workflow.ref", "warn", TEXT.callers.floating(engines[0].ref), TEXT.callers.floatingHint)
    }
  }

  // ---- secrets and variables: names only ----
  let botValue = null
  const listNames = async (paths, key) => {
    const names = new Set()
    let readable = false
    for (const path of paths) {
      const r = await read(() => gh.get(path))
      if (!r.ok) continue
      readable = true
      for (const x of r.value?.[key] || []) {
        names.add(x.name)
        // A variable's value comes with the list (a secret's never does).
        if (key === "variables" && x.name === BOT_VARIABLE && typeof x.value === "string") botValue ??= x.value
      }
    }
    return readable ? names : null
  }
  const presence = (id, kind, needed, names, hintOf) => {
    if (!names) return add(id, "skip", TEXT.settings.cannot(kind), TEXT.settings.cannotHint(kind, needed))
    const missing = needed.filter((n) => !names.has(n))
    if (missing.length) add(id, "FAIL", TEXT.settings.missing(kind, missing), missing.map((n) => hintOf(repo, n)))
    else add(id, "ok", TEXT.settings.ok(kind, needed))
  }
  const secrets = await listNames(["actions/secrets?per_page=100", "actions/organization-secrets?per_page=100"], "secrets")
  presence("secrets", "secrets", SECRETS, secrets, TEXT.settings.secretHint)
  const variables = await listNames(["actions/variables?per_page=100", "actions/organization-variables?per_page=100"], "variables")
  presence("variables", "variables", VARIABLES, variables, TEXT.settings.variableHint)

  // ---- the pipeline's own login, and the optional PIPELINE_BOT variable ----
  const perms = io.tokenPermissions && typeof io.tokenPermissions === "object" ? io.tokenPermissions : null
  const logins = String(io.botLogin || "").split(",").map((s) => s.trim()).filter(Boolean)
  if (logins.length) add("bot", "ok", TEXT.bot.known(logins.join(", ")))
  else add("bot", "warn", TEXT.bot.unknown, TEXT.bot.unknownHint)
  // The App's own login is only known for certain when the doctor runs on the App's token.
  const appLogin = perms ? logins.filter((l) => /\[bot\]$/.test(l)).pop() || "" : ""
  if (variables && !variables.has(BOT_VARIABLE)) add("variables.bot", "info", TEXT.settings.noBot, TEXT.settings.noBotHint(repo, appLogin))
  else if (variables && appLogin && typeof botValue === "string" && botValue.trim() && lower(botValue.trim()) !== lower(appLogin)) add("variables.bot", "warn", TEXT.settings.otherBot(botValue.trim(), appLogin), TEXT.settings.otherBotHint(repo, appLogin))

  // ---- what the bot can reach: harmless reads ----
  const A = TEXT.access
  const probe = async (key, fn) => {
    const r = await read(fn)
    if (r.ok) add(`read.${key}`, "ok", A.read(A.what[key]))
    else add(`read.${key}`, "FAIL", A.noRead(A.what[key], r.why), A.readHint(`${A.perm[key]}: ${key === "checks" ? "read" : "read and write"}`))
    return r
  }
  await probe("issues", () => gh.get("issues?state=all&per_page=1"))
  await probe("pulls", () => gh.get("pulls?state=all&per_page=1"))
  const branch = await probe("contents", () => gh.get(`branches/${encodeURIComponent(base)}`))
  const sha = branch.ok ? String(branch.value?.commit?.sha || "") : ""
  let statuses = null
  let checkRuns = null
  if (sha) {
    const s = await probe("statuses", () => gh.get(`commits/${sha}/status?per_page=100`))
    if (s.ok) statuses = s.value?.statuses || []
    const c = await probe("checks", () => gh.get(`commits/${sha}/check-runs?filter=latest&per_page=100`))
    if (c.ok) checkRuns = c.value?.check_runs || []
  }
  await probe("actions", () => gh.get("actions/workflows?per_page=1"))

  // ---- write access: only what GitHub tells without writing ----
  const info = await read(() => gh.get(`/repos/${repo}`))
  if (perms) {
    const rank = { read: 1, write: 2, admin: 3 }
    const short = Object.keys(NEEDED).filter((k) => (rank[perms[k]] || 0) < rank[NEEDED[k]])
    for (const k of short) add(`write.${k}`, "FAIL", A.noWrite(k, perms[k]), A.readHint(`${k.replace(/_/g, " ")}: ${NEEDED[k] === "write" ? "read and write" : "read"}`))
    if (!short.length) add("write", "ok", A.write(Object.keys(NEEDED).filter((k) => NEEDED[k] === "write")))
    for (const k of ["workflows", "administration", "secrets"]) if ((rank[perms[k]] || 0) >= 2) add(`write.${k}`, "warn", A.extra(k), A.extraHint(k))
  } else if (info.ok && typeof info.value?.permissions?.push === "boolean") {
    if (info.value.permissions.push) add("write", "ok", A.userPush)
    else add("write", "FAIL", A.userNoPush)
  } else add("write", "skip", A.cannotWrite, A.cannotWriteHint)
  if (info.ok) {
    const allowed = { squash: info.value?.allow_squash_merge, merge: info.value?.allow_merge_commit, rebase: info.value?.allow_rebase_merge }[config.merge.method]
    if (allowed === false) add("merge.method", "FAIL", A.mergeMethod(config.merge.method), A.mergeMethodHint)
  }

  // ---- CI on the base branch ----
  if (statuses === null && checkRuns === null) add("ci", "skip", TEXT.ci.cannot)
  else {
    const names = [
      ...ciRuns(checkRuns, config.status_context).map((r) => String(r.name || "")).filter(Boolean),
      ...(statuses || []).map((s) => String(s.context || "")).filter((n) => n && n !== config.status_context),
    ]
    const unique = [...new Set(names)]
    if (unique.length) add("ci", "ok", TEXT.ci.ok(unique))
    else if (config.mode === "on") add("ci", "warn", TEXT.ci.noneOn, TEXT.ci.noneOnHint)
    else add("ci", "info", TEXT.ci.noneRecord)
  }

  // ---- branch protection (informational) ----
  if (branch.ok) {
    let isProtected = Boolean(branch.value?.protected)
    if (!isProtected) {
      const rules = await read(() => gh.get(`rules/branches/${encodeURIComponent(base)}`))
      isProtected = rules.ok && Array.isArray(rules.value) && rules.value.length > 0
    }
    if (isProtected) add("protection", "info", TEXT.protection.on(base), TEXT.protection.onHint(config.status_context))
    else add("protection", "info", TEXT.protection.off(base), TEXT.protection.offHint(config.status_context))
  }

  const counts = { ok: 0, warn: 0, FAIL: 0, info: 0, skip: 0 }
  for (const r of results) counts[r.state]++
  io.log(TEXT.summary(counts))
  return { ok: counts.FAIL === 0, results, created, counts }
}
