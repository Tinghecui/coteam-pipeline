// A deliberately small YAML subset, enough for `.coteam/pipeline.yml` and the presets:
// block maps, block lists, `- key: value` list items, inline lists `[a, "b", 3]`, quoted
// strings, numbers, booleans, null and `#` comments.
//
// The engine has no npm dependencies (it runs in the user's CI straight from a checkout),
// so it cannot pull in a full YAML parser. Anything outside the subset is an error with a
// line number, never a guess: a config that silently means something else than what the
// owner wrote is worse than one that refuses to load.

const fail = (line, msg) => {
  const e = new Error(`line ${line}: ${msg}`)
  e.line = line
  throw e
}

// A quote only opens at the start of a token, so the apostrophe in `don't` is plain text.
const opensQuote = (raw, i) => (raw[i] === '"' || raw[i] === "'") && (i === 0 || /[\s[,]/.test(raw[i - 1]))

// Cut a trailing comment: `#` at the start of the line or after whitespace, outside quotes.
function stripComment(raw, n) {
  let q = ""
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (q) {
      if (q === '"' && c === "\\") i++
      else if (c === q) {
        if (q === "'" && raw[i + 1] === "'") i++
        else q = ""
      }
    } else if (opensQuote(raw, i)) q = c
    else if (c === "#" && (i === 0 || /\s/.test(raw[i - 1]))) return raw.slice(0, i)
  }
  if (q) fail(n, `unterminated ${q} quote`)
  return raw
}

const ESCAPES = { n: "\n", t: "\t", '"': '"', "\\": "\\", "/": "/" }

// Read the quoted string starting at t[start]; returns the value and the index after the closing quote.
function readQuoted(t, start, n) {
  const q = t[start]
  let out = ""
  for (let i = start + 1; i < t.length; i++) {
    const c = t[i]
    if (q === '"' && c === "\\") {
      const e = ESCAPES[t[++i]]
      if (e === undefined) fail(n, `unsupported escape \\${t[i] ?? ""} in a double-quoted string`)
      out += e
    } else if (c === q) {
      if (q === "'" && t[i + 1] === "'") {
        out += "'"
        i++
      } else return { value: out, end: i + 1 }
    } else out += c
  }
  return fail(n, `unterminated ${q} quote`)
}

function plain(t, n) {
  if (/^[{&*!|>%@`]/.test(t) || t === "-" || /^[-?]\s/.test(t)) fail(n, `unsupported YAML syntax "${t}" (quote it if it is a string)`)
  // `a: b: c` is almost always a slip; YAML itself rejects it.
  if (/:\s/.test(t) || t.endsWith(":")) fail(n, `"${t}" contains ": "; put the value in quotes`)
  if (t === "true") return true
  if (t === "false") return false
  if (t === "null" || t === "~") return null
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(t)) return Number(t)
  return t
}

function inlineList(t, n) {
  if (!t.endsWith("]")) fail(n, `inline list "${t}" must close with "]" on the same line`)
  const body = t.slice(1, -1)
  const out = []
  let i = 0
  const skipSpace = () => {
    while (i < body.length && /\s/.test(body[i])) i++
  }
  skipSpace()
  if (i >= body.length) return out
  for (;;) {
    skipSpace()
    if (body[i] === '"' || body[i] === "'") {
      const r = readQuoted(body, i, n)
      out.push(r.value)
      i = r.end
    } else {
      let j = i
      while (j < body.length && body[j] !== ",") j++
      const item = body.slice(i, j).trim()
      if (!item) fail(n, `empty item in inline list "${t}"`)
      if (/[[\]{}]/.test(item)) fail(n, `nested inline collections are not supported: "${t}"`)
      out.push(plain(item, n))
      i = j
    }
    skipSpace()
    if (i >= body.length) return out
    if (body[i] !== ",") fail(n, `expected "," in inline list "${t}"`)
    i++
  }
}

function scalar(v, n) {
  const t = v.trim()
  if (t[0] === '"' || t[0] === "'") {
    const r = readQuoted(t, 0, n)
    if (r.end !== t.length) fail(n, `unexpected text after the closing quote: "${t.slice(r.end).trim()}"`)
    return r.value
  }
  if (t[0] === "[") return inlineList(t, n)
  return plain(t, n)
}

const KEY = /^([A-Za-z_][\w.-]*):(?:\s+(.*))?$/
const isItem = (text) => text === "-" || text.startsWith("- ")

export function parseYaml(text) {
  const lines = []
  String(text ?? "")
    .replace(/\r/g, "")
    .split("\n")
    .forEach((raw, k) => {
      const n = k + 1
      if (/^\s*\t/.test(raw)) fail(n, "tabs cannot be used for indentation")
      const s = stripComment(raw, n).replace(/\s+$/, "")
      if (s.trim()) lines.push({ n, indent: s.length - s.trimStart().length, text: s.trimStart() })
    })
  let i = 0
  const block = (indent) => (isItem(lines[i].text) ? seq(indent) : map(indent))

  function map(indent) {
    const out = {}
    while (i < lines.length && lines[i].indent === indent && !isItem(lines[i].text)) {
      const { n, text } = lines[i]
      const m = KEY.exec(text)
      if (!m) fail(n, `cannot understand "${text}" (expected "key: value")`)
      if (Object.hasOwn(out, m[1])) fail(n, `key "${m[1]}" appears twice`)
      i++
      if (m[2] !== undefined) out[m[1]] = scalar(m[2], n)
      else if (i < lines.length && lines[i].indent > indent) out[m[1]] = block(lines[i].indent)
      // YAML lets a list sit at the same indent as its key.
      else if (i < lines.length && lines[i].indent === indent && isItem(lines[i].text)) out[m[1]] = seq(indent)
      else out[m[1]] = null
    }
    return out
  }

  function seq(indent) {
    const out = []
    while (i < lines.length && lines[i].indent === indent && isItem(lines[i].text)) {
      const { n, text } = lines[i]
      const rest = text.slice(1).trimStart()
      if (!rest) {
        i++
        out.push(i < lines.length && lines[i].indent > indent ? block(lines[i].indent) : null)
      } else if (KEY.test(rest)) {
        // `- key: value` starts a map whose further keys line up with `key`.
        lines[i] = { n, indent: indent + (text.length - rest.length), text: rest }
        out.push(map(lines[i].indent))
      } else {
        out.push(scalar(rest, n))
        i++
      }
    }
    return out
  }

  if (!lines.length) return {}
  const value = block(lines[0].indent)
  if (i < lines.length) fail(lines[i].n, `indentation does not match any enclosing block: "${lines[i].text}"`)
  return value
}
