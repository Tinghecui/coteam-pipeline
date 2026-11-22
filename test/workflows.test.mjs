// The workflow files are real GitHub Actions YAML, which the engine's small YAML parser is
// not meant to read. These are structural checks on the text: the rules that keep the
// workflows safe (no event text in a shell line, secrets passed by name, least privilege)
// and the names the engine depends on (workflow file names, run titles, job names).
import assert from "node:assert/strict"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { loadConfig, presetOf } from "../cli/core/config.mjs"
import { FIX_WORKFLOW, REVIEW_WORKFLOW } from "../cli/core/plan.mjs"
import { CALLERS, OWN_CHECK, parseCaller } from "../cli/roles/doctor.mjs"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const read = (path) => readFileSync(join(ROOT, path), "utf8")
const REUSABLE = ["tick", "fix", "review"].map((n) => ({ name: n, path: `.github/workflows/${n}.yml`, text: read(`.github/workflows/${n}.yml`) }))
const CALLER = CALLERS.map((c) => ({ ...c, path: `templates/workflows/${c.file}`, text: read(`templates/workflows/${c.file}`) }))
const ALL = [...REUSABLE, ...CALLER]
const code = (text) =>
  text
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n")

// The jobs of a workflow, in order: [{ id, text }], comments removed.
function jobsOf(text) {
  const t = code(text)
  const body = t.slice(t.indexOf("\njobs:\n") + 7)
  return [...body.matchAll(/^  (\w+):\n((?:(?:    .*)?\n)+)/gm)].map((m) => ({ id: m[1], text: m[2] }))
}
const AGENT_ROLES = ["fix", "review"]
const job = (f, id) => jobsOf(f.text).find((j) => j.id === id).text

// The text of every `run:` script in a workflow (one-line and block forms).
function runScripts(text) {
  const lines = text.split("\n")
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[i])
    if (!m) continue
    if (m[2] && !/^[|>][+-]?\s*$/.test(m[2])) {
      out.push(m[2])
      continue
    }
    const indent = m[1].length
    const body = []
    for (i++; i < lines.length && (!lines[i].trim() || lines[i].search(/\S/) > indent); i++) body.push(lines[i])
    i--
    out.push(body.join("\n"))
  }
  return out
}

test("runScripts finds one-line and block scripts", () => {
  assert.deepEqual(runScripts("steps:\n  - run: echo a\n  - name: x\n    run: |\n      echo b\n      echo c\n    env:\n      A: 1\n"), ["echo a", "      echo b\n      echo c"])
})

test("the files the task names are all there, and nothing else is in the workflow directories", () => {
  assert.deepEqual(readdirSync(join(ROOT, ".github/workflows")).sort(), ["fix.yml", "review.yml", "tick.yml"])
  assert.deepEqual(readdirSync(join(ROOT, "templates/workflows")).sort(), ["pipeline-fix.yml", "pipeline-review.yml", "pipeline-tick.yml"])
})

test("no tabs and no CRLF (YAML forbids one and GitHub chokes on neither quietly)", () => {
  for (const f of ALL) assert.ok(!/\t|\r/.test(f.text), f.path)
})

test("every reusable workflow is workflow_call only", () => {
  for (const f of REUSABLE) {
    const t = code(f.text)
    assert.match(t, /^on:\n  workflow_call:\n/m, f.path)
    for (const other of ["pull_request", "pull_request_target", "issue_comment", "issues", "push", "schedule", "workflow_dispatch", "workflow_run"]) assert.ok(!new RegExp(`^  ${other}:`, "m").test(t), `${f.path} must not be started by ${other}`)
  }
})

test("no workflow uses `secrets: inherit`; secrets are passed by name", () => {
  for (const f of ALL) assert.ok(!/secrets:\s*inherit/.test(code(f.text)), f.path)
  for (const f of CALLER) {
    const t = code(f.text)
    assert.match(t, /^    secrets:\n      PIPELINE_APP_KEY: \$\{\{ secrets\.PIPELINE_APP_KEY \}\}$/m, f.path)
    assert.equal(/ANTHROPIC_API_KEY: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/.test(t), f.reusable !== "tick", `${f.path}: the model key goes to the executor and the reviewer only`)
  }
})

test("the dispatcher never receives the model key", () => {
  assert.ok(!/ANTHROPIC|CLAUDE/.test(code(REUSABLE[0].text)))
})

