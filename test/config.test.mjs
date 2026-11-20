import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { DEFAULTS, loadConfig, presetOf } from "../cli/core/config.mjs"

const root = new URL("..", import.meta.url)
const startup = readFileSync(new URL("presets/startup.yml", root), "utf8")
// The example config in the contract: the first yaml block of docs/design-0.1.md.
const example = /```yaml\n([\s\S]*?)```/.exec(readFileSync(new URL("docs/design-0.1.md", root), "utf8"))[1]

const problemsOf = (text, preset) => {
  try {
    loadConfig(text, preset)
  } catch (e) {
    return e.problems
  }
  return []
}

test("the contract's example config loads, with and without the preset", () => {
  const c = loadConfig(example, startup)
  assert.equal(c.preset, "startup")
  assert.equal(c.mode, "record")
  assert.deepEqual(c.stack, { setup: ["npm ci"], test: "npm test", check: ["npm run lint"], ui_paths: ["src/**/*.tsx", "src/**/*.css"] })
  assert.deepEqual(c.risk.forbidden, [".github/**", ".coteam/**", "CLAUDE.md", "AGENTS.md"])
  assert.deepEqual(c.merge, { method: "squash", auto_max_level: 1, default_after_hours: 24 })
  assert.equal(c.labels.decide, "pipeline:decide")
  assert.equal(c.labels.level_prefix, "level:")
  assert.equal(c.branch_prefix, "pipeline/")
  // it spells out every key, so it needs no preset at all
  const alone = loadConfig(example.replace("preset: startup\n", ""))
  assert.deepEqual({ ...alone, preset: "startup" }, c)
})

test("the startup preset is the contract's example", () => {
  assert.deepEqual(loadConfig("preset: startup\n", startup), loadConfig(example, startup))
  assert.deepEqual(Object.keys(loadConfig("preset: startup\n", startup)), Object.keys(DEFAULTS))
})

test("defaults: an empty file is valid and cautious; DEFAULTS cannot be changed through a config", () => {
  const c = loadConfig("")
  assert.deepEqual(c, DEFAULTS)
  assert.equal(c.mode, "record")
  assert.equal(c.merge.auto_max_level, 0)
  assert.equal(c.merge.default_after_hours, 0)
  c.limits.max_rework = 99
  c.owners.push("x")
  assert.equal(DEFAULTS.limits.max_rework, 4)
  assert.deepEqual(loadConfig("").owners, [])
  assert.throws(() => {
    DEFAULTS.merge.auto_max_level = 2
  }, TypeError)
})

test("layers: user over preset over defaults; maps merge, lists and scalars replace", () => {
  const c = loadConfig(`preset: startup\nmode: on\nowners: [alice]\nrisk:\n  level2: ["src/pay/**"]\n  forbidden: ["secrets/**"]\nlimits:\n  daily_usd: 5\n`, startup)
  assert.equal(c.mode, "on")
  assert.deepEqual(c.owners, ["alice"])
  assert.deepEqual(c.risk, { forbidden: ["secrets/**"], level3: ["**/auth/**", "**/migrations/**"], level2: ["src/pay/**"], level1: [] })
  assert.equal(c.limits.daily_usd, 5)
  assert.equal(c.limits.max_rework, 4)
  assert.equal(c.models.executor, loadConfig("preset: startup\n", startup).models.executor)
  // preset over defaults
  const p = loadConfig("preset: mine\n", "merge:\n  auto_max_level: 2\n")
  assert.deepEqual(p.merge, { method: "squash", auto_max_level: 2, default_after_hours: 0 })
  assert.equal(p.preset, "mine")
  // a preset text passed for a config that names none is not applied
  assert.equal(loadConfig("mode: off\n", startup).merge.auto_max_level, 0)
})

