// Pipeline state kept in the user's GitHub as hidden one-line HTML comments:
//   <!-- pipeline-<kind> {json} -->
// inside issue and PR comments (and, for decision items, the issue body).
//
// `comments` everywhere are REST issue comments: { id, body, created_at, updated_at, user: { login } }.

// A claim older than this is taken to be left behind by a run that died (it must be longer than the executor's time limit).
export const CLAIM_STALE_MS = 3 * 60 * 60 * 1000

const KIND = /^[a-z][a-z0-9-]*$/
const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v)
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&")
const checkKind = (kind) => {
  if (!KIND.test(String(kind))) throw new Error(`mark kind must be lowercase letters, digits and "-": ${JSON.stringify(kind)}`)
}
// The trailing space keeps `pipeline-row` from matching `pipeline-row-done`.
const markRe = (kind) => new RegExp(`<!-- pipeline-${kind} (\\{[^\\n]*?\\}) -->`)

// JSON on one line with `<` and `>` escaped, so no text inside the payload (an issue title,
// a reviewer's sentence) can close the HTML comment early and spill into the page or forge a second mark.
export function mark(kind, obj) {
  checkKind(kind)
  if (!isMap(obj)) throw new Error("a mark carries a JSON object")
  return `<!-- pipeline-${kind} ${JSON.stringify(obj).replace(/</g, "\\u003c").replace(/>/g, "\\u003e")} -->`
}

// The first mark of this kind in one text (a comment body, an issue body); none or unreadable -> null.
export function parseMark(kind, body) {
  checkKind(kind)
  const m = markRe(kind).exec(String(body || ""))
  if (!m) return null
  try {
    const obj = JSON.parse(m[1])
    return isMap(obj) ? obj : null
  } catch {
    return null
  }
}

// Every comment carrying a mark of this kind, in the order given: [{ ...obj, at, by, id, updatedAt, payload }].
// `at`, `by` and `id` come from GitHub (created_at, author login, comment id) and override
// same-named fields in the JSON: anyone who can comment can type a mark, so who posted it
// and when must never be taken from the mark's own text. The JSON as written stays in `payload`.
// opts.authors: when given, only comments by these logins count (pass the pipeline's bot login).
export function findMarks(kind, comments, { authors = null } = {}) {
  return (comments || []).flatMap((c) => {
    const obj = parseMark(kind, c?.body)
    if (!obj) return []
    const by = String(c.user?.login || "")
    if (authors && !authors.includes(by)) return []
    const at = c.created_at || ""
    return [{ ...obj, at, by, id: c.id, updatedAt: c.updated_at || at, payload: obj }]
  })
}

// ---------- whose marks count ----------

// The logins whose marks are believed: the pipeline's own account(s). `botLogin` is what the
// io layer worked out (io.botLogin), `extra` the PIPELINE_BOT setting; either may hold several
// logins separated by commas. Nothing known -> null, and then no role may take a mark's word
// for anything that matters (see trustedComments and the callers).
export function markAuthors(botLogin, extra = "") {
  const all = [botLogin, extra].flatMap((s) => String(s || "").split(",")).map((s) => s.trim()).filter(Boolean)
  return all.length ? [...new Set(all)] : null
}

const lower = (s) => String(s || "").toLowerCase()
export const hasMark = (body) => /<!-- pipeline-[a-z]/.test(String(body || ""))

// The comments a role works with: everything people wrote, and of the comments that carry a
// mark only those posted by the pipeline's own account. Anyone who can comment can type a
// mark; every role filters once, right after reading, so that the tick, the executor and the
// reviewer count the same claims, attempts and decisions. authors null (login not known):
// nothing is dropped.
export function trustedComments(comments, authors) {
  const ok = Array.isArray(authors) && authors.length ? authors.map(lower) : null
  return (comments || []).filter((c) => c && (!ok || !hasMark(c.body) || ok.includes(lower(c.user?.login))))
}

// The comments in which a `review` mark may be believed.
//   authors known:  the same as trustedComments.
//   not known:      a review comment counts only when the pipeline's own commit status on that
//                   head names it. The reviewer sets the status right after the comment, with
//                   the comment's address as its target_url (".../pull/7#issuecomment-123");
//                   a comment can be typed by anyone, a commit status cannot. Every other
//                   review comment is dropped, whoever wrote it.
//   status: the newest status of the pipeline's own context on the head ({ state, target_url }) or null
export function believedReviews(comments, { authors = null, status = null } = {}) {
  if (Array.isArray(authors) && authors.length) return trustedComments(comments, authors)
  const named = /#issuecomment-(\d+)$/.exec(String(status?.target_url || ""))?.[1] || ""
  return (comments || []).filter((c) => c && (!parseMark("review", c.body) || (named && String(c.id) === named)))
}

