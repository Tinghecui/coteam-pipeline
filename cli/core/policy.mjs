// Risk by path. Rules come from `config.risk`: `forbidden` (the executor may not touch
// these at all) and `level3` / `level2` / `level1` (how much human attention a change
// needs). The two are separate questions: "an agent must not edit this" is not the same as
// "this is risky", and a path may be in both lists.
//
// `files` everywhere is a list of repo-relative paths (strings, or objects with `path`).
// For a rename pass both the old and the new path: moving a file out of a guarded
// directory touches that directory.

// Path glob -> RegExp. `*` stays inside one directory, `**` crosses any number of them
// (`**/` may also be zero directories, so `**/x` matches `x` at the root), `?` is one
// character other than `/`.
export function globRe(glob) {
  let re = ""
  const g = String(glob)
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === "*" && g[i + 1] === "*") {
      const slash = g[i + 2] === "/"
      re += slash ? "(?:.*/)?" : ".*"
      i += slash ? 2 : 1
    } else if (c === "*") re += "[^/]*"
    else if (c === "?") re += "[^/]"
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${re}$`)
}

// Forbidden whatever the config says: with these editable, an agent could rewrite the
// workflows that run it or the rules that judge it. A user's own `risk.forbidden` adds to
// this list and cannot shrink it.
export const ALWAYS_FORBIDDEN = [".github/**", ".coteam/**"]

const pathOf = (f) => String((f && typeof f === "object" ? f.path : f) ?? "").replace(/^\.\//, "")
const firstMatch = (globs, path) => (globs || []).find((g) => globRe(g).test(path)) ?? null

// One entry per file: { path, level, forbidden, match }. `level` is the highest level whose
// list matches (0 when none does); `match` is the glob that set it, for the review comment.
export function classifyPaths(risk, files) {
  const r = risk || {}
  return (files || []).map((f) => {
    const path = pathOf(f)
    let level = 0
    let match = null
    for (const n of [3, 2, 1]) {
      match = firstMatch(r[`level${n}`], path)
      if (match !== null) {
        level = n
        break
      }
    }
    return { path, level, forbidden: firstMatch([...ALWAYS_FORBIDDEN, ...(r.forbidden || [])], path) !== null, match }
  })
}

// Paths the executor was not allowed to touch. Any hit discards the whole change before it is pushed.
export function forbiddenHits(risk, files) {
  return classifyPaths(risk, files)
    .filter((f) => f.forbidden)
    .map((f) => f.path)
}

// The level of a whole change by path alone: the highest level of any file, 0..3.
// The reviewer may raise it, never lower it (see reviewDecision).
export function pathLevel(risk, files) {
  return classifyPaths(risk, files).reduce((m, f) => Math.max(m, f.level), 0)
}
