// The status board: one issue in the repository that says, for every piece of work, where it
// is and what it waits for. The tick rewrites it at the end of every round in which something
// on it changed; `main.mjs status` prints the same text without writing anything.
//
//   renderBoard({ plan, config, now, runUrl, failures }) -> the issue's body (Markdown)
//   sameBoard(a, b) -> do two bodies say the same thing (the time stamp aside)?
//
// Everything comes from the plan (core/plan.mjs: board, held, cooldown, spentToday, runsToday,
// running, notes). Pure: no network, no clock.
import { BOARD_TEXT as TEXT } from "./text.mjs"
export { TEXT }

// The first line of the body. The tick finds its board by the label and believes it only
// when the pipeline's own login opened it; the line says what the issue is to a person.
export const BOARD_MARK = "<!-- coteam-pipeline:board v1 -->"

// What a person has to do comes first, then what moves, then what waits.
const GROUPS = [
  { key: "person", states: ["owner", "stuck"] },
  { key: "moving", states: ["working", "merging"] },
  { key: "waiting", states: ["queued", "checks"] },
  { key: "idle", states: ["idle"] },
]
const ICON = { owner: "🙋", stuck: "⛔", working: "🔧", merging: "✅", queued: "⏳", checks: "🔍", idle: "·" }

const cell = (s) => String(s ?? "").replace(/\r?\n/g, " ").replace(/\|/g, "\\|")
const money = (n) => `$${(Math.round(Number(n || 0) * 100) / 100).toFixed(2)}`

const short = (t) => (t.length > 80 ? `${t.slice(0, 79)}…` : t)
function what(e) {
  const where = e.pr ? TEXT.pr(e.pr, e.issue, e.row) : TEXT.issue(e.issue, e.row)
  return e.title ? `${where} ${short(e.title)}` : where
}

export function renderBoard({ plan, config, now = new Date(), runUrl = "", failures = 0 }) {
  const lim = config.limits
  const entries = plan.board || []
  // An issue whose pull request has a line of its own says nothing that line does not.
  const prs = new Set(entries.filter((e) => e.pr).map((e) => e.pr))
  const shown = entries.filter((e) => !(e.inPr && prs.has(e.inPr)))
  const lines = [BOARD_MARK, `# ${TEXT.title}`, ""]
  lines.push(
    TEXT.summary({
      mode: config.mode,
      spent: money(plan.spentToday),
      cap: money(lim.daily_usd),
      runs: plan.runsToday || 0,
      maxRuns: lim.daily_runs || 0,
      running: (plan.running || []).length,
      parallel: lim.max_parallel,
    }),
  )
  if (config.mode === "record") lines.push("", TEXT.record)
  if (plan.held) lines.push("", `> ${TEXT.held(plan.held)}`)
  if (failures) lines.push("", `> ${TEXT.failures(failures)}`)
  if (!shown.length) lines.push("", TEXT.empty(config.labels.work))
  for (const g of GROUPS) {
    const rows = shown.filter((e) => g.states.includes(e.state))
    if (!rows.length) continue
    lines.push("", `## ${TEXT.group[g.key]} (${rows.length})`, "", `| | ${TEXT.col.what} | ${TEXT.col.status} |`, "|---|---|---|")
    for (const e of rows) lines.push(`| ${ICON[e.state] || ""} | ${cell(what(e))} | ${cell(e.text)} |`)
  }
  const notes = plan.notes || []
  if (notes.length) {
    lines.push("", `<details><summary>${TEXT.notes(notes.length)}</summary>`, "")
    for (const n of notes) lines.push(`- ${cell(n)}`)
    lines.push("", "</details>")
  }
  lines.push("", "---", TEXT.footer(now.toISOString().replace(/\.\d{3}Z$/, "Z"), runUrl))
  return lines.join("\n")
}

// What counts is the board itself, not the notes under it (some of them count minutes) and
// not the footer (time and run): a board whose content did not change is not rewritten just
// because a new round looked at it.
const content = (body) => {
  const text = String(body || "").replace(/\r\n/g, "\n")
  const cut = text.search(/\n<details>|\n---\n/)
  return (cut >= 0 ? text.slice(0, cut) : text).trim()
}
export const sameBoard = (a, b) => content(a) === content(b)