// ---------- claims: every executor run comments first, the earliest comment wins ----------

// Claims that still count, earliest first. Released ones and stale ones are dropped.
// Time is GitHub's created_at, not anything the comment says about itself; ties go to the lower comment id.
// row: given = only claims on that row of a spec issue.
export function activeClaims(comments, { now = new Date(), staleMs = CLAIM_STALE_MS, row = null, authors = null } = {}) {
  return findMarks("claim", comments, { authors })
    .flatMap((c) => {
      const t = Date.parse(c.at)
      if (c.released === true || !Number.isFinite(t) || now.getTime() - t > staleMs) return []
      if (row !== null && Number(c.row || 0) !== Number(row)) return []
      return [{ id: c.id, run: String(c.run ?? ""), row: Number(c.row || 0), at: c.at, t }]
    })
    .sort((a, b) => a.t - b.t || Number(a.id) - Number(b.id))
}

// The comment body with its claim marked `released: true` (the run is done; edit the comment to this).
export function releaseClaim(body) {
  const obj = parseMark("claim", body)
  return obj ? String(body).replace(markRe("claim"), () => mark("claim", { ...obj, released: true })) : String(body || "")
}

// ---------- reworks and decisions ----------

// Reworks recorded on a PR: [{ id, attempt, sha, why, failed, at }]. `sha` is the head that
// was sent back (the same head is never reworked twice); `failed` = that run pushed nothing new.
export function reworks(comments, opts) {
  return findMarks("rework", comments, opts).map((r) => ({
    id: r.id,
    attempt: Number(r.attempt) || 0,
    sha: String(r.sha || ""),
    why: String(r.why || ""),
    failed: r.failed === true,
    at: r.at,
  }))
}

// The reviewer's most recent verdict on a PR: { sha, verdict, level, by, at, id } or null.
// `at` is when the comment was last written (a review comment may be edited in place).
export function latestReview(comments, opts) {
  const all = findMarks("review", comments, opts).filter((m) => m.verdict)
  if (!all.length) return null
  const m = all.reduce((a, b) => (b.updatedAt >= a.updatedAt ? b : a))
  const level = m.level === null || m.level === undefined || m.level === "" ? null : Number(m.level)
  return { sha: String(m.sha || ""), verdict: String(m.verdict), level, by: m.by, at: m.updatedAt, id: m.id }
}

// A rework on this head no longer needs doing: after it was recorded the reviewer approved
// the very same head (a re-review, or the rules changed). Without this, a reason that
// appears later on that head (say, a conflict with the base branch) could never be
// dispatched, because "this head was already reworked", and the PR would hang forever.
export function reworkObsolete(r, pr, comments, opts) {
  const review = latestReview(comments, opts)
  return Boolean(r?.at && review && review.verdict === "approve" && review.sha === r.sha && review.sha === pr?.head?.sha && review.at > r.at)
}

// When the latest human decision was applied ("" if never), over any number of comment
// lists (the PR's, the issue's). Rework counts and the executor's run/spend counts start
// again after it: a human gave a new direction, so the old attempts no longer say anything.
// The tick and the executor's precheck must both count from this same time. In the source
// pipeline they once disagreed: the tick kept dispatching reworks that the executor refused
// at startup, two dozen times in one night.
export function countSince(...commentLists) {
  return lastDecision(...commentLists)?.at || ""
}

// Comment order: by GitHub's creation time, then by comment id (GitHub's times have whole
// seconds, and one round of the tick easily writes two comments in the same one).
export const isAfter = (m, d) => m.at > d.at || (m.at === d.at && Number(m.id) > Number(d.id))

// The latest `decision` mark over any number of comment lists, or null. Marks are "after the
// decision" when isAfter(mark, it): the tick and the executor must both use this one order
// (a rework mark the tick writes in the same second as the decision it follows counts as after it).
export function lastDecision(...commentLists) {
  return (
    commentLists
      .flatMap((list) => findMarks("decision", list || []))
      .filter((d) => Number.isFinite(Date.parse(d.at)))
      .sort((a, b) => (isAfter(a, b) ? 1 : -1))
      .pop() || null
  )
}

// ---------- branches ----------

// Two or three lowercase words for a branch name.
export function slug(s) {
  const x = String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "")
  return x || "task"
}