test("unknown keys are errors at every depth, in the user's file and in the preset", () => {
  assert.deepEqual(problemsOf("mod: on\nlimits:\n  max_paralel: 3\nmerge:\n  auto_max_levle: 0\n"), [
    'pipeline.yml: unknown key "mod"',
    'pipeline.yml: unknown key "limits.max_paralel"',
    'pipeline.yml: unknown key "merge.auto_max_levle"',
  ])
  assert.deepEqual(problemsOf("preset: mine\n", "stack:\n  lint: x\n"), ['preset mine: unknown key "stack.lint"'])
})

test("every problem is reported in one Error", () => {
  const text = `version: 2
mode: auto
base: ""
owners: alice
stack:
  setup: "npm ci"
  test: [a]
models: fast
merge:
  method: fast-forward
  auto_max_level: 3
  default_after_hours: -1
limits:
  max_parallel: 0
  max_rework: 1.5
  issue_max_usd: 0
  daily_usd: "30"
  executor_minutes: 0
labels:
  work: ""
status_context:
branch_prefix: "bad prefix"
`
  let err
  try {
    loadConfig(text)
  } catch (e) {
    err = e
  }
  const want = [
    "version",
    "mode",
    "base",
    "owners",
    "stack.setup",
    "stack.test",
    "models",
    "merge.method",
    "merge.auto_max_level",
    "merge.default_after_hours",
    "limits.max_parallel",
    "limits.max_rework",
    "limits.issue_max_usd",
    "limits.daily_usd",
    "limits.executor_minutes",
    "labels.work",
    "status_context",
    "branch_prefix",
  ]
  assert.deepEqual(err.problems.map((p) => p.split(":")[0]), want)
  assert.match(err.message, /^Invalid pipeline config \(18 problems\):\n {2}- version: must be 1 \(got 2\)\n/)
  for (const key of want) assert.ok(err.message.includes(`- ${key}: `), key)
  assert.match(err.message, /merge\.auto_max_level: must be a whole number from 0 to 2 \(got 3\)/)
  assert.match(err.message, /models: must be a map/)
})

test("cross checks: runs must fit the reworks; labels must differ", () => {
  // first run + 4 reworks = 5 runs; a lower run limit would refuse the last reworks at startup
  assert.match(problemsOf("limits:\n  max_rework: 4\n  issue_max_runs: 4\n")[0], /limits\.issue_max_runs: must be at least max_rework \+ 1 \(5\)/)
  assert.deepEqual(problemsOf("limits:\n  max_rework: 0\n  issue_max_runs: 1\n"), [])
  assert.deepEqual(problemsOf('labels:\n  redo: "pipeline:decide"\n'), ['labels.redo: "pipeline:decide" is already used by labels.decide'])
})

test("presets: missing, chained, unsafe names", () => {
  assert.deepEqual(problemsOf("preset: startup\n"), ['preset: "startup" was not found'])
  assert.deepEqual(problemsOf("preset: a\n", "preset: b\nmode: on\n"), ["preset a: a preset cannot name another preset"])
  assert.match(problemsOf("preset: ../../etc/passwd\n", "")[0], /^preset: must be a preset name/)
  assert.equal(presetOf("preset: startup\nmode: on\n"), "startup")
  assert.equal(presetOf("mode: on\n"), null)
  assert.equal(presetOf(""), null)
  assert.throws(() => presetOf("preset: ../x\n"), /preset name/)
  assert.throws(() => presetOf("preset: [a]\n"), /preset name/)
})

test("YAML errors keep their line number and say which file; a non-map top level is a problem", () => {
  assert.match(problemsOf("mode: on\nbase: {x: 1}\n")[0], /^pipeline\.yml: line 2: unsupported/)
  assert.match(problemsOf("preset: mine\n", "a: 1\n\tb: 2\n")[0], /^preset mine: line 2: tabs/)
  assert.deepEqual(problemsOf("- a\n- b\n"), ["pipeline.yml: the top level must be a map"])
  // an empty section is null, not "use the default"
  assert.match(problemsOf("owners:\n")[0], /^owners: must be a list/)
  assert.match(problemsOf("owners: [123]\n")[0], /quote numbers/)
})
