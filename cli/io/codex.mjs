// The Codex CLI adapter (cli/io/agent.mjs runs it): `codex exec --json`, the prompt on stdin,
// the final answer written to a file of ours (`-o`) in the shape of a JSON schema
// (`--output-schema`).
//
// Codex reports tokens, not money: its runs count with `usd: 0`. limits.daily_runs and
// limits.issue_max_runs are what hold it back (the doctor says so when it is used).
import { unavailableFromText } from "../core/ledger.mjs"
import { parseLines } from "./agent.mjs"

export const CODEX_BIN = "codex"
// Its credential and settings: OPENAI_API_KEY / CODEX_API_KEY, CODEX_HOME (where a login is kept).
const MODEL_ENV = /^(OPENAI_|CODEX_)/
export const hasCodexCredential = (env) => Boolean(env?.OPENAI_API_KEY || env?.CODEX_API_KEY)

// ---------- command line ----------

// "all": the executor. Codex's own sandbox is off, for the same reason Claude Code's shell is
// open as a whole: it has to run package managers, builds and tests, and the job it runs in
// holds no token that can write anywhere. (Codex has no way to refuse commands by name.)
// "readonly": the reviewer. Codex's read-only sandbox: it reads and runs read-only commands,
// writes nothing; rules files from the checkout are not loaded. Where that sandbox cannot start
// (on Linux it needs user namespaces, which GitHub's machines and many containers do not
// allow: every command would fail), `sandbox: false` runs it without one. The reviewer's job
// holds no token that can write anywhere, and of what it does only its answer is used.
const BYPASS = ["--dangerously-bypass-approvals-and-sandbox"]
const TOOLS = {
  all: () => BYPASS,
  readonly: (sandbox) => (sandbox === false ? [...BYPASS, "--ignore-rules"] : ["--sandbox", "read-only", "--ignore-rules"]),
}

// Arguments after the binary name; "-" = the prompt comes on stdin.
// files.schema: where the schema has been written (prepare below); files.last: where Codex writes its final answer.
// sandbox: false = Codex's sandbox cannot start on this machine (see sandboxWorks).
export function codexArgs({ model = "", schema = null, tools, files, sandbox = true }) {
  const t = TOOLS[tools]?.(sandbox)
  if (!t) throw new Error(`run codex: tools must be "all" or "readonly", got ${JSON.stringify(tools ?? null)}`)
  const args = ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "--color", "never", ...t]
  if (model) args.push("--model", String(model))
  if (schema) args.push("--output-schema", files.schema)
  args.push("--output-last-message", files.last, "-")
  return args
}

// Can Codex's sandbox run a command on this machine? Asks it to (no model is involved).
// run: proc.run; -> true | false
export const SANDBOX_MARK = "coteam-pipeline-sandbox-ok"
export function sandboxWorks(run, bin, cwd) {
  try {
    const r = run(bin, ["sandbox", "--", "echo", SANDBOX_MARK], { cwd, timeoutMs: 30000 })
    return r.rc === 0 && String(r.stdout || "").includes(SANDBOX_MARK)
  } catch {
    return false
  }
}

// ---------- the schema ----------

// Our schemas leave some fields out of `required` (the executor's cannot_fix, the reviewer's
// ask / options / recommend). The model API Codex uses wants every field required, so a field
// that may be left out becomes one that may be null; stripNulls takes the nulls out again.
export function strictSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema
  const out = { ...schema }
  if (out.items) out.items = strictSchema(out.items)
  if (out.properties && typeof out.properties === "object") {
    const required = new Set(Array.isArray(out.required) ? out.required : [])
    out.properties = Object.fromEntries(
      Object.entries(out.properties).map(([k, v]) => {
        const s = strictSchema(v)
        return [k, required.has(k) ? s : { anyOf: [s, { type: "null" }] }]
      }),
    )
    out.required = Object.keys(out.properties)
    out.additionalProperties = false
  }
  return out
}

// Fields that are null are left out, at every depth (none of our schemas has a field that may be null).
export function stripNulls(v) {
  if (Array.isArray(v)) return v.map(stripNulls)
  if (!v || typeof v !== "object") return v
  return Object.fromEntries(
    Object.entries(v)
      .filter(([, x]) => x !== null)
      .map(([k, x]) => [k, stripNulls(x)]),
  )
}

// ---------- result ----------

const filled = (o) => (o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).length ? o : null)

// The final answer as an object: the file Codex wrote, else the last agent message.
function answerOf(events, last) {
  const texts = [
    String(last || ""),
    ...events
      .filter((e) => e.type === "item.completed" && e.item?.type === "agent_message" && typeof e.item.text === "string")
      .map((e) => e.item.text)
      .reverse(),
  ]
  for (const t of texts) {
    const body = t.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1")
    if (!body) continue
    try {
      const o = filled(JSON.parse(body))
      if (o) return stripNulls(o)
    } catch {
      // not JSON: try the next one
    }
  }
  return null
}

