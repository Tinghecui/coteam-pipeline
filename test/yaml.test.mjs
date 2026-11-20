import assert from "node:assert/strict"
import { test } from "node:test"
import { parseYaml } from "../cli/core/yaml.mjs"

test("block maps, block lists, `- key:` items, comments and quotes", () => {
  const doc = parseYaml(`# header
rules:
  - level: 3   # trailing comment
    why: "a value with # in it"
    paths:
      - a/b.rs
      - "**/X.md"
  - level: 0
    paths:
    - c
top: x
`)
  assert.deepEqual(doc, { rules: [{ level: 3, why: "a value with # in it", paths: ["a/b.rs", "**/X.md"] }, { level: 0, paths: ["c"] }], top: "x" })
})

test("scalars: numbers, booleans, null, strings that only look like numbers", () => {
  assert.deepEqual(parseYaml("a: 1\nb: -2.5\nc: true\nd: false\ne: null\nf: ~\ng:\nh: 1.2.3\ni: 007\nj: \"12\"\nk: 'true'\nl: pipeline/\nm: 1e3\n"), {
    a: 1,
    b: -2.5,
    c: true,
    d: false,
    e: null,
    f: null,
    g: null,
    h: "1.2.3",
    i: "007",
    j: "12",
    k: "true",
    l: "pipeline/",
    m: "1e3",
  })
})

test("quoted strings: escapes, doubled single quotes, colons and hashes inside", () => {
  assert.deepEqual(parseYaml(`a: "say \\"hi\\"\\n"\nb: 'it''s'\nc: "pipeline:decide"  # note\nd: 'x # y'\ne: don't # comment\n`), {
    a: 'say "hi"\n',
    b: "it's",
    c: "pipeline:decide",
    d: "x # y",
    e: "don't",
  })
})

test("inline lists: empty, mixed, quoted items containing commas, as list items", () => {
  assert.deepEqual(parseYaml(`a: []\nb: [ ]\nc: [x, "y, z", 3, true, 'q']   # c\nd: ["src/**/*.tsx", "src/**/*.css"]\ne:\n  - [1, 2]\n  - plain\n`), {
    a: [],
    b: [],
    c: ["x", "y, z", 3, true, "q"],
    d: ["src/**/*.tsx", "src/**/*.css"],
    e: [[1, 2], "plain"],
  })
})

test("nested maps, lists of maps, empty items, empty documents, CRLF", () => {
  assert.deepEqual(parseYaml("a:\r\n  b:\r\n    c: 1\r\n  d: [x]\r\ne:\r\n  -\r\n  - k: v\r\n    l: w\r\n"), { a: { b: { c: 1 }, d: ["x"] }, e: [null, { k: "v", l: "w" }] })
  assert.deepEqual(parseYaml(""), {})
  assert.deepEqual(parseYaml("# only a comment\n\n"), {})
  assert.deepEqual(parseYaml("- a\n- b\n"), ["a", "b"])
})

test("anything outside the subset is an error with its line number", () => {
  const bad = [
    ["a: 1\nb: {x: 1}\n", /line 2: unsupported/],
    ["a: |\n  text\n", /line 1: unsupported/],
    ["a: &anchor x\n", /line 1: unsupported/],
    ["a: *ref\n", /line 1: unsupported/],
    ["a: !!str x\n", /line 1: unsupported/],
    ["x: 1\na:\n  - x\n b: y\n", /line 4: indentation/],
    ["a: 1\na: 2\n", /line 2: key "a" appears twice/],
    ["a:\n\t- x\n", /line 2: tabs/],
    ["ok: 1\njust some words\n", /line 2: cannot understand/],
    ['"quoted key": 1\n', /line 1: cannot understand/],
    ["a: [1, 2\n", /line 1: inline list/],
    ["a: [1, [2]]\n", /line 1: nested/],
    ["a: [1,, 2]\n", /line 1: empty item/],
    ['a: ["x" y]\n', /line 1: expected ","/],
    ['a: "open\n', /line 1: unterminated/],
    ["a: 'open\n", /line 1: unterminated/],
    ['a: "x" y\n', /line 1: unexpected text/],
    ['a: "\\q"\n', /line 1: unsupported escape/],
    ["a: b: c\n", /line 1: .*quotes/],
    ["a:\n  - - x\n", /line 2: unsupported/],
    ["---\na: 1\n", /line 1/],
  ]
  for (const [text, re] of bad) assert.throws(() => parseYaml(text), re, JSON.stringify(text))
  try {
    parseYaml("a: 1\nb: {}\n")
  } catch (e) {
    assert.equal(e.line, 2)
  }
})
