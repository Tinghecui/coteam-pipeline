// The ledger: `ledger.jsonl` on the `pipeline/ledger` branch, one JSON object per agent run:
//   { at, role: "executor"|"reviewer", issue, row, pr, run, outcome, turns, usd, model, merged? }
// plus, when the agent CLI could not be used at all (outcome "unavailable"):
//   { unavailable: <reason code>, resets_at?: <ISO time> }
// Budgets and the cooldown are computed from it; nothing here reads or writes the file.

const usdOf = (e) => (Number.isFinite(Number(e.usd)) ? Number(e.usd) : 0)

// User-visible wording: LEDGER_TEXT in cli/core/text.mjs.
import { LEDGER_TEXT as TEXT } from "./text.mjs"
export { TEXT }

// Broken lines are skipped: one bad append must not take the whole pipeline down.
export function parseLedger(text) {
  return String(text || "")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        const e = JSON.parse(l)
        return e && typeof e === "object" && !Array.isArray(e) ? [e] : []
      } catch {
        return []
      }
    })
}

// Outcomes of an executor "run" that never started the agent on the task: the agent could not
// be used at all, or the role refused at its precheck (`skipped`) or only looked (`dry`). The
// role writes no ledger line for the last two today; should one ever be written, it must not
// use up the issue's allowance, or a refusal would count as an attempt and the issue would be
// called stuck without the agent ever having looked at it.
export const NOT_AN_ATTEMPT = ["unavailable", "skipped", "dry"]
const AGENT_ROLES = ["executor", "reviewer"]

// The executor runs that count against an issue's (or a row's) allowance, oldest first.
//   row:   given = only this row; entries without a row count as row 0
//   since: only runs after this time (marks.countSince: the latest human decision)
// The tick and the executor's precheck both count with this one function.
export function countedRuns(entries, { issue, row = null, since = "" }) {
  const after = since ? Date.parse(since) : NaN
  return (entries || []).filter(
    (e) =>
      e.role === "executor" &&
      !NOT_AN_ATTEMPT.includes(e.outcome) &&
      Number(e.issue) === Number(issue) &&
      (row === null || row === undefined || Number(e.row || 0) === Number(row)) &&
      !(Number.isFinite(after) && Date.parse(e.at) <= after),
  )
}

// May the executor start on this issue (or this row of a spec issue)?
//   limits: config.limits (daily_usd, daily_runs, issue_max_runs, issue_max_usd)
//   row:    given = count only this row, each row has its own allowance; entries without a row count as row 0
//   since:  time of the latest human decision (marks.countSince). Only executor runs after it
//           count: a human gave a new direction, which is worth a fresh set of attempts.
// Returns { ok, reason, capped, day, today, runsToday, issueRuns, issueUsd }. `capped` = this issue/row
// used up its own allowance (a human has to decide); a daily stop is not capped, it just waits for tomorrow.
// Runs where the agent was unavailable (quota, overload, login) do not count against the
// issue: that is not the issue's fault. Neither does a run that refused to start (`skipped`).
// They still count towards today's spend.
export function budget(entries, { issue, row = null, limits, now = new Date(), since = "" }) {
  const day = now.toISOString().slice(0, 10)
  const dayOf = (e) => {
    const t = Date.parse(e.at)
    return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : ""
  }
  const list = entries || []
  const todays = list.filter((e) => dayOf(e) === day)
  const today = todays.reduce((s, e) => s + usdOf(e), 0)
  // Runs of either agent today that really started it: what limits.daily_runs counts.
  const runsToday = todays.filter((e) => AGENT_ROLES.includes(e.role) && !NOT_AN_ATTEMPT.includes(e.outcome)).length
  const mine = countedRuns(list, { issue, row, since })
  const issueRuns = mine.length
  const issueUsd = mine.reduce((s, e) => s + usdOf(e), 0)
  const what = TEXT.item({ issue, row })
  let reason = ""
  let capped = false
  if (today >= limits.daily_usd) reason = TEXT.dailyCap({ day, spent: today, cap: limits.daily_usd })
  else if (limits.daily_runs > 0 && runsToday >= limits.daily_runs) reason = TEXT.dailyRuns({ day, runs: runsToday, cap: limits.daily_runs })
  else if (issueRuns >= limits.issue_max_runs) [reason, capped] = [TEXT.runCap({ what, runs: issueRuns, max: limits.issue_max_runs, usd: issueUsd }), true]
  else if (issueUsd >= limits.issue_max_usd) [reason, capped] = [TEXT.usdCap({ what, runs: issueRuns, max: limits.issue_max_usd, usd: issueUsd }), true]
  return { ok: !reason, reason, capped, day, today, runsToday, issueRuns, issueUsd }
}

// ---------- the agent CLI cannot be used: out of quota / overloaded / logged out / never started ----------
// Every role shares one credential, so when one run hits this they all wait: the run is
// recorded with outcome "unavailable", is not charged to its issue, and the tick dispatches
// nothing until the cooldown is over.