const UNITS = { minute: 60000, hour: 3600000, day: 86400000 }
// "... try again in 2 days 3 hours 5 minutes" / "... try again at 3:05 PM" -> ISO time, or null.
export function codexResetsAt(text, now = new Date()) {
  const t = String(text || "")
  const rel = /try again in ([^.]*)/i.exec(t)
  if (rel) {
    let ms = 0
    for (const m of rel[1].matchAll(/(\d+)\s*(minute|hour|day)s?/gi)) ms += Number(m[1]) * UNITS[m[2].toLowerCase()]
    if (ms > 0) return new Date(now.getTime() + ms).toISOString()
  }
  const abs = /try again at ([^.]+?)(?:\.\s|\.$|$)/i.exec(t)
  if (abs) {
    const at = Date.parse(abs[1].replace(/(\d+)(st|nd|rd|th)/g, "$1"))
    if (Number.isFinite(at) && at > now.getTime()) return new Date(at).toISOString()
  }
  return null
}

// raw: the JSONL Codex printed; rc: its exit code (124 = stopped at the time limit); stderr: its
// stderr; last: the file it wrote its final answer to; now: for a reset time given as "in 2 hours".
// -> { ok, output, usage: { turns, usd: 0, models, tokens, unavailable?, resets_at? }, note }
export function codexResult(raw, { rc = 0, stderr = "", last = "", now = new Date(), model = "" } = {}) {
  const events = parseLines(raw)
  const done = events.filter((e) => e.type === "turn.completed")
  const failures = events.filter((e) => ["turn.failed", "thread.failed", "error"].includes(e.type))
  const tokens = done.reduce(
    (s, e) => ({
      input: s.input + (Number(e.usage?.input_tokens) || 0),
      cached: s.cached + (Number(e.usage?.cached_input_tokens) || 0),
      output: s.output + (Number(e.usage?.output_tokens) || 0),
    }),
    { input: 0, cached: 0, output: 0 },
  )
  const steps = events.filter((e) => e.type === "item.completed").length
  const output = answerOf(events, last)
  const killed = [124, 137].includes(Number(rc))
  const worked = Number(rc) === 0 && done.length > 0
  // The CLI's own words: its failure events, else (when it said nothing on stdout) its stderr.
  // Only looked at when the run did not work: Codex reports a retried hiccup as an error event too.
  const said = failures.map((e) => String(e.error?.message || e.message || "")).filter(Boolean).join("\n")
  let un = null
  if (!worked && !killed) {
    const text = said || (events.length ? "" : String(stderr || "").slice(-4000))
    un = unavailableFromText(text)
    if (un) {
      const resetsAt = un.reason === "quota" ? codexResetsAt(text, now) : null
      if (resetsAt) un.resetsAt = resetsAt
    } else if (!events.length) un = { reason: "not_started", detail: String(stderr || "").replace(/\s+/g, " ").trim().slice(-300) }
  }
  const usage = {
    turns: steps,
    usd: 0,
    models: [model || "codex"],
    tokens,
    ...(un ? { unavailable: un.reason, ...(un.resetsAt ? { resets_at: un.resetsAt } : {}) } : {}),
  }
  let note
  if (un) note = `unavailable: ${un.reason}${un.resetsAt ? ` until ${un.resetsAt}` : ""}${un.detail ? ` (${un.detail.slice(0, 200)})` : ""}`
  else if (!done.length) note = `no completed turn (exit code ${rc}, ${events.length} events)${said ? `: ${said.replace(/\s+/g, " ").slice(0, 300)}` : ""}`
  else note = `${worked ? "done" : `exit code ${rc}`}, ${steps} steps, ${tokens.input} tokens in (${tokens.cached} cached), ${tokens.output} out`
  if (killed) note += "; stopped at the time limit"
  return { ok: worked && !un && Boolean(output), output, usage, note }
}

// ---------- the adapter ----------

export const CODEX = {
  name: "codex",
  bin: CODEX_BIN,
  keepEnv: MODEL_ENV,
  fixedEnv: {},
  // `codex exec` with an API key reads CODEX_API_KEY; the secret is called OPENAI_API_KEY.
  credentialEnv: (env) => (!env?.CODEX_API_KEY && env?.OPENAI_API_KEY ? { CODEX_API_KEY: String(env.OPENAI_API_KEY) } : {}),
  scratch: [],
  hasCredential: hasCodexCredential,
  prepare: ({ files, schema }) => (schema ? { [files.schema]: JSON.stringify(strictSchema(typeof schema === "string" ? JSON.parse(schema) : schema)) } : {}),
  args: (o) => codexArgs(o),
  result: (raw, o) => codexResult(raw, o),
}
