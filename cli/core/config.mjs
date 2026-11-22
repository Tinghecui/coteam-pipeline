// `.coteam/pipeline.yml` -> validated config.
//
// Layers, later wins: DEFAULTS < preset < the user's file. Maps merge key by key; lists and
// scalars are replaced as a whole (a user who writes `risk.forbidden` owns the whole list).
// Every problem is collected and reported in one Error, so the owner fixes the file in one
// go instead of one failed CI run per typo.
import { parseYaml } from "./yaml.mjs"

const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v)
const filled = (v) => typeof v === "string" && v.trim() !== ""

function deepFreeze(v) {
  if (v && typeof v === "object") Object.values(v).forEach(deepFreeze)
  return Object.freeze(v)
}

// The engine's own fallbacks. They name no stack and no model (those belong in presets),
// and they are the cautious end of every choice: nothing merges without a human and no
// decision is taken by default until a preset or the user says otherwise.
export const DEFAULTS = deepFreeze({
  version: 1,
  preset: null,
  mode: "record",
  base: "main",
  owners: [],
  stack: { setup: [], test: "", check: [], ui_paths: [] },
  // The agent CLI each role runs: "claude" (Claude Code) or "codex" (the Codex CLI).
  agents: { executor: "claude", reviewer: "claude" },
  // "" = let the agent CLI use its own default model.
  models: { executor: "", reviewer: "" },
  // independent: true = refuse a configuration in which one CLI both writes and reviews.
  review: { independent: false },
  risk: { forbidden: [".github/**", ".coteam/**"], level3: [], level2: [], level1: [] },
  merge: { method: "squash", auto_max_level: 0, default_after_hours: 0 },
  limits: {
    max_parallel: 2,
    max_rework: 4,
    issue_max_runs: 5,
    issue_max_usd: 20,
    daily_usd: 30,
    // 0 = no limit on the number of runs, only on the money (daily_usd).
    daily_runs: 0,
    executor_minutes: 120,
    reviewer_minutes: 20,
  },
  labels: {
    work: "pipeline",
    decide: "pipeline:decide",
    approved: "pipeline:approved",
    redo: "pipeline:redo",
    followup: "pipeline:followup",
    level_prefix: "level:",
    board: "pipeline:board",
  },
  status_context: "pipeline/review",
  branch_prefix: "pipeline/",
  // The status board: one issue the tick rewrites with what every piece of work waits for.
  board: true,
  // A self-hosted runner for the agent's job of a public repository is refused unless this says otherwise.
  self_hosted: { allow_public: false },
})

// Preset names become file names (`presets/<name>.yml`), so they must not be able to walk out of that directory.
const PRESET_NAME = /^[a-z0-9][a-z0-9_-]*$/

// Validators return "" when the value is fine, otherwise what it must be.
const str = (v) => (filled(v) ? "" : "must be a non-empty string")
const text = (v) => (typeof v === "string" ? "" : "must be a string")
const list = (v) => (Array.isArray(v) && v.every(filled) ? "" : "must be a list of non-empty strings (quote numbers)")
const oneOf = (...xs) => (v) => (xs.includes(v) ? "" : `must be one of: ${xs.join(", ")}`)
const int = (min, max = Infinity) => (v) =>
  Number.isInteger(v) && v >= min && v <= max ? "" : `must be a whole number ${max === Infinity ? `>= ${min}` : `from ${min} to ${max}`}`
const positive = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? "" : "must be a number > 0")
const yesNo = (v) => (typeof v === "boolean" ? "" : "must be true or false")
const nonNegative = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? "" : "must be a number >= 0")

// The agent CLIs the engine has an adapter for (cli/io/agents.mjs).
export const AGENT_CLIS = ["claude", "codex"]

const SCHEMA = {
  version: (v) => (v === 1 ? "" : "must be 1"),
  preset: (v) => (v === null || (typeof v === "string" && PRESET_NAME.test(v)) ? "" : "must be a preset name (lowercase letters, digits, - and _)"),
  mode: oneOf("off", "record", "on"),
  base: str,
  owners: list,
  stack: { setup: list, test: text, check: list, ui_paths: list },
  agents: { executor: oneOf(...AGENT_CLIS), reviewer: oneOf(...AGENT_CLIS) },
  models: { executor: text, reviewer: text },
  review: { independent: yesNo },
  risk: { forbidden: list, level3: list, level2: list, level1: list },
  merge: {
    method: oneOf("squash", "merge", "rebase"),
    // Level 3 is released by an owner and nobody else, so it can never be in the automatic range.
    auto_max_level: int(0, 2),
    default_after_hours: nonNegative,
  },
  limits: {
    max_parallel: int(1),
    max_rework: int(0),
    issue_max_runs: int(1),
    issue_max_usd: positive,
    daily_usd: positive,
    daily_runs: int(0),
    executor_minutes: int(1),
    reviewer_minutes: int(1),
  },
  labels: { work: str, decide: str, approved: str, redo: str, followup: str, level_prefix: str, board: str },
  status_context: str,
  branch_prefix: (v) => (typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(v) ? "" : "must be a branch name prefix such as pipeline/"),
  board: yesNo,
  self_hosted: { allow_public: yesNo },
}

