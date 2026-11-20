// Spec issues: an issue whose body has a "## PR split" table. One PR per row, in dependency order.
// Format and writing guide: docs/spec-format.md. Pure functions: text in, plain objects out.
import { closedRows, rowOfBranch, rowsDone } from "./marks.mjs"
import { T } from "./text.mjs"

const H = T.spec.headings
const P = T.spec.problems
const norm = (t) => String(t).replace(/\s+/g, " ").trim().toLowerCase()

// Split a body into sections by "## Heading" lines (headings inside fenced code blocks do not
// count). Returns a Map: heading -> section text.
export function specSections(body) {
  const out = new Map()
  let cur = null
  let fenceCh = ""
  for (const line of String(body || "").replace(/\r/g, "").split("\n")) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line)
    if (f) fenceCh = fenceCh ? (f[1][0] === fenceCh ? "" : fenceCh) : f[1][0]
    const h = !fenceCh && !f ? /^##\s+(.+?)\s*#*\s*$/.exec(line) : null
    if (h) {
      cur = h[1].trim()
      if (!out.has(cur)) out.set(cur, [])
      continue
    }
    if (cur != null) out.get(cur).push(line)
  }
  return new Map([...out].map(([k, v]) => [k, v.join("\n").trim()]))
}

// Ways to write "nothing" in "Open questions" and "Depends on" (a lone - or — counts too).
const NOTHING_RE = /^[\s\-–—*.()]*(none|nothing|no|n\/a)?[\s.()]*$/i
// A range in "Depends on" (1-3, 1~3, 1..3, 1 to 3, #12-#14) is refused: list every row. A dash used
// to mean "none", so "1-3" was silently read as rows 1 and 3 and row 2 was skipped.
const RANGE_RE = /#?\d+\s*(?:[-–—~]|\.{2,}|to|through|thru)\s*#?\d+/i
const tableCells = (line) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"))