test("the reusable workflows declare the secrets they use and nothing else", () => {
  for (const f of REUSABLE) {
    const used = [...new Set([...code(f.text).matchAll(/\$\{\{\s*secrets\.(\w+)\s*\}\}/g)].map((m) => m[1]))].sort()
    assert.deepEqual(used, f.name === "tick" ? ["PIPELINE_APP_KEY"] : ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "PIPELINE_APP_KEY"], f.path)
    // The bot's key is required; a model credential is not (a self-hosted runner can use its own CLI's login).
    for (const s of used) assert.match(code(f.text), new RegExp(`^      ${s}:\\n(?:        description: .*\\n)?        required: ${s === "PIPELINE_APP_KEY"}$`, "m"), `${f.path} ${s}`)
    if (f.name !== "tick") for (const s of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY"]) for (const j of jobsOf(f.text)) assert.equal(code(j.text).includes(`secrets.${s}`), j.id === "agent", `${f.path} ${j.id} ${s}`)
    // The workflow's own token goes to one step only: the agent's, which fetches the code with it.
    assert.ok(!/GITHUB_TOKEN/.test(code(f.text)), f.path)
    assert.deepEqual(code(f.text).match(/.*github\.token.*/g) || [], f.name === "tick" ? [] : ["          PIPELINE_TOKEN: ${{ github.token }}"], f.path)
  }
})

test("three jobs: the bot's key and the agent never share a machine", () => {
  assert.deepEqual(jobsOf(REUSABLE[0].text).map((j) => j.id), ["tick"])
  for (const f of REUSABLE.filter((r) => AGENT_ROLES.includes(r.name))) {
    assert.deepEqual(jobsOf(f.text).map((j) => j.id), ["prepare", "agent", "publish"], f.path)
    const [prepare, agent, publish] = ["prepare", "agent", "publish"].map((id) => job(f, id))
    // the agent's job: the model key, the read-only token, and no trace of the bot
    assert.ok(!/PIPELINE_APP|PIPELINE_BOT/.test(agent), `${f.path}: the bot's key in the agent's job`)
    assert.match(agent, /ANTHROPIC_API_KEY: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/, f.path)
    assert.match(agent, /PIPELINE_TOKEN: \$\{\{ github\.token \}\}/, f.path)
    assert.match(agent, /^    needs: prepare\n    if: needs\.prepare\.outputs\.go == 'true'$/m, f.path)
    // the jobs with the bot's key: no model key, no agent CLI, no token of the workflow's, and
    // nothing run but the engine
    for (const [id, text] of [["prepare", prepare], ["publish", publish]]) {
      assert.match(text, /PIPELINE_APP_KEY: \$\{\{ secrets\.PIPELINE_APP_KEY \}\}/, `${f.path} ${id}`)
      assert.ok(!/ANTHROPIC|CLAUDE|claude|github\.token/.test(text), `${f.path} ${id}: the agent or its key next to the bot's key`)
      const scripts = runScripts(text)
      assert.equal(scripts.length, 1, `${f.path} ${id}: one script, the engine`)
      assert.match(scripts[0], /^node "\$GITHUB_WORKSPACE\/engine\/cli\/main\.mjs" /, `${f.path} ${id}`)
    }
    // prepare vouches for the order through its outputs; publish checks it, and runs whatever became of the agent
    assert.match(prepare, /^    outputs:\n      go: \$\{\{ steps\.prepare\.outputs\.go \}\}\n      order_sha256: \$\{\{ steps\.prepare\.outputs\.order_sha256 \}\}\n      engine_sha: \$\{\{ steps\.prepare\.outputs\.engine_sha \}\}$/m, f.path)
    assert.match(publish, /^    needs: \[prepare, agent\]$/m, f.path)
    assert.match(publish, /^    if: \$\{\{ always\(\) && needs\.prepare\.outputs\.go == 'true' \}\}$/m, f.path)
    assert.match(publish, /ORDER_SHA256: \$\{\{ needs\.prepare\.outputs\.order_sha256 \}\}/, f.path)
    assert.match(publish, /--sha256="\$ORDER_SHA256"/, f.path)
    // the order is uploaded once, by prepare; the result once, by the agent's job; publish uploads nothing
    assert.deepEqual([prepare, agent, publish].map((t) => (t.match(/actions\/upload-artifact@/g) || []).length), [1, 1, 0], f.path)
    assert.deepEqual([prepare, agent, publish].map((t) => (t.match(/actions\/download-artifact@/g) || []).length), [0, 1, 2], f.path)
    assert.match(prepare, /name: pipeline-order\n\s+path: \$\{\{ runner\.temp \}\}\/pipeline-order\/order\.json\n/, f.path)
    assert.match(agent, /if: always\(\)\n\s+uses: actions\/upload-artifact@v4\n\s+with:\n\s+name: pipeline-result\n/, f.path)
    // a run started again replaces both, and a result is only taken for the order it was made for (handoff.orderId)
    assert.deepEqual([prepare, agent].map((t) => (t.match(/^          overwrite: true$/gm) || []).length), [1, 1], f.path)
    assert.match(f.text, /PIPELINE_APP_KEY may not appear in that job/, f.path)
  }
})

