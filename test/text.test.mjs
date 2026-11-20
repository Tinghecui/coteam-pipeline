// cli/core/text.mjs holds the wording of every module. Its entries were moved there from the
// modules that use them, so this calls each one with a stand-in argument: an entry that still
// leans on a helper of its old module fails here with a ReferenceError.
import test from "node:test"
import assert from "node:assert/strict"
import * as text from "../cli/core/text.mjs"

// Stands in for any argument: every property, call, iteration and string conversion works.
const dummy = () => {
  const f = function () {}
  return new Proxy(f, {
    get(_, key) {
      if (key === Symbol.toPrimitive) return () => "1"
      if (key === Symbol.iterator) return function* () {}
      if (key === "toString" || key === "valueOf") return () => "1"
      if (key === "length") return 0
      if (key === "then") return undefined
      if (["map", "filter", "slice", "concat"].includes(key)) return () => []
      if (key === "join" || key === "trim" || key === "replace" || key === "toFixed") return () => "x"
      if (key === "includes" || key === "startsWith") return () => false
      return dummy()
    },
    apply: () => dummy(),
  })
}

const walk = (node, path, seen) => {
  if (typeof node === "function") {
    seen.count++
    try {
      node(dummy(), dummy(), dummy(), dummy(), dummy())
    } catch (e) {
      // Only a missing name matters here; a stand-in argument may well upset the wording itself.
      if (e instanceof ReferenceError) assert.fail(`${path}: ${e.message}`)
    }
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`, seen)
  } else if (typeof node === "string") seen.count++
}

test("every entry of text.mjs stands on its own arguments", () => {
  const seen = { count: 0 }
  for (const [name, value] of Object.entries(text)) walk(value, name, seen)
  assert.ok(seen.count > 100, `walked ${seen.count} entries`)
})

test("each module's TEXT is the object kept in text.mjs", async () => {
  const pairs = [
    ["../cli/core/ledger.mjs", "LEDGER_TEXT"], ["../cli/core/decide.mjs", "DECIDE_TEXT"],
    ["../cli/core/items.mjs", "ITEMS_TEXT"], ["../cli/core/review-comment.mjs", "REVIEW_TEXT"],
    ["../cli/core/plan.mjs", "PLAN_TEXT"], ["../cli/roles/tick.mjs", "TICK_TEXT"],
    ["../cli/roles/fix.mjs", "FIX_TEXT"],
  ]
  for (const [file, name] of pairs) assert.equal((await import(file)).TEXT, text[name], file)
})