// -> { sections, isSpec, summary, criteria, open, rows, problems }
//   sections: { heading: text } as written
//   isSpec:   the body has a non-empty "## PR split" section (otherwise the issue is a single task)
//   summary:  text of "## Summary" ("" if absent); criteria: text of "## Acceptance criteria"
//   open:     what is still written under "## Open questions" ("" once it is empty or "none")
//   rows:     [{ n, what, where, deps: [n | { pr }], verify }] in table order. A number in deps is
//             another row; { pr } is another issue or PR that must be closed / merged first.
//   problems: not empty = the spec cannot be worked on. The dispatcher does not guess: it does not
//             dispatch and shows the reason.
export function parseSpec(body) {
  const sec = specSections(body)
  const get = (name) => {
    for (const [k, v] of sec) if (norm(k) === norm(name)) return v
    return null
  }
  const problems = []
  const rows = []
  const table = get(H.split)
  const isSpec = table != null && !NOTHING_RE.test(table)
  const criteria = get(H.criteria) || ""
  const openRaw = get(H.open)
  const open = openRaw == null || NOTHING_RE.test(openRaw) ? "" : openRaw
  // Work never starts while something is undecided, spec or single task alike.
  if (open) problems.push(P.openNotEmpty(open.split("\n")[0].slice(0, 80)))
  if (isSpec) {
    if (!criteria.trim()) problems.push(P.criteriaEmpty)
    const before = problems.length
    const lines = table.split("\n").filter((l) => l.trim().startsWith("|"))
    const head = lines.length ? tableCells(lines[0]).map(norm) : []
    const col = (names) => head.findIndex((h) => names.some((n) => h.includes(n)))
    const C = T.spec.columns
    const ci = { n: head.findIndex((h) => C.n.includes(h)), what: col(C.what), where: col(C.where), deps: col(C.deps), verify: col(C.verify) }
    if (lines.length < 3 || !/^[\s|:-]+$/.test(lines[1])) problems.push(P.noTable)
    else if (ci.n < 0 || ci.what < 0 || ci.deps < 0) problems.push(P.badHeader)
    else {
      for (const l of lines.slice(2)) {
        const c = tableCells(l)
        const n = Number(c[ci.n])
        if (!Number.isInteger(n) || n < 1) {
          problems.push(P.badNumber(c[ci.n] ?? ""))
          continue
        }
        if (rows.some((r) => r.n === n)) {
          problems.push(P.duplicate(n))
          continue
        }
        const depText = c[ci.deps] || ""
        const refs = [...depText.matchAll(/#(\d+)/g)].map((m) => Number(m[1]))
        const rest = depText.replace(/#\d+/g, " ")
        const range = RANGE_RE.exec(depText)
        if (range) problems.push(P.depRange(n, range[0]))
        else if (!NOTHING_RE.test(rest.replace(/\d|[,;&\s]|\band\b/gi, ""))) problems.push(P.depText(n, depText))
        // a refused range yields no dependencies at all: reading numbers out of it would only add
        // misleading follow-up problems (and is the very guess the rule forbids)
        const nums = range ? [] : [...rest.matchAll(/\d+/g)].map((m) => Number(m[0]))
        rows.push({
          n,
          what: c[ci.what] || "",
          where: ci.where >= 0 ? c[ci.where] || "" : "",
          deps: [...new Set(nums), ...[...new Set(refs)].map((pr) => ({ pr }))],
          verify: ci.verify >= 0 ? c[ci.verify] || "" : "",
        })
      }
      for (const r of rows)
        for (const d of rowDeps(r)) {
          if (d === r.n) problems.push(P.depSelf(r.n))
          else if (!rows.some((x) => x.n === d)) problems.push(P.depMissing(r.n, d))
        }
      // Cycle: keep removing rows whose dependencies are all removed; what is left is on a cycle.
      if (problems.length === before) {
        const left = new Set(rows.map((r) => r.n))
        for (let moved = true; moved; ) {
          moved = false
          for (const r of rows)
            if (left.has(r.n) && rowDeps(r).every((d) => !left.has(d))) {
              left.delete(r.n)
              moved = true
            }
        }
        if (left.size) problems.push(P.cycle([...left]))
      }
    }
  }
  return { sections: Object.fromEntries(sec), isSpec, summary: get(H.summary) || "", criteria, open, rows, problems }
}

const rowDeps = (r) => r.deps.filter((d) => typeof d === "number")
const refDeps = (r) => r.deps.filter((d) => typeof d !== "number").map((d) => d.pr)

// ---------- "## Summary": the plain-language brief ----------
// The owner opens a PR or a decision item with no context and has to tell what it is about. So the
// spec starts with a brief in plain words; scripts copy it to the top of every PR of the issue.
// It is NOT the spec: the executor and the reviewer go by the acceptance criteria and decisions.

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const briefHas = (text, name) => new RegExp(`\\*\\*${escapeRe(name)}[^*\\n]*\\*\\*`, "i").test(text)
// English prose runs about three times longer than the format this limit was first tuned for.
export const BRIEF_MAX = 4000
const CODE_FILE_RE = /[\w./-]*\w\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|php|cs|cpp|json|md|ya?ml|toml|sh|sql|html|s?css|vue|svelte)\b/g

// What is wrong with a brief ([] = fine). Only what a script can tell: the items are there, nothing
// smells of code (backticks, file names, identifiers), it is not too long. Whether it reads well is
// up to the writer.
export function briefProblems(text) {
  const t = String(text || "").trim()
  if (!t) return [P.briefMissing]
  const { briefFull, briefShort } = T.spec
  const out = []
  const full = briefHas(t, briefFull[0])
  if (!full && !briefHas(t, briefShort[0])) return [P.briefShape(briefFull, briefShort)]
  const missing = (full ? briefFull : briefShort).filter((n) => !briefHas(t, n))
  if (missing.length) out.push(P.briefItems(missing))
  const table = t.split("\n").filter((l) => l.trim().startsWith("|"))
  if (full && briefHas(t, briefFull[3])) {
    // header + separator + two options
    if (table.length >= 4 ? !new RegExp(`\\b${T.spec.chosenWord}\\b`, "i").test(table.slice(2).join("\n")) : !new RegExp(T.spec.onlyOneOption, "i").test(t))
      out.push(table.length >= 4 ? P.briefChosen : P.briefOptions)
  }
  const prose = t
    .split("\n")
    .filter((l) => !l.trim().startsWith("|"))
    .join("\n")
  const code = [
    ...(t.includes("`") ? [T.spec.backtick] : []),
    ...[...t.matchAll(CODE_FILE_RE)].map((m) => m[0]),
    ...[...t.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)].map((m) => m[0]),
    ...[...t.matchAll(/\b[A-Za-z_][\w.]*\(\)/g)].map((m) => m[0]),
  ]
  if (code.length) out.push(P.briefCode([...new Set(code)].slice(0, 6)))
  if (prose.length > BRIEF_MAX) out.push(P.briefLong(prose.length, BRIEF_MAX))
  return out
}

// The check to run before labelling a spec issue as work: everything parseSpec refuses, plus what
// only matters for a new issue (the brief, the sections the executor and the reviewer rely on).
// isForbidden(path) -> truthy when the executor may not touch that path (pass a matcher built from
// config.risk.forbidden): a row that names such a path cannot be done by the executor at all, its
// whole run would be discarded.
export function checkSpec(body, { isForbidden = null } = {}) {
  const spec = parseSpec(body)
  if (!spec.isSpec) return [P.notSpec, ...spec.problems]
  const problems = [...spec.problems, ...briefProblems(spec.summary)]
  const has = (name) => Object.entries(spec.sections).some(([k, v]) => norm(k) === norm(name) && v.trim())
  for (const name of [H.requirement, H.decisions, H.outOfScope, H.current]) if (!has(name)) problems.push(P.sectionMissing(name))
  if (isForbidden)
    for (const r of spec.rows)
      for (const m of String(r.where).matchAll(/`([^`]+)`/g)) if (isForbidden(m[1])) problems.push(P.forbiddenPath(r.n, m[1]))
  return problems
}

// ---------- progress ----------

// Progress is read from the marks the tick leaves on the issue (`row-done`, `row-closed`) and
// from branch names. Both formats belong to marks.mjs, and so does their parsing: this file
// only decides what follows from them. Whose marks count is the caller's business: every
// role passes comments it has already filtered (marks.trustedComments).
const isMerged = (p) => Boolean(p.merged_at)
const refOf = (p) => String((typeof p.head === "string" ? p.head : p.head?.ref) || "")

// How far a spec issue is and which row comes next.
//   openPrs / closedPrs: PRs as GitHub returns them (number, head: "branch" or { ref }, merged_at,
//     draft, labels). A PR belongs to row r when its branch is <branchPrefix><issue>-r<r>-<slug>;
//     give `issue` when the lists hold PRs of other issues too.
//   comments: the issue's comments. A row-done mark is the record that a row is merged (a PR merged
//     long ago is no longer in the lists the dispatcher reads every round).
//   refsDone: { number: true } for every "#123" dependency that is closed / merged.
// -> { done, open: [{ row, pr, draft }], next: row | null, blocked: why there is no next,
//      closed: [{ row, pr, redo, marked, markedRedo }], merged: [{ row, pr }], unmarked, stopped }
//   unmarked: merged rows that have no row-done mark yet; closed: rows whose latest PR was closed
//   unmerged (marked = already noted on the issue); stopped: the ones of those that stay stopped.
// Rules:
// - One row of an issue at a time: no next row while a PR of the issue is open (later rows build
//   on earlier ones; two at once conflict).
// - A row whose PR was closed without merging is NOT redone automatically: a person did not want
//   that version. Rows that depend on it wait, the others go on. Putting the redo label on the
//   closed PR dispatches the row again from the latest base.
// - Next = the first row in table order whose dependencies are all merged.
export function specProgress(spec, { issue = null, branchPrefix = "pipeline/", redoLabel = "pipeline:redo", openPrs = [], closedPrs = [], comments = [], refsDone = {} } = {}) {
  const rowOf = (p) => {
    const b = rowOfBranch(refOf(p), branchPrefix)
    return b && (issue == null || b.issue === Number(issue)) ? b.row : 0
  }
  const known = (row) => spec.rows.some((r) => r.n === row)

  const merged = rowsDone(comments)
  const unmarked = []
  for (const p of closedPrs) {
    const r = rowOf(p)
    if (r && isMerged(p) && !merged.has(r)) {
      merged.set(r, p.number)
      unmarked.push({ row: r, pr: p.number })
    }
  }
  const open = openPrs.map((p) => ({ row: rowOf(p), pr: p.number, draft: Boolean(p.draft) })).filter((x) => x.row)

  // Closed without merging: per row only the latest PR (highest number) counts (marks.closedRows; row 0 is a single task, not a row).
  const shut = closedRows(issue, { closedPrs, comments, prefix: branchPrefix, redoLabel })
  const closed = [...shut]
    .filter(([row]) => row > 0 && !merged.has(row) && known(row))
    .map(([row, c]) => ({ row, ...c }))
    .sort((a, b) => a.row - b.row)
  const stopped = closed.filter((c) => !c.redo).map((c) => ({ row: c.row, pr: c.pr }))

  const todo = spec.rows.filter((r) => !merged.has(r.n))
  let next = null
  let blocked = ""
  if (spec.problems.length) blocked = T.progress.unreadable(spec.problems[0])
  else if (todo.length && !open.length) {
    for (const r of todo) {
      const stop = stopped.find((x) => x.row === r.n)
      if (stop) {
        blocked ||= T.progress.closed(r.n, stop.pr, redoLabel)
        continue
      }
      const wait = [...rowDeps(r).filter((d) => !merged.has(d)).map(T.progress.row), ...refDeps(r).filter((n) => !refsDone[n]).map(T.progress.ref)]
      if (!wait.length) {
        next = r
        break
      }
      blocked ||= T.progress.waits(r.n, wait)
    }
    if (next) blocked = ""
  }
  return {
    done: spec.rows.length > 0 && todo.length === 0,
    open,
    next,
    blocked,
    closed,
    merged: [...merged].map(([row, pr]) => ({ row, pr })).sort((a, b) => a.row - b.row),
    unmarked,
    stopped,
  }
}