test("least privilege: every workflow declares `permissions: contents: read` and nothing more", () => {
  for (const f of ALL) {
    const blocks = [...code(f.text).matchAll(/^( *)permissions:(.*)\n((?:\1 +.*\n)*)/gm)]
    assert.equal(blocks.length, 1, `${f.path}: one permissions block, at the top level`)
    assert.equal(blocks[0][1], "", `${f.path}: permissions at the top level`)
    assert.equal(blocks[0][2].trim(), "", f.path)
    assert.deepEqual(blocks[0][3].trim().split("\n").map((l) => l.trim()), ["contents: read"], f.path)
  }
})

test("script-injection guard: no ${{ }} expression inside any run: script", () => {
  for (const f of ALL) {
    const scripts = runScripts(code(f.text))
    if (REUSABLE.includes(f)) assert.ok(scripts.length >= 1, `${f.path} runs the engine`)
    else assert.equal(scripts.length, 0, `${f.path}: a caller has no steps of its own`)
    for (const s of scripts) assert.ok(!s.includes("${{"), `${f.path}: values reach a script through env:, never by interpolation:\n${s}`)
  }
})

test("no event text is interpolated anywhere but the allowed places", () => {
  // In the reusable workflows only the default branch name is read from the event (as the
  // checkout ref). In the callers the event is read in the job's `if:` only.
  for (const f of REUSABLE) {
    const uses = [...code(f.text).matchAll(/github\.event\.[\w.]+/g)].map((m) => m[0])
    assert.deepEqual([...new Set(uses)], f.name === "tick" ? ["github.event.repository.default_branch"] : ["github.event.repository.private"], f.path)
    // ... and in the agent's job whether the repository is private, a boolean, through env: (cli/io/machine.mjs)
    if (f.name !== "tick") assert.deepEqual(code(f.text).match(/.*github\.event\..*/g), ["          PIPELINE_REPO_PRIVATE: ${{ github.event.repository.private }}"], f.path)
    assert.ok(!/github\.(head_ref|ref_name)/.test(code(f.text)), f.path)
  }
  for (const f of CALLER) {
    for (const line of code(f.text).split("\n")) {
      if (!/github\.event\.|github\.head_ref/.test(line)) continue
      assert.equal(f.reusable, "tick", f.path)
      assert.ok(!/^\s*(run|run-name|[\w-]+:\s*\$\{\{)/.test(line), `${f.path}: ${line}`)
    }
  }
})

test("only GitHub's own checkout, setup-node and artifact actions, by major version", () => {
  for (const f of REUSABLE) {
    const used = [...code(f.text).matchAll(/^\s*(?:- )?uses:\s*(\S+)/gm)].map((m) => m[1])
    assert.ok(used.length >= 3, f.path)
    for (const u of used) assert.match(u, f.name === "tick" ? /^actions\/(checkout|setup-node)@v\d+$/ : /^actions\/(checkout|setup-node|upload-artifact|download-artifact)@v\d+$/, `${f.path}: ${u}`)
    assert.match(f.text, /pinned by commit SHA/, `${f.path} says how to pin them`)
  }
})

test("both checkouts leave no credentials behind and the engine goes to its own directory", () => {
  for (const f of REUSABLE) {
    for (const j of jobsOf(f.text)) {
      const t = j.text
      assert.equal((t.match(/uses: actions\/checkout@/g) || []).length, 2, `${f.path} ${j.id}`)
      assert.equal((t.match(/persist-credentials: false/g) || []).length, 2, `${f.path} ${j.id}`)
      // the first job takes the ref it was given; the other two take the commit the first one ran
      const ref = ["agent", "publish"].includes(j.id) ? "needs.prepare.outputs.engine_sha || inputs.engine_ref" : "inputs.engine_ref"
      assert.ok(t.includes(`repository: \${{ inputs.engine_repository }}\n          ref: \${{ ${ref} }}\n          path: engine\n`), `${f.path} ${j.id}`)
      assert.match(t, /path: repo\n/, `${f.path} ${j.id}`)
      assert.match(t, /working-directory: repo\n/, `${f.path} ${j.id}`)
      assert.match(t, /node-version: 22\n/, `${f.path} ${j.id}`)
    }
  }
})

test("the engine repository appears only as the default of engine_repository", () => {
  for (const f of REUSABLE) {
    const t = code(f.text)
    const owners = [...t.matchAll(/([\w.-]+)\/coteam-pipeline/g)].map((m) => m[0])
    assert.deepEqual(owners, ["Tinghecui/coteam-pipeline"], f.path)
    assert.match(t, /engine_repository:\n(?: {8}.*\n)*? {8}default: Tinghecui\/coteam-pipeline\n/, f.path)
    assert.match(t, /engine_ref:\n(?: {8}.*\n)*? {8}required: true\n/, f.path)
  }
})

test("each reusable workflow runs exactly its command, with numbers passed through env", () => {
  const engine = 'node "$GITHUB_WORKSPACE/engine/cli/main.mjs"'
  const dirs = { order: '--order="$RUNNER_TEMP/pipeline-order"', result: '--result="$RUNNER_TEMP/pipeline-result"' }
  // the first script is the one that takes the numbers; then the agent's and the publishing job's
  const want = {
    tick: [`${engine} tick --dry="$DRY"`],
    fix: [`${engine} fix prepare --issue="$ISSUE" --row="$ROW" --pr="$PR" --dry="$DRY" ${dirs.order}`, `${engine} fix agent ${dirs.order} ${dirs.result}`, `${engine} fix publish ${dirs.order} --sha256="$ORDER_SHA256" ${dirs.result}`],
    review: [`${engine} review prepare --pr="$PR" --dry="$DRY" ${dirs.order}`, `${engine} review agent ${dirs.order} ${dirs.result}`, `${engine} review publish ${dirs.order} --sha256="$ORDER_SHA256" ${dirs.result}`],
  }
  for (const f of REUSABLE) {
    const scripts = runScripts(code(f.text))
    assert.deepEqual(scripts.filter((s) => s.includes("cli/main.mjs")), want[f.name], f.path)
    for (const v of [...want[f.name][0].matchAll(/\$([A-Z]+)\b/g)].map((m) => m[1]).filter((v) => !["GITHUB_WORKSPACE", "RUNNER_TEMP"].includes(v))) assert.match(code(f.text), new RegExp(`^          ${v}: \\$\\{\\{ inputs\\.${v.toLowerCase()} \\}\\}$`, "m"), `${f.path} ${v}`)
    assert.match(code(f.text), /PIPELINE_APP_ID: \$\{\{ inputs\.app_id \}\}/, f.path)
    assert.match(code(f.text), /PIPELINE_BOT: \$\{\{ inputs\.bot_login \}\}/, f.path)
    const installs = scripts.filter((s) => s.includes("@anthropic-ai/claude-code"))
    assert.equal(installs.length, f.name === "tick" ? 0 : 1, `${f.path}: the agent CLI is installed for the executor and the reviewer only`)
    if (f.name !== "tick") assert.equal(runScripts(job(f, "agent")).filter((s) => s.includes("@anthropic-ai/claude-code")).length, 1, `${f.path}: and only in the agent's job`)
    for (const s of installs) assert.match(s, /"@anthropic-ai\/claude-code@\$CLAUDE_CODE_VERSION"/, f.path)
    if (f.name !== "tick") assert.match(code(f.text), /claude_code_version:\n(?: {8}.*\n)*? {8}default: "\d+\.\d+\.\d+"\n/, `${f.path}: an exact version is the default`)
  }
})

test("what the command line makes of the values a workflow passes", async () => {
  const { parseArgs } = await import("../cli/main.mjs")
  // An empty input, and a value that tries to pass for another flag.
  assert.deepEqual(parseArgs(["fix", "--issue=12", "--row=", "--pr=", "--dry=false"]).flags, { issue: "12", row: "", pr: "", dry: "false" })
  assert.deepEqual(parseArgs(["review", "--pr=--dry", "--dry=false"]).flags, { pr: "--dry", dry: "false" })
})

test("every job has a fixed timeout and a name the dispatcher can tell from the repository's CI", () => {
  const minutes = {}
  for (const f of REUSABLE) {
    const suffix = { prepare: "-prepare", agent: "", publish: "-publish", tick: "" }
    for (const j of jobsOf(f.text)) {
      const name = /^    name: (.+)$/m.exec(j.text)?.[1]
      assert.equal(name, `pipeline-${f.name}${suffix[j.id]}`, `${f.path} ${j.id}`)
      assert.match(name, OWN_CHECK)
      assert.match(`pipeline / ${name}`, OWN_CHECK, "as GitHub shows a called job")
      minutes[j.id === "agent" || j.id === "tick" ? f.name : `${f.name}-${j.id}`] = Number(/^    timeout-minutes: (\d+)$/m.exec(j.text)?.[1])
      // Only the agent's job may move to the team's own machine; the jobs that hold the bot's key never do.
      if (j.id === "agent") assert.match(j.text, /^    runs-on: \$\{\{ startsWith\(inputs\.agent_runs_on, '\['\) && fromJSON\(inputs\.agent_runs_on\) \|\| inputs\.agent_runs_on \|\| 'ubuntu-latest' \}\}$/m, `${f.path} ${j.id}`)
      else assert.match(j.text, /^    runs-on: ubuntu-latest$/m, `${f.path} ${j.id}`)
    }
    assert.ok(!OWN_CHECK.test("build / test"))
    assert.ok(!OWN_CHECK.test("build / pipeline-fix-tests"))
  }
  assert.ok(minutes.tick > 0 && minutes.tick <= 30)
  assert.ok(minutes.review > 0 && minutes.review <= 120)
  // GitHub ends a hosted job after 360 minutes whatever the file says.
  assert.ok(minutes.fix >= 180 && minutes.fix <= 360)
  // the jobs around the agent's only talk to GitHub
  for (const k of ["fix-prepare", "fix-publish", "review-prepare", "review-publish"]) assert.ok(minutes[k] > 0 && minutes[k] <= 30, k)
})

test("the limits the doctor warns about fit under the job timeouts", async () => {
  const { MAX_EXECUTOR_MINUTES, MAX_REVIEWER_MINUTES } = await import("../cli/roles/doctor.mjs")
  const of = (n) => Number(/^    timeout-minutes: (\d+)$/m.exec(job(REUSABLE.find((f) => f.name === n), "agent"))[1])
  // executor: setup and checks need room after the agent
  assert.ok(MAX_EXECUTOR_MINUTES + 60 <= of("fix"))
  assert.ok(MAX_REVIEWER_MINUTES + 15 <= of("review"))
  const preset = loadConfig("version: 1\npreset: startup\n", read("presets/startup.yml"))
  assert.ok(preset.limits.executor_minutes <= MAX_EXECUTOR_MINUTES && preset.limits.reviewer_minutes <= MAX_REVIEWER_MINUTES)
})

test("the review job is dispatch-only and says why", () => {
  const review = REUSABLE.find((f) => f.name === "review")
  assert.match(review.text, /read as "CI failed"/)
  assert.match(review.text, /workflow_dispatch on the base branch/)
  const caller = CALLER.find((f) => f.reusable === "review")
  assert.deepEqual(parseCaller(caller.text).triggers, ["workflow_dispatch"])
  assert.deepEqual(parseCaller(CALLER.find((f) => f.reusable === "fix").text).triggers, ["workflow_dispatch"])
})

test("the callers are named as the engine dispatches them and title their runs as the dispatcher reads them", () => {
  assert.equal(CALLERS.find((c) => c.reusable === "fix").file, FIX_WORKFLOW)
  assert.equal(CALLERS.find((c) => c.reusable === "review").file, REVIEW_WORKFLOW)
  for (const f of CALLER) assert.match(f.text, new RegExp(`^name: ${f.file.replace(".yml", "")}$`, "m"), f.path)
  const fix = CALLER.find((f) => f.reusable === "fix").text
  const review = CALLER.find((f) => f.reusable === "review").text
  // "#<issue>", " row <row>" and "PR #<pr>" in the executor's title; "PR #<n>" in the reviewer's.
  const runName = /^run-name: "(.+)"$/m.exec(fix)[1]
  assert.match(runName, /format\(' #\{0\}', inputs\.issue\)/)
  assert.match(runName, /format\(' row \{0\}', inputs\.row\)/)
  assert.match(runName, /format\(' PR #\{0\}', inputs\.pr\)/)
  assert.match(review, /^run-name: "pipeline-review PR #\$\{\{ inputs\.pr \}\}"$/m)
  // The inputs the dispatcher sends must all be declared, as strings (it sends "" for no row).
  for (const input of ["issue", "row", "pr"]) assert.match(fix, new RegExp(`^      ${input}:\\n        description: .*\\n        type: string\\n        default: ""$`, "m"), input)
  assert.match(review, /^      pr:\n        description: .*\n        type: string\n        required: true$/m)
})

// What GitHub would make of the run-name expression (only the forms used: a && format() || '').
function title(expr, inputs) {
  return expr.replace(/\$\{\{\s*(.+?)\s*\}\}/g, (_, e) => {
    const m = /^inputs\.(\w+) && format\('([^']*)', inputs\.(\w+)\) \|\| ''$/.exec(e)
    if (m) return inputs[m[1]] ? m[2].replace("{0}", inputs[m[3]]) : ""
    const plain = /^inputs\.(\w+)$/.exec(e)
    assert.ok(plain, `unexpected expression ${e}`)
    return inputs[plain[1]] ?? ""
  })
}

test("run titles carry the numbers the dispatcher looks for", () => {
  const fix = /^run-name: "(.+)"$/m.exec(CALLER.find((f) => f.reusable === "fix").text)[1]
  const review = /^run-name: "(.+)"$/m.exec(CALLER.find((f) => f.reusable === "review").text)[1]
  const numbers = (t) => [...t.matchAll(/#(\d+)/g)].map((m) => Number(m[1]))
  assert.equal(title(fix, { issue: "12", row: "", pr: "" }), "pipeline-fix #12")
  assert.equal(title(fix, { issue: "12", row: "3", pr: "" }), "pipeline-fix #12 row 3")
  assert.deepEqual(numbers(title(fix, { issue: "12", row: "3", pr: "40" })), [12, 40])
  assert.equal(title(fix, { issue: "", row: "", pr: "40" }), "pipeline-fix PR #40")
  assert.equal(title(review, { pr: "40" }), "pipeline-review PR #40")
  assert.ok(new RegExp(`#${40}(?!\\d)`).test(title(review, { pr: "40" })))
})

test("each caller uses its reusable workflow and passes the same ref as engine_ref", () => {
  const refs = new Set()
  for (const f of CALLER) {
    const p = parseCaller(f.text)
    assert.ok(p.uses, f.path)
    assert.equal(p.uses.repo, "Tinghecui/coteam-pipeline", f.path)
    assert.equal(p.uses.reusable, f.reusable, f.path)
    assert.equal(p.engineRef, p.uses.ref, `${f.path}: engine_ref must equal the ref in uses:`)
    assert.match(p.uses.ref, /^v\d+\.\d+\.\d+$/, f.path)
    assert.equal(p.inherit, false, f.path)
    refs.add(p.uses.ref)
    assert.match(code(f.text), /app_id: \$\{\{ vars\.PIPELINE_APP_ID \}\}/, f.path)
    assert.match(code(f.text), /bot_login: \$\{\{ vars\.PIPELINE_BOT \}\}/, f.path)
    assert.ok(code(f.text).split("\n").length <= 75, `${f.path} stays thin`)
  }
  assert.equal(refs.size, 1, "one engine ref in all three callers")
})

test("every input a caller passes is declared by the reusable workflow, and required ones are passed", () => {
  for (const f of CALLER) {
    const t = code(f.text)
    const withBlock = /^    with:\n((?: {6}.*\n)+)/m.exec(t)[1]
    const passed = [...withBlock.matchAll(/^ {6}(\w+):/gm)].map((m) => m[1])
    const reusable = code(REUSABLE.find((r) => r.name === f.reusable).text)
    const inputs = /^    inputs:\n((?: {6,}.*\n)+)/m.exec(reusable)[1]
    const declared = [...inputs.matchAll(/^ {6}(\w+):\n((?: {8}.*\n)+)/gm)].map((m) => ({ name: m[1], required: /required: true/.test(m[2]) }))
    for (const p of passed) assert.ok(declared.some((d) => d.name === p), `${f.path} passes "${p}", which ${f.reusable}.yml does not declare`)
    for (const d of declared.filter((d) => d.required)) assert.ok(passed.includes(d.name), `${f.path} must pass "${d.name}"`)
  }
})

test("the tick caller: triggers, one concurrency group, own-bot and fork events skipped", () => {
  const f = CALLER.find((c) => c.reusable === "tick")
  const t = code(f.text)
  assert.deepEqual(parseCaller(f.text).triggers.sort(), ["check_suite", "issue_comment", "issues", "pull_request", "schedule", "status", "workflow_dispatch", "workflow_run"])
  assert.match(t, /^  issues:\n    types: \[labeled, unlabeled, closed, reopened\]$/m)
  assert.match(t, /^  issue_comment:\n    types: \[created\]$/m)
  assert.match(t, /^  pull_request:\n    types: \[closed, labeled, ready_for_review, synchronize\]$/m)
  assert.ok(!/pull_request_target/.test(t))
  assert.match(t, /^  check_suite:\n    types: \[completed\]$/m)
  assert.match(t, /^  status:$/m)
  // workflow_run names the two other callers by their `name:` and never the tick itself.
  const watched = JSON.parse(/^    workflows: (\[.*\])$/m.exec(t)[1])
  assert.deepEqual(watched, ["pipeline-fix", "pipeline-review"])
  for (const w of watched) assert.ok(CALLER.some((c) => new RegExp(`^name: ${w}$`, "m").test(c.text)), w)
  // every 30 minutes, off the hour (the top of the hour is when scheduled runs are delayed most)
  const cron = /^    - cron: "(\S+) \* \* \* \*"$/m.exec(t)[1].split(",").map(Number)
  assert.equal(cron.length, 2)
  assert.equal(Math.abs(cron[1] - cron[0]), 30)
  assert.match(t, /^concurrency:\n  group: pipeline-tick\n  cancel-in-progress: false$/m)
  assert.equal((t.match(/concurrency:/g) || []).length, 1)
  for (const r of REUSABLE) assert.ok(!/concurrency:/.test(code(r.text)), `${r.path}: a group in both the caller and the called workflow can deadlock`)
  const cond = /^    if: >-\n((?: {6}.*\n)+)/m.exec(t)[1]
  assert.match(cond, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/)
  assert.match(cond, /vars\.PIPELINE_BOT != '' && github\.event\.sender\.login == vars\.PIPELINE_BOT/)
  // closing, pushing and marking ready are never skipped: only comments and label changes are named
  assert.ok(!/closed|synchronize|ready_for_review|workflow_run|schedule/.test(cond))
  assert.match(f.text, /Only the bot's exact login is skipped/)
})

test("the fix and review callers have no concurrency group (the engine's claims do that job)", () => {
  for (const f of CALLER.filter((c) => c.reusable !== "tick")) assert.ok(!/concurrency:/.test(code(f.text)), f.path)
})

test("the starter config loads together with the preset it names, and explains every key", () => {
  const text = read("templates/pipeline.yml")
  const name = presetOf(text)
  assert.equal(name, "startup")
  const presetText = read(`presets/${name}.yml`)
  const config = loadConfig(text, presetText)
  assert.equal(config.mode, "record", "a new installation never merges")
  // What the starter writes out is what the preset says: copying it changes nothing by surprise.
  const preset = loadConfig("version: 1\npreset: startup\n", presetText)
  assert.deepEqual(config, preset)
  // Every key has a comment line right above it.
  const lines = text.split("\n")
  lines.forEach((line, i) => {
    const m = /^\s*([a-z_0-9]+):/.exec(line)
    if (m) assert.match(lines[i - 1] || "", /^\s*#/, `templates/pipeline.yml: "${m[1]}" (line ${i + 1}) has no comment above it`)
  })
  for (const key of ["version", "preset", "mode", "base", "owners", "stack", "setup", "test", "check", "ui_paths", "agents", "models", "review", "independent", "risk", "forbidden", "level3", "level2", "level1", "merge", "method", "auto_max_level", "default_after_hours", "limits", "max_parallel", "max_rework", "issue_max_runs", "issue_max_usd", "daily_usd", "daily_runs", "executor_minutes", "reviewer_minutes", "labels", "work", "decide", "approved", "redo", "followup", "board", "self_hosted", "allow_public", "level_prefix", "status_context", "branch_prefix"])
    assert.match(text, new RegExp(`^\\s*(#\\s*)?${key}:`, "m"), `templates/pipeline.yml does not mention ${key}`)
})

test("docs/install.md names the same things as the workflows and the doctor", async () => {
  const doc = read("docs/install.md")
  const { NEEDED, SECRETS, VARIABLES, BOT_VARIABLE } = await import("../cli/roles/doctor.mjs")
  for (const name of [...SECRETS, ...VARIABLES, BOT_VARIABLE]) assert.ok(doc.includes(name), name)
  for (const c of CALLERS) assert.ok(doc.includes(`.github/workflows/${c.file}`), c.file)
  const label = { contents: "Contents", issues: "Issues", pull_requests: "Pull requests", statuses: "Commit statuses", actions: "Actions", checks: "Checks" }
  for (const [perm, level] of Object.entries(NEEDED)) assert.match(doc, new RegExp(`\\| ${label[perm]} \\| ${level === "write" ? "Read and write" : "Read-only"} \\|`), perm)
  assert.match(doc, /\| Workflows \| No access \|/)
  for (const heading of ["## What runs where and what it can access", "## Known limits of 0.1"]) assert.ok(doc.includes(heading), heading)
  assert.ok(!/[\u4e00-\u9fff]/.test(doc), "English only")
})

// ---------- the repository as a reader finds it ----------

test("npm test runs every test file", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
  // `node --test test/` takes the directory for a module to run and finds nothing; the glob does.
  assert.equal(pkg.scripts.test, "node --test test/*.test.mjs")
  const files = readdirSync(join(ROOT, "test"))
  assert.ok(files.length >= 20)
  assert.deepEqual(files.filter((f) => !f.endsWith(".test.mjs")), [], "a file in test/ that the glob does not match")
  assert.equal(pkg.license, "MIT")
  assert.match(readFileSync(join(ROOT, "LICENSE"), "utf8"), /^MIT License/)
})

test("the README is in English, says what has not been verified and how to install, and its links exist", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8")
  assert.ok(!/[㐀-鿿]/.test(readme), "written for outside readers")
  assert.match(readme, /The current release is `v0\.4\.0`/)
  assert.match(readme, /What has not been verified: a codebase of real size/)
  assert.match(readme, /\/plugin install coteam-pipeline@coteam-pipeline\n\/coteam-pipeline:init/)
  const links = [...readme.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)].map((m) => m[1]).filter((l) => !/^https?:/.test(l))
  for (const want of ["docs/install.md", "docs/spec-format.md", "docs/design-0.1.md", "LICENSE"]) assert.ok(links.includes(want), want)
  for (const l of links) assert.ok(existsSync(join(ROOT, l)), `${l} does not exist`)
  // the anchor it sends security-minded readers to
  assert.match(readFileSync(join(ROOT, "docs/install.md"), "utf8"), /^## Threat model and known gaps$/m)
})

test("the documents agree with the code about PIPELINE_BOT and about the agent's isolation", () => {
  const install = readFileSync(join(ROOT, "docs/install.md"), "utf8")
  const design = readFileSync(join(ROOT, "docs/design-0.1.md"), "utf8")
  // optional everywhere: the engine works its own login out
  assert.match(install, /\| `PIPELINE_BOT` \| variable, optional \|/)
  assert.ok(!/Without it, anyone who can comment could forge a mark/.test(install))
  for (const f of REUSABLE) assert.match(f.text, /bot_login:\n\s+description: "Optional \(repository variable PIPELINE_BOT\)\. The engine works out the login the App writes as by itself/, f.path)
  assert.match(readFileSync(join(ROOT, "templates/workflows/pipeline-tick.yml"), "utf8"), /The variable is optional/)
  // the three jobs are described in both places, with why the lighter way out was not taken
  for (const [name, text] of [["install.md", install], ["design-0.1.md", design]]) {
    assert.match(text, /passwordless\s+`?sudo`?/, name)
    assert.match(text, /separate\s+unprivileged OS user/, name)
    assert.match(text, /`v0\.1\.0`/, name)
  }
  assert.match(install, /holds no GitHub credential at all beyond a token that can read this\s+repository's contents/)
  assert.match(install, /\*\*What the agent's job reports about itself cannot be checked\.\*\*/)
  assert.match(install, /\*\*`v0\.1\.0` does not have the three jobs\.\*\*/)
  assert.match(design.slice(design.indexOf("## Three jobs"), design.indexOf("## Roles and io")), /Isolation of the agent from the bot's credentials/)
  // the outcomes the design lists for the agent's job are the ones publish accepts
  const fixSource = readFileSync(join(ROOT, "cli/roles/fix.mjs"), "utf8")
  const accepted = JSON.parse(/const AGENT_OUTCOMES = new Set\((\[[^\]]+\])\)/.exec(fixSource)[1])
  for (const o of accepted) assert.match(design.slice(design.indexOf("## Three jobs")), new RegExp(`\`${o}\``), o)
})

test("a self-hosted agent's job: the pinned CLI is installed on GitHub's machines only, and the engine is told where it runs", () => {
  for (const f of REUSABLE.filter((x) => x.name !== "tick")) {
    const agent = code(job(f, "agent"))
    // the CLI the prepare job names (agents.executor / agents.reviewer), and only that one
    assert.match(agent, /- name: Install the Claude Code CLI\n {8}if: runner\.environment == 'github-hosted' && needs\.prepare\.outputs\.agent_cli != 'codex'\n/, f.path)
    assert.match(agent, /- name: Install the Codex CLI\n {8}if: runner\.environment == 'github-hosted' && needs\.prepare\.outputs\.agent_cli == 'codex'\n/, f.path)
    assert.match(code(job(f, "prepare")), /^ {6}agent_cli: \$\{\{ steps\.prepare\.outputs\.agent_cli \}\}$/m, f.path)
    assert.match(code(f.text), /^ {6}codex_version:\n {8}description: .*\n {8}type: string\n {8}default: "\d+\.\d+\.\d+"$/m, f.path)
    assert.match(agent, /^ {10}PIPELINE_RUNNER_ENVIRONMENT: \$\{\{ runner\.environment \}\}$/m, f.path)
    assert.match(code(f.text), /^ {6}agent_runs_on:\n {8}description: .*\n {8}type: string\n {8}default: ""$/m, f.path)
  }
  for (const f of CALLER.filter((x) => x.reusable !== "tick")) {
    assert.match(code(f.text), /^ {6}agent_runs_on: \$\{\{ vars\.PIPELINE_AGENT_RUNS_ON \}\}$/m, f.path)
    assert.match(code(f.text), /^ {6}CLAUDE_CODE_OAUTH_TOKEN: \$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN \}\}$/m, f.path)
    assert.match(code(f.text), /^ {6}OPENAI_API_KEY: \$\{\{ secrets\.OPENAI_API_KEY \}\}$/m, f.path)
  }
})