// Unknown keys are errors, not ignored: `auto_max_levle: 0` silently falling back to a
// more permissive default is exactly the mistake this file must not allow.
function unknownKeys(doc, schema, path, source, problems) {
  for (const key of Object.keys(doc)) {
    if (!Object.hasOwn(schema, key)) problems.push(`${source}: unknown key "${path}${key}"`)
    else if (isMap(schema[key]) && isMap(doc[key])) unknownKeys(doc[key], schema[key], `${path}${key}.`, source, problems)
  }
}

function validate(value, schema, path, problems) {
  for (const [key, rule] of Object.entries(schema)) {
    const v = value[key]
    if (isMap(rule)) {
      if (isMap(v)) validate(v, rule, `${path}${key}.`, problems)
      else problems.push(`${path}${key}: must be a map`)
    } else {
      const msg = rule(v)
      if (msg) problems.push(`${path}${key}: ${msg} (got ${JSON.stringify(v ?? null)})`)
    }
  }
}

function merge(base, over) {
  if (!isMap(base) || !isMap(over)) return structuredClone(over)
  const out = structuredClone(base)
  for (const [k, v] of Object.entries(over)) out[k] = Object.hasOwn(base, k) ? merge(base[k], v) : structuredClone(v)
  return out
}

function parseDoc(text, source, problems) {
  try {
    const doc = parseYaml(text)
    if (isMap(doc)) return doc
    problems.push(`${source}: the top level must be a map`)
  } catch (e) {
    problems.push(`${source}: ${e.message}`)
  }
  return {}
}

function crossChecks(c, problems) {
  const { limits, labels, agents, models, review } = c
  if (isMap(agents) && isMap(models))
    for (const role of ["executor", "reviewer"])
      if (agents[role] !== "claude" && /^claude-/i.test(String(models[role] || "")))
        problems.push(`models.${role}: "${models[role]}" is a Claude model, and agents.${role} is ${agents[role]}; name one of its models, or "" for its default`)
  if (isMap(review) && review.independent === true && isMap(agents) && agents.executor === agents.reviewer)
    problems.push(`review.independent: the executor and the reviewer are both ${agents.executor}; set agents.reviewer to another CLI, or independent to false`)
  // The first run plus every allowed rework must fit in the per-issue run limit. The source
  // pipeline once raised the rework cap without the run cap: the executor refused its last
  // reworks at startup, left no trace on the PR, and was dispatched again on every tick.
  if (isMap(limits) && Number.isInteger(limits.max_rework) && Number.isInteger(limits.issue_max_runs) && limits.issue_max_runs < limits.max_rework + 1)
    problems.push(`limits.issue_max_runs: must be at least max_rework + 1 (${limits.max_rework + 1}), or the last reworks can never run`)
  if (isMap(labels)) {
    const names = ["work", "decide", "approved", "redo", "followup", "board"]
    const seen = new Map()
    for (const k of names) {
      if (!filled(labels[k])) continue
      if (seen.has(labels[k])) problems.push(`labels.${k}: "${labels[k]}" is already used by labels.${seen.get(labels[k])}`)
      else seen.set(labels[k], k)
    }
  }
}

// The preset the user's file asks for (null if none), so the caller knows which preset file to read.
export function presetOf(text) {
  const doc = parseYaml(text)
  const name = isMap(doc) ? doc.preset : null
  if (name === null || name === undefined) return null
  if (typeof name !== "string" || !PRESET_NAME.test(name)) throw new Error(`preset: ${SCHEMA.preset(name)}`)
  return name
}

// text: the user's `.coteam/pipeline.yml`; presetText: the text of the preset it names (see presetOf), if any.
export function loadConfig(text, presetText = null) {
  const problems = []
  const user = parseDoc(text, "pipeline.yml", problems)
  unknownKeys(user, SCHEMA, "", "pipeline.yml", problems)
  let preset = {}
  if (filled(user.preset)) {
    if (presetText === null || presetText === undefined) problems.push(`preset: "${user.preset}" was not found`)
    else {
      preset = parseDoc(presetText, `preset ${user.preset}`, problems)
      unknownKeys(preset, SCHEMA, "", `preset ${user.preset}`, problems)
      if (Object.hasOwn(preset, "preset")) problems.push(`preset ${user.preset}: a preset cannot name another preset`)
      delete preset.preset
    }
  }
  const config = merge(merge(DEFAULTS, preset), user)
  // A preset names models for the CLI it was written for. When the user's file moves a role to
  // another CLI without naming a model for it, that model is not carried over.
  for (const role of ["executor", "reviewer"]) {
    const moved = isMap(user.agents) && Object.hasOwn(user.agents, role) && user.agents[role] !== (preset.agents?.[role] ?? DEFAULTS.agents[role])
    const named = isMap(user.models) && Object.hasOwn(user.models, role)
    if (moved && !named && isMap(config.models)) config.models[role] = ""
  }
  validate(config, SCHEMA, "", problems)
  crossChecks(config, problems)
  if (problems.length) {
    const e = new Error(`Invalid pipeline config (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n${problems.map((p) => `  - ${p}`).join("\n")}`)
    e.problems = problems
    throw e
  }
  return config
}
