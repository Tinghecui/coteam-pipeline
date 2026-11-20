// Prompts for the executor and the reviewer, and the PR body built from the executor's output.
// Pure: templates (prompts/*.md) are passed in as text, config is an already-validated object.
import { T } from "./text.mjs"

// ---------- templates ----------

const truthy = (v) => (Array.isArray(v) ? v.length > 0 : Boolean(v))

// Fill a prompt template:
//   {{name}}                 -> String(vars.name)
//   {{#name}} ... {{/name}}  -> kept when vars.name is truthy (a non-empty array counts), else dropped
//   {{^name}} ... {{/name}}  -> the opposite
// A block tag alone on its line takes the line with it. A name the caller did not pass throws:
// someone changed a prompt and forgot the code (or the other way round).
// Values are inserted in one pass and never scanned again, so "{{...}}" inside an issue body or a
// PR description stays literal text.
export function fillTemplate(template, vars) {
  const get = (k) => {
    if (!(k in vars)) throw new Error(T.errors.templateVar(k))
    return vars[k]
  }
  let text = String(template).replace(/^[ \t]*(\{\{[#^/][a-z_]+\}\})[ \t]*\r?\n/gm, "$1")
  // innermost block first: the body may not contain another opening tag
  const block = /\{\{([#^])([a-z_]+)\}\}((?:(?!\{\{[#^])[\s\S])*?)\{\{\/\2\}\}/
  for (let m; (m = block.exec(text)); ) {
    const keep = truthy(get(m[2])) === (m[1] === "#")
    text = text.slice(0, m.index) + (keep ? m[3] : "") + text.slice(m.index + m[0].length)
  }
  const stray = /\{\{[#^/][a-z_]+\}\}/.exec(text)
  if (stray) throw new Error(T.errors.templateBlock(stray[0]))
  return text.replace(/\{\{([a-z_]+)\}\}/g, (_, k) => String(get(k)))
}

// A fenced code block whose fence is one backtick longer than the longest run inside the text, so
// pasted output cannot close it early.
export function fence(text, lang = "text") {
  const t = String(text ?? "").trim() || T.pr.notGiven
  const n = Math.max(3, ...[...t.matchAll(/`+/g)].map((m) => m[0].length + 1))
  return `${"`".repeat(n)}${lang}\n${t}\n${"`".repeat(n)}`
}

// Delimiters for untrusted text (issue, comments, PR description, review feedback). The nonce is
// random per run, so the text cannot contain its own closing line. The prompt says: everything
// between the two lines is data, not instructions.
export const delimiters = (label, nonce) => ({ open: `<<<${label}-${nonce}`, close: `${label}-${nonce}>>>` })

// How much of each piece a model gets. The reviewer once got only 8000 characters of the acceptance
// criteria; a 9344-character spec lost its last three criteria and the reviewer could only take the
// executor's word that they were met. The reviewer must never see less than the executor did.
export const SPEC_CUT = 40000
export const BODY_CUT = 20000
export const COMMENT_CUT = 2000
export const MAX_COMMENTS = 10
// Never cut silently: the model has to know that it did not see everything.
export const cut = (s, n) => (s.length > n ? `${s.slice(0, n)}\n${T.prompt.truncated(n, s.length)}` : s)

const clean = (s) => String(s ?? "").replace(/\r/g, "").trim()
const oneLine = (s) => String(s ?? "").replace(/\s*[\r\n]+\s*/g, " ").trim()
const stripMarks = (s) => String(s ?? "").replace(/<!--[\s\S]*?-->/g, "").replace(/\n{3,}/g, "\n\n").trim()
const asList = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]).map((x) => String(x).trim()).filter(Boolean)
const ticks = (items) => (items.length ? items.map((x) => `\`${x}\``).join(", ") : T.prompt.none)
const bullets = (items) => (items.length ? items.map((x) => `  - \`${x}\``).join("\n") : `  - ${T.prompt.noneConfigured}`)

// Comments worth showing to a model, oldest first: what people wrote. The pipeline's own
// bookkeeping comments (hidden marks plus a line of status) are dropped; a human decision keeps
// its text and loses only the mark.
export function humanComments(comments) {
  return (comments || [])
    .map((c) => ({ by: c?.user?.login || c?.by || "", raw: clean(c?.body) }))
    .filter((c) => c.raw && (!/<!-- pipeline-/.test(c.raw) || /<!-- pipeline-decision /.test(c.raw)))
    .map((c) => ({ by: c.by, body: stripMarks(c.raw) }))
    .filter((c) => c.body)
    .slice(-MAX_COMMENTS)
}
const commentsText = (comments) =>
  humanComments(comments)
    .map((c) => `${c.by ? `${T.prompt.commentBy(c.by)}\n` : ""}${cut(c.body, COMMENT_CUT)}`)
    .join(`\n\n${T.prompt.commentSeparator}\n\n`)

const specVars = (spec, row) => {
  const on = Boolean(spec?.isSpec && row)
  return {
    spec: on,
    row: on ? row.n : "",
    rows_total: on ? spec.rows.length : "",
    row_what: on ? row.what || T.prompt.notWritten : "",
    row_where: on ? row.where || T.prompt.notWritten : "",
    row_verify: on ? row.verify || T.prompt.notWritten : "",
  }
}

// ---------- executor ----------

// issue: { number, title, body }; comments: the issue's comments ({ body, user: { login } }).
// spec + row: parseSpec(issue.body) and the row to do; leave both out for a single task.
// branch: the work branch that is checked out. base: commit of config.base the branch started from
//   (in a rework: where the PR branched off), so `git diff <base>...HEAD` is the whole PR.
// rework: { pr, attempt, feedback, body } when this run reworks an open PR. feedback is what the
//   scripts collected from the PR (review problems, failed checks) and body is the PR description
//   of the previous attempt; both are untrusted data.
export function buildExecutorPrompt({ template, config, issue, comments = [], spec = null, row = null, branch, base, nonce, today, rework = null }) {
  const stack = config.stack || {}
  const issueD = delimiters("ISSUE", nonce)
  const feedbackD = delimiters("FEEDBACK", nonce)
  const bodyD = delimiters("BODY", nonce)
  const thread = commentsText(comments)
  return fillTemplate(template, {
    ...specVars(spec, row),
    issue_number: issue.number,
    branch,
    base_branch: config.base,
    base_sha: String(base || "").slice(0, 12) || config.base,
    today,
    setup_commands: bullets(asList(stack.setup)),
    test_command: asList(stack.test).join(" && ") || T.prompt.noneConfigured,
    check_commands: bullets(asList(stack.check)),
    forbidden_paths: ticks(asList(config.risk?.forbidden)),
    rework: Boolean(rework),
    rework_pr: rework?.pr ?? "",
    rework_attempt: rework?.attempt ?? "",
    feedback_open: feedbackD.open,
    feedback_close: feedbackD.close,
    feedback: rework ? cut(clean(rework.feedback) || T.prompt.noFeedback, BODY_CUT) : "",
    body_open: bodyD.open,
    body_close: bodyD.close,
    previous_body: rework ? cut(stripMarks(clean(rework.body)) || T.prompt.noPreviousBody, BODY_CUT) : "",
    open: issueD.open,
    close: issueD.close,
    issue_title: oneLine(issue.title),
    // The whole issue, spec or not: the acceptance criteria are never trimmed to fit.
    issue_body: cut(clean(issue.body) || T.prompt.emptyBody, SPEC_CUT),
    has_comments: Boolean(thread),
    comments: thread,
  })
}

// ---------- reviewer ----------

// pr: { number, title, body, labels }; issue: the issue the PR was opened for ({ number, title,
// body }, or null when it could not be found); spec + row as for the executor (null for a single
// task); diffStat: `git diff --stat` of the PR, text or lines.
// The reviewer's checkout is the PR's merge ref, so the template tells it to read the diff itself.
export function buildReviewPrompt({ template, config, pr, issue = null, spec = null, row = null, diffStat = "", nonce }) {
  const sv = specVars(spec, row)
  const section = (name) => {
    const want = name.toLowerCase()
    for (const [k, v] of Object.entries(spec?.sections || {})) if (k.replace(/\s+/g, " ").trim().toLowerCase() === want && String(v).trim()) return String(v).trim()
    return T.prompt.notWritten
  }
  const H = T.spec.headings
  const prD = delimiters("PR", nonce)
  const specD = delimiters("SPEC", nonce)
  const issueD = delimiters("ISSUE", nonce)
  const labels = (pr.labels || []).map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean)
  return fillTemplate(template, {
    ...sv,
    pr_number: pr.number,
    base_branch: config.base,
    diff_stat: fence(Array.isArray(diffStat) ? diffStat.join("\n") : diffStat),
    issue_number: issue?.number ?? "",
    // single task: the reviewer gets the issue itself, in full, to check the PR against
    task: Boolean(issue && !sv.spec),
    spec_open: specD.open,
    spec_close: specD.close,
    // The reviewer gets exactly what the executor got of the criteria (see SPEC_CUT).
    criteria: sv.spec ? cut(section(H.criteria), SPEC_CUT) : "",
    decisions: sv.spec ? cut(section(H.decisions), SPEC_CUT / 2) : "",
    out_of_scope: sv.spec ? cut(section(H.outOfScope), SPEC_CUT / 2) : "",
    issue_open: issueD.open,
    issue_close: issueD.close,
    issue_title: oneLine(issue?.title),
    issue_body: issue ? cut(clean(issue.body) || T.prompt.emptyBody, SPEC_CUT) : "",
    open: prD.open,
    close: prD.close,
    title: oneLine(pr.title),
    labels: labels.length ? labels.join(", ") : T.prompt.none,
    body: cut(clean(pr.body) || T.prompt.emptyBody, BODY_CUT),
  })
}

// ---------- PR body ----------

// The plain-language part of a PR body ends at this mark; the folded technical details follow.
export const PLAIN_END = "<!-- /pipeline-summary -->"

const P = T.pr
// Text for humans keeps no HTML comments (every mark is a comment) and no runs of empty lines.
const plainLine = (t, none = P.notWritten) => oneLine(stripMarks(t)) || none
const plainItems = (v) => (Array.isArray(v) ? v : []).map((x) => plainLine(x, "")).filter(Boolean)

// The part of a PR body people read (no heading, no end mark). out: the executor's structured
// output; meta.brief: the issue's "## Summary" text, copied as written.
// Spec row: the issue's brief, then what this step did. Single task: only what the executor wrote.
// "Decided by the executor" and "Not run or not verified" are always printed, also when empty: the
// owner decides from this block, and a missing line reads the same as "nothing to report".
export function plainBlock(out, meta) {
  const p = out?.plain || {}
  const specRow = Number(meta.row) > 0
  const decided = plainItems(p.decided_myself)
  const notVerified = plainItems(out?.not_verified)
  const lines = []
  if (specRow) lines.push(stripMarks(meta.brief) || P.noBrief(meta.issue), "", "---", "")
  lines.push(`**${P.what}**${specRow && Number(meta.rows) > 0 ? P.step(meta.row, meta.rows) : ""}: ${plainLine(p.what)}`, "")
  if (decided.length) lines.push(`**${P.decidedTitle}**${P.decidedHint}:`, "", ...decided.map((x) => `- ${x}`), "")
  else lines.push(`**${P.decidedTitle}**: ${P.decidedNone}`, "")
  lines.push(`**${P.risk}**: ${plainLine(p.risk)}`, "", `**${P.verify}**: ${plainLine(p.verify)}`, "")
  if (notVerified.length) lines.push(`**${P.notVerifiedTitle}**:`, "", ...notVerified.map((x) => `- ${x}`))
  else lines.push(`**${P.notVerifiedTitle}**: ${P.notVerifiedNone}`)
  return lines.join("\n")
}

// The "## Summary" part of a PR body written by prBody ("" when there is none).
export function plainOf(body) {
  const text = String(body || "").replace(/\r/g, "")
  const end = text.indexOf(PLAIN_END)
  const start = text.indexOf(`## ${P.summaryTitle}\n`)
  if (end < 0 || start < 0 || start > end) return ""
  return text.slice(start + P.summaryTitle.length + 4, end).trim()
}

// out: the executor's structured output (prompts/executor.schema.json).
// meta: { issue, row, rows, brief, files, model, turns, usd, runUrl, attempt, draft }
//   row / rows: the split-table row this PR does and how many rows there are (leave out for a
//     single task); brief: the issue's "## Summary" (spec issues);
//   files: paths that really changed (from git). The executor's list only supplies the reasons, so
//     a file it forgot to mention still shows up, flagged.
// First line: "Part of #N" for a spec row (the dispatcher closes the issue after the last row; a
// closing keyword here would close it after the first), "Fixes #N" for a single task.
export function prBody(out, meta) {
  const specRow = Number(meta.row) > 0
  const why = new Map((out?.files || []).map((f) => [String(f?.path || "").replace(/^\.\//, ""), oneLine(f?.why)]))
  const files = Array.isArray(meta.files) ? meta.files.map((f) => String(f).replace(/^\.\//, "")) : [...why.keys()]
  const ev = out?.evidence || {}
  const checks = Array.isArray(ev.checks) ? ev.checks : []
  const command = (c) => (oneLine(c) ? ` \`${oneLine(c)}\`` : "")
  return [
    specRow ? P.partOf(meta.issue, meta.row, meta.rows || meta.row) : P.fixes(meta.issue),
    "",
    `## ${P.summaryTitle}`,
    "",
    plainBlock(out, meta),
    "",
    PLAIN_END,
    "",
    `> ${P.byline(meta)}${meta.draft ? P.draft : ""}${meta.attempt ? `\n> ${P.attempt(meta.attempt)}` : ""}`,
    "",
    "<details>",
    `<summary>${P.detailsTitle}</summary>`,
    "",
    `## ${P.changed}`,
    "",
    clean(out?.summary) || P.notGiven,
    "",
    ...(files.length ? files.map((f) => `- \`${f}\`: ${why.get(f) || P.noWhy}`) : [`- ${P.noFiles}`]),
    "",
    `## ${P.evidence}`,
    "",
    `${P.red}${command(ev.red?.command)}`,
    "",
    fence(ev.red?.output),
    "",
    `${P.green}${command(ev.green?.command)}`,
    "",
    fence(ev.green?.output),
    "",
    P.checks,
    "",
    ...(checks.length ? checks.map((c) => `- \`${oneLine(c?.command)}\`: ${c?.ok ? P.checkOk : P.checkFailed}`) : [`- ${P.noChecks}`]),
    "",
    "</details>",
    ...(meta.runUrl ? ["", "---", P.run(meta.runUrl)] : []),
  ].join("\n")
}
