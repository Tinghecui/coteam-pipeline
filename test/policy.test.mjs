import assert from "node:assert/strict"
import { test } from "node:test"
import { classifyPaths, forbiddenHits, globRe, pathLevel } from "../cli/core/policy.mjs"

const risk = {
  forbidden: [".github/**", ".coteam/**", "CLAUDE.md", "**/AGENTS.md"],
  level3: ["**/auth/**", "**/migrations/**", ".github/workflows/release.yml"],
  level2: ["src/billing/**"],
  level1: [".github/**", "src/app/**/page.tsx", "src/billing/README.md"],
}

test("globs: * stays in one directory, ** crosses any number (including none), ? is one character", () => {
  assert.ok(globRe("src/app/**/page.tsx").test("src/app/page.tsx"))
  assert.ok(globRe("src/app/**/page.tsx").test("src/app/a/b/page.tsx"))
  assert.ok(!globRe("src/*.ts").test("src/a/b.ts"))
  assert.ok(globRe("src/*.ts").test("src/a.ts"))
  assert.ok(globRe("**/AGENTS.md").test("AGENTS.md"))
  assert.ok(globRe("**/AGENTS.md").test("a/b/AGENTS.md"))
  assert.ok(globRe(".github/**").test(".github/workflows/x.yml"))
  assert.ok(!globRe(".github/**").test(".githubx/a"))
  assert.ok(globRe("notes/????-??-??-*.md").test("notes/2026-11-15-a-b.md"))
  assert.ok(!globRe("notes/????-??-??-*.md").test("notes/x/2026-11-15-a.md"))
  // regex characters in a glob are literal
  assert.ok(!globRe("a.rs").test("aXrs"))
  assert.ok(globRe("a+(b).[c]").test("a+(b).[c]"))
  assert.ok(globRe("**/auth/**").test("auth/x.js"))
  assert.ok(globRe("**/auth/**").test("src/auth/deep/x.js"))
  assert.ok(!globRe("**/auth/**").test("src/author/x.js"))
})

test("a file takes the highest level that matches; no match is level 0", () => {
  const c = classifyPaths(risk, ["src/a.ts", "src/billing/README.md", "src/billing/auth/x.ts", ".github/workflows/release.yml", "src/app/inbox/page.tsx"])
  assert.deepEqual(
    c.map((f) => [f.path, f.level, f.match]),
    [
      ["src/a.ts", 0, null],
      ["src/billing/README.md", 2, "src/billing/**"],
      ["src/billing/auth/x.ts", 3, "**/auth/**"],
      [".github/workflows/release.yml", 3, ".github/workflows/release.yml"],
      ["src/app/inbox/page.tsx", 1, "src/app/**/page.tsx"],
    ],
  )
})

test("pathLevel: the highest file wins; nothing changed or no rules is 0", () => {
  assert.equal(pathLevel(risk, ["src/a.ts", "docs/x.md"]), 0)
  assert.equal(pathLevel(risk, ["src/a.ts", "src/app/x/page.tsx"]), 1)
  assert.equal(pathLevel(risk, ["src/app/x/page.tsx", "src/billing/a.ts"]), 2)
  assert.equal(pathLevel(risk, ["src/billing/a.ts", "db/migrations/001.sql", "src/a.ts"]), 3)
  assert.equal(pathLevel(risk, []), 0)
  assert.equal(pathLevel({}, ["db/migrations/001.sql"]), 0)
  assert.equal(pathLevel({ forbidden: [], level3: [], level2: [], level1: [] }, ["x"]), 0)
})

test("forbidden is a separate question from the level", () => {
  assert.deepEqual(forbiddenHits(risk, ["src/a.ts", ".github/workflows/ci.yml", "CLAUDE.md", "docs/CLAUDE.md", "pkg/AGENTS.md", ".coteam/pipeline.yml"]), [
    ".github/workflows/ci.yml",
    "CLAUDE.md",
    "pkg/AGENTS.md",
    ".coteam/pipeline.yml",
  ])
  assert.deepEqual(forbiddenHits(risk, ["src/auth/login.ts"]), [])
  // forbidden for the executor, yet only level 1 when someone else changes it
  const [ci] = classifyPaths(risk, [".github/workflows/ci.yml"])
  assert.deepEqual([ci.forbidden, ci.level], [true, 1])
  // level 3 without being forbidden: the executor may change it, the PR waits for an owner
  const [auth] = classifyPaths(risk, ["src/auth/login.ts"])
  assert.deepEqual([auth.forbidden, auth.level], [false, 3])
})

test("files may be strings or { path } objects; a leading ./ is ignored", () => {
  assert.deepEqual(forbiddenHits(risk, [{ path: "./.github/x.yml", status: "A" }, "./src/a.ts"]), [".github/x.yml"])
  assert.equal(pathLevel(risk, [{ path: "src/auth/a.ts" }]), 3)
})

test("workflow and pipeline config paths are forbidden even when the config lists nothing", () => {
  assert.deepEqual(forbiddenHits({ forbidden: [] }, [".github/workflows/ci.yml", ".coteam/pipeline.yml", "src/a.js"]), [
    ".github/workflows/ci.yml",
    ".coteam/pipeline.yml",
  ])
})