// <prefix><issue>[-r<row>]-<slug>
export function branchFor({ prefix, issue, row = 0, title = "" }) {
  let name = slug(title)
  // A single task titled "r2 ..." would otherwise read back as row 2 of a spec issue.
  if (!row && /^r\d+(-|$)/.test(name)) name = `task-${name}`
  return `${prefix}${Number(issue)}${row ? `-r${Number(row)}` : ""}-${name}`
}

// The branch of one row of a spec issue -> { issue, row }; any other branch -> null.
export function rowOfBranch(ref, prefix) {
  const m = new RegExp(`^${escapeRe(prefix)}(\\d+)-r(\\d+)-`).exec(String(ref || ""))
  return m ? { issue: Number(m[1]), row: Number(m[2]) } : null
}

// Which issue a pipeline branch belongs to (row branches included); not a work branch -> 0.
export function issueOfBranch(ref, prefix) {
  return Number(new RegExp(`^${escapeRe(prefix)}(\\d+)-`).exec(String(ref || ""))?.[1]) || 0
}

// Does this text say that it closes issue n? ("Fixes #12", "closes #12", "Resolved #12": the
// words GitHub itself acts on when the pull request is merged.)
export const closesIssue = (text, n) => new RegExp(`\\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?):?\\s+#${Number(n)}\\b`, "i").test(String(text || ""))

// Is this open pull request ({ title, body, head: { ref } }) work on issue n? Either it sits on a
// work branch named for the issue, or its title or body says it closes the issue: then
// somebody (the pipeline itself, or a person with a pull request of their own) has taken the
// issue, and the executor is not started for it. The tick and the executor both ask here, so
// that the one never dispatches what the other refuses.
export const takesIssue = (pr, n, prefix) => issueOfBranch(pr?.head?.ref, prefix) === Number(n) || closesIssue(pr?.body, n) || closesIssue(pr?.title, n)

// ---------- spec issue progress, remembered on the issue ----------
// Progress is read from marks on the issue, not from the PR list: a PR merged or closed
// long ago is no longer among the recent ones the tick fetches.

// Map(row -> pr) of rows that are merged. pr 0 = verified as already present on the base branch, no PR needed.
export function rowsDone(comments, opts) {
  const done = new Map()
  for (const m of findMarks("row-done", comments, opts)) if (Number(m.row) > 0) done.set(Number(m.row), Number(m.pr) || 0)
  return done
}

// Rows whose pipeline PR was closed without merging: a human did not want that version. The
// row stops (rows depending on it wait, the others go on) and is not redone on its own; the
// redo label on the closed PR asks for a fresh attempt from the current base branch.
// Per row only the newest PR (highest number) counts. A single task has no rows and is recorded as row 0.
//   issue:     the issue the PRs must belong to; null = the list holds this issue's PRs only (any pipeline branch counts)
//   closedPrs: REST PRs ({ number, head: { ref } | "ref", merged_at, labels })
// Returns Map(row -> { pr, redo, marked, markedRedo }): redo = labelled or already recorded
// as redone; marked / markedRedo = the issue already carries the `row-closed` mark for this
// PR (plain / with redo), so the tick knows what is still to be written.
export function closedRows(issue, { closedPrs = [], comments = [], prefix, redoLabel, authors = null }) {
  const out = new Map()
  const put = (row, pr, x) => {
    const cur = out.get(row)
    if (cur && cur.pr > pr) return
    const b = cur && cur.pr === pr ? cur : { pr, redo: false, marked: false, markedRedo: false }
    out.set(row, { pr, redo: b.redo || Boolean(x.redo), marked: b.marked || Boolean(x.marked), markedRedo: b.markedRedo || Boolean(x.markedRedo) })
  }
  for (const m of findMarks("row-closed", comments, { authors })) {
    const [row, pr] = [Number(m.row), Number(m.pr)]
    if (pr > 0 && Number.isInteger(row) && row >= 0) put(row, pr, { marked: true, redo: m.redo === true, markedRedo: m.redo === true })
  }
  for (const p of closedPrs || []) {
    const ref = String((typeof p.head === "string" ? p.head : p.head?.ref) || "")
    const of = issueOfBranch(ref, prefix)
    if (p.merged_at || !of || (issue !== null && issue !== undefined && of !== Number(issue))) continue
    const labels = (p.labels || []).map((l) => (typeof l === "string" ? l : l.name))
    put(rowOfBranch(ref, prefix)?.row ?? 0, p.number, { redo: labels.includes(redoLabel) })
  }
  return out
}
