import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULTS } from "../cli/core/config.mjs"
import { atLeast, isSelfHosted, machineProblem, MIN_CLAUDE, versionOf } from "../cli/io/machine.mjs"

const gh = (answer) => ({ repo: "acme/app", get: (path) => (typeof answer === "function" ? answer(path) : answer) })
const cli = (stdout, rc = 0) => () => ({ rc, stdout, stderr: rc ? "boom" : "" })
const ok = cli("2.1.302 (Claude Code)\n")

test("versions: read from what the CLI prints, compared part by part", () => {
  assert.deepEqual(versionOf("2.1.302 (Claude Code)"), [2, 1, 302])
  assert.equal(versionOf("Claude Code"), null)
  assert.ok(atLeast([2, 1, 0], "2.1.0"))
  assert.ok(atLeast([2, 10, 0], "2.9.9"))
  assert.ok(!atLeast([2, 0, 99], "2.1.0"))
  assert.ok(atLeast([3, 0, 0], MIN_CLAUDE))
})

test("GitHub's machines: only the CLI is checked", () => {
  const env = { PIPELINE_RUNNER_ENVIRONMENT: "github-hosted" }
  assert.equal(machineProblem({ env, gh: gh(() => assert.fail("not asked")), config: DEFAULTS, run: ok }), "")
  assert.match(machineProblem({ env, gh: gh({}), config: DEFAULTS, run: cli("2.0.5") }), /version 2\.0\.5; the engine needs 2\.1\.0 or later/)
  assert.match(machineProblem({ env, gh: gh({}), config: DEFAULTS, run: cli("", 127) }), /cannot be started on this machine \(exit 127: boom\)/)
  const missing = () => {
    throw Object.assign(new Error("spawnSync claude ENOENT"), { code: "ENOENT" })
  }
  assert.match(machineProblem({ env, gh: gh({}), config: DEFAULTS, run: missing, bin: "/opt/x/claude" }), /the agent CLI "\/opt\/x\/claude" cannot be started on this machine \(spawnSync claude ENOENT\)\. .*PIPELINE_CLAUDE_BIN/)
  assert.match(machineProblem({ env, gh: gh({}), config: DEFAULTS, run: cli("hello") }), /did not say which version it is \(it said: hello\)/)
})

test("a self-hosted runner: a public repository is refused unless the config allows it, and an unknown one counts as public", () => {
  const sh = (o = {}) => ({ PIPELINE_RUNNER_ENVIRONMENT: "self-hosted", ...o })
  assert.ok(isSelfHosted(sh()))
  assert.ok(isSelfHosted({ RUNNER_ENVIRONMENT: "self-hosted" }))
  assert.ok(!isSelfHosted({}))
  // what the workflow says about the event
  assert.equal(machineProblem({ env: sh({ PIPELINE_REPO_PRIVATE: "true" }), gh: gh(() => assert.fail("not asked")), config: DEFAULTS, run: ok }), "")
  assert.match(machineProblem({ env: sh({ PIPELINE_REPO_PRIVATE: "false" }), gh: gh({}), config: DEFAULTS, run: ok }), /acme\/app is public and this job runs on a self-hosted runner\..*self_hosted\.allow_public: true/)
  // the workflow did not say: GitHub is asked
  assert.equal(machineProblem({ env: sh(), gh: gh({ private: true }), config: DEFAULTS, run: ok }), "")
  assert.match(machineProblem({ env: sh(), gh: gh({ private: false }), config: DEFAULTS, run: ok }), /is public/)
  assert.match(machineProblem({ env: sh(), gh: gh({}), config: DEFAULTS, run: ok }), /could not tell whether acme\/app is public \(GitHub did not say\)/)
  const down = () => {
    throw new Error("gh: command not found")
  }
  assert.match(machineProblem({ env: sh(), gh: gh(down), config: DEFAULTS, run: ok }), /could not tell whether acme\/app is public \(gh: command not found\)/)
  // allowed by the config: not asked at all; the CLI is still checked
  const allow = { ...DEFAULTS, self_hosted: { allow_public: true } }
  assert.equal(machineProblem({ env: sh({ PIPELINE_REPO_PRIVATE: "false" }), gh: gh(down), config: allow, run: ok }), "")
  assert.match(machineProblem({ env: sh({ PIPELINE_REPO_PRIVATE: "false" }), gh: gh(down), config: allow, run: cli("1.0.0") }), /version 1\.0\.0/)
})
