// The Claude Code adapter (cli/io/agent.mjs runs it): `claude -p --output-format stream-json`.
import { unavailableReason } from "../core/ledger.mjs"
import { agentEnv as baseAgentEnv, parseLines, runAgent } from "./agent.mjs"

// ---------- environment ----------

// The model credential and the CLI's own settings stay.
const MODEL_ENV = /^(ANTHROPIC_|CLAUDE_)/
// No self-update in the middle of a run; long builds and test suites must not be cut off by
// the CLI's default command timeout.
const FIXED_ENV = { DISABLE_AUTOUPDATER: "1", BASH_DEFAULT_TIMEOUT_MS: "1800000", BASH_MAX_TIMEOUT_MS: "2700000" }

// The environment Claude Code is given (cli/io/agent.mjs agentEnv, with its variables).
export const agentEnv = (env, extra = FIXED_ENV) => baseAgentEnv(env, extra, MODEL_ENV)

// The CLI binary, and whether the environment carries a credential for it (for `doctor`).
export const BIN = "claude"
export const hasModelCredential = (env) => Boolean(env?.ANTHROPIC_API_KEY || env?.CLAUDE_CODE_OAUTH_TOKEN || env?.ANTHROPIC_AUTH_TOKEN)

// ---------- command line ----------

// "all": the executor. The shell is open as a whole: it has to run package managers, builds
// and tests, and allowing by command prefix stops nothing (any of them can run anything). The
// real boundary is that it holds no token. Publishing and network tools are still refused by name.
// "readonly": the reviewer. Reads files and history; settings and tool servers that the
// checkout itself could define are not loaded, because the pull request under review can change them.
const TOOLS = {
  all: {
    flags: [],
    allowed: "Read,Edit,MultiEdit,Write,Glob,Grep,LS,TodoWrite,Bash",
    disallowed: "Bash(git push:*),Bash(git commit:*),Bash(git stash:*),Bash(git config:*),Bash(gh:*),Bash(curl:*),Bash(wget:*),WebFetch,WebSearch",
  },
  readonly: {
    flags: ["--setting-sources", "user", "--strict-mcp-config"],
    allowed: "Read,Glob,Grep,LS,Bash(git diff:*),Bash(git log:*),Bash(git show:*),Bash(git blame:*),Bash(git grep:*),Bash(git ls-files:*),Bash(git status:*)",
    disallowed:
      "Edit,MultiEdit,Write,NotebookEdit,WebFetch,WebSearch,Task,Bash(git push:*),Bash(git commit:*),Bash(git config:*),Bash(git checkout:*),Bash(git reset:*),Bash(git stash:*),Bash(gh:*),Bash(curl:*),Bash(wget:*)",
  },
}

// Directories the CLI may create in the checkout for itself. They are never part of a change.
export const SCRATCH_PATHS = [".claude"]

// Arguments after the binary name. The prompt goes in on stdin, never on the command line.
// schema: JSON schema text (or an object) for the structured output; model "" = the CLI's default.
export function claudeArgs({ model = "", schema = null, tools, maxTurns = null }) {
  const t = TOOLS[tools]
  if (!t) throw new Error(`runClaude: tools must be "all" or "readonly", got ${JSON.stringify(tools ?? null)}`)
  const args = ["-p", "--verbose", "--output-format", "stream-json"]
  if (maxTurns) args.push("--max-turns", String(maxTurns))
  if (model) args.push("--model", String(model))
  args.push(...t.flags, "--allowedTools", t.allowed, "--disallowedTools", t.disallowed)
  if (schema) args.push("--json-schema", typeof schema === "string" ? schema : JSON.stringify(schema))
  return args
}

// ---------- result ----------

// stream-json text -> messages. Lines that are not JSON (a stray warning) are skipped.
export const parseStream = parseLines

const filled = (o) => (o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).length ? o : null)

// The structured output of a run: the result message's, or (when the run was cut short by the
// turn or time limit after the agent had already answered) the last answer found in the transcript.
export function structuredOutput(msgs) {
  const r = (msgs || []).filter((m) => m?.type === "result").pop()
  if (filled(r?.structured_output)) return r.structured_output
  const calls = (msgs || [])
    .filter((m) => m?.type === "assistant" && Array.isArray(m.message?.content))
    .flatMap((m) => m.message.content)
    .filter((c) => c?.type === "tool_use" && c.name === "StructuredOutput" && filled(c.input))
  return calls.length ? calls[calls.length - 1].input : null
}

// msgs: the messages of one run; rc: the CLI's exit code (124 = stopped at the time limit);
// stderr: its stderr; maxTurns: the limit it was given.
// -> { ok, output, usage: { turns, usd, models, unavailable?, resets_at? }, note }
//   ok:     the run ended with a successful result inside the turn limit. A run can be not ok
//           and still carry an output (see structuredOutput); the role decides whether to use it.
//   usage:  always present, zeros when the CLI never produced a result. `unavailable` is set
//           when the CLI could not be used at all (quota, overload, login): the role records the
//           outcome "unavailable" and the tick cools down.
//   note:   one line for the job log.
export function claudeResult(msgs, { rc = 0, stderr = "", maxTurns = null } = {}) {
  const r = (msgs || []).filter((m) => m?.type === "result").pop() || null
  const un = unavailableReason(msgs, { rc, stderr })
  const usage = {
    turns: Number(r?.num_turns) || 0,
    usd: Number(r?.total_cost_usd) || 0,
    models: Object.keys(r?.modelUsage || {}),
    ...(un ? { unavailable: un.reason, ...(un.resetsAt ? { resets_at: un.resetsAt } : {}) } : {}),
  }
  const over = Boolean(r && maxTurns && Number(r.num_turns) > Number(maxTurns))
  const ok = Boolean(r && r.subtype === "success" && !r.is_error && !over && !un)
  let note
  if (un) note = `unavailable: ${un.reason}${un.resetsAt ? ` until ${un.resetsAt}` : ""}${un.detail ? ` (${un.detail.slice(0, 200)})` : ""}`
  else if (!r) note = `no result message (exit code ${rc}, ${(msgs || []).length} messages)`
  else
    note =
      `${r.subtype}${r.is_error ? " (error)" : ""}, ${r.num_turns ?? "?"} turns${over ? ` (over the limit of ${maxTurns})` : ""}, about $${usage.usd.toFixed(2)}` +
      (r.is_error && typeof r.result === "string" ? `: ${r.result.replace(/\s+/g, " ").slice(0, 300)}` : "")
  if (Number(rc) === 124) note += "; stopped at the time limit"
  return { ok, output: structuredOutput(msgs), usage, note }
}

// ---------- the adapter ----------

export const CLAUDE = {
  name: "claude",
  bin: BIN,
  keepEnv: MODEL_ENV,
  fixedEnv: FIXED_ENV,
  scratch: SCRATCH_PATHS,
  hasCredential: hasModelCredential,
  args: (o) => claudeArgs(o),
  result: (raw, { rc, stderr, maxTurns }) => claudeResult(parseStream(raw), { rc, stderr, maxTurns }),
}

// opts and deps: cli/io/agent.mjs runAgent.
export const runClaude = (opts, deps) => runAgent(CLAUDE, opts, deps)