export const UNAVAILABLE_COOLDOWN_MS = 30 * 60000
// A reset time is believed up to 8 days ahead (a weekly quota resets within 7); anything further is taken as garbage.
const UNAVAILABLE_MAX_MS = 8 * 86400000
// Matched only against the CLI's own error text (the result message, stderr), never against
// what the agent read or wrote: a task about "rate limit handling" must not look like an outage.
const UNAVAILABLE_ERRORS = [
  ["quota", /you(?:'|’)ve hit your (?:weekly )?limit|usage limit|rate.?limit|quota (?:exceeded|exhausted)|insufficient_quota|credit balance is too low/i],
  ["overloaded", /(?:api error|http(?: error)?|status(?: code)?)[\s:]+529\b|^529\b|\boverloaded\b|overloaded_error/i],
  ["auth", /authentication_error|invalid api key|not logged in|please (?:log|sign) in|please run \/login|(?:oauth |access |refresh )?token (?:has )?expired|refresh_token_reused|unauthorized/i],
]

// Seconds, milliseconds or a date string -> ISO time, or null.
const resetIso = (v) => {
  const n = Number(v)
  const t = Number.isFinite(n) && n > 0 ? (n < 1e12 ? n * 1000 : n) : Date.parse(v)
  return Number.isFinite(t) && t > 0 && t <= 8.64e15 ? new Date(t).toISOString() : null
}

// msgs: the stream-json messages of one `claude -p` run; rc: its exit code; stderr: its stderr.
// Unavailable -> { reason: "quota"|"overloaded"|"auth"|"not_started", detail, resetsAt? }.
// Anything else (it worked, an ordinary failure, killed by the time limit) -> null.
export function unavailableReason(msgs, { rc = 0, stderr = "" } = {}) {
  const all = (msgs || []).filter((m) => m && typeof m === "object")
  // Killed by `timeout` (124) or SIGKILL (137): it ran too long, which is not an outage.
  if (Number(rc) === 124 || Number(rc) === 137) return null
  const r = all.filter((m) => m.type === "result").pop()
  if (r && r.subtype === "success" && !r.is_error) return null
  const limit = all.filter((m) => m.type === "rate_limit_event" && typeof m.rate_limit_info?.status === "string").pop()
  // "allowed_warning" means close to the limit but still working. Only a refusal counts,
  // and only when the run really did not succeed (checked above).
  if (limit && !["allowed", "allowed_warning"].includes(limit.rate_limit_info.status)) {
    const resetsAt = resetIso(limit.rate_limit_info.resetsAt)
    return { reason: "quota", detail: `rate_limit_event: ${limit.rate_limit_info.status}`, ...(resetsAt ? { resetsAt } : {}) }
  }
  const err = String(stderr || "").slice(-4000)
  // With a result message, only its own error text counts; stderr is the fallback for a run that produced none.
  const text = r ? (r.is_error ? [r.result, ...(Array.isArray(r.errors) ? r.errors : [])].filter((x) => typeof x === "string").join("\n") : "") : err
  const hit = text && UNAVAILABLE_ERRORS.find(([, re]) => re.test(text))
  // Older CLI versions: "usage limit reached|<reset time in seconds>".
  const resetsAt = hit && resetIso(/usage limit reached\|(\d{9,13})/i.exec(text)?.[1])
  if (hit) return { reason: hit[0], detail: text.replace(/\s+/g, " ").trim().slice(0, 300), ...(resetsAt ? { resetsAt } : {}) }
  if (!all.length) return { reason: "not_started", detail: err.replace(/\s+/g, " ").trim().slice(-300) }
  return null
}

// Are we cooling down? Looks at the "unavailable" entries after the last run that really
// worked (an agent role with turns > 0, whatever its outcome). The cooldown ends at the
// latest of: `resets_at` if it lies after the entry (capped at 8 days), else entry + 30 min.
// None -> null. Otherwise { until, since, at, reason, role, cooling }.
// `cooling: false` means the time is up but nothing has succeeded yet: the tick should send
// a single probe run instead of the full batch, and one success clears the state.
export function claudeCooldown(entries, now = new Date()) {
  const t = (e) => Date.parse(e.at)
  const es = (entries || []).filter((e) => AGENT_ROLES.includes(e.role) && Number.isFinite(t(e)))
  const okAt = Math.max(-Infinity, ...es.filter((e) => e.outcome !== "unavailable" && Number(e.turns) > 0).map(t))
  const un = es.filter((e) => e.outcome === "unavailable" && t(e) > okAt).sort((a, b) => t(a) - t(b))
  if (!un.length) return null
  const until = Math.max(
    ...un.map((e) => {
      const r = Date.parse(e.resets_at)
      return Number.isFinite(r) && r > t(e) ? Math.min(r, t(e) + UNAVAILABLE_MAX_MS) : t(e) + UNAVAILABLE_COOLDOWN_MS
    }),
  )
  const last = un[un.length - 1]
  const iso = (x) => new Date(x).toISOString().replace(/\.000Z$/, "Z")
  return { until: iso(until), since: un[0].at, at: last.at, reason: String(last.unavailable || "unavailable"), role: last.role, cooling: until > now.getTime() }
}
