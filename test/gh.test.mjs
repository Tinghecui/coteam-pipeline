import { test } from "node:test"
import assert from "node:assert/strict"
import { pages } from "../cli/io/gh.mjs"

test("pages: the pages gh --paginate prints, back to back or one per line", () => {
  assert.deepEqual(pages('[{"a":1},{"a":2}][{"a":3}]\n'), [[{ a: 1 }, { a: 2 }], [{ a: 3 }]])
  assert.deepEqual(pages("[1]\n[2,3]\n"), [[1], [2, 3]])
  assert.deepEqual(pages("[]"), [[]])
  assert.deepEqual(pages(""), [])
})

test("pages: brackets and quotes inside strings do not split a page", () => {
  const body = [{ title: 'a ] b [ "c" \\ }{' }]
  assert.deepEqual(pages(JSON.stringify(body) + JSON.stringify([{ title: "x" }])), [body, [{ title: "x" }]])
})

test("pages: cut-off output is an error, not fewer items", () => {
  assert.throws(() => pages('[{"a":1},'), /not complete JSON/)
  assert.throws(() => pages('[{"a":"x'), /not complete JSON/)
})
