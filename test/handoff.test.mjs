// What passes between the three jobs of an agent role, and the command line's part commands
// as far as they can be run without GitHub.
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { cleanResult, cleanUsage, digest, MAX_RESULT_BYTES, openOrder, orderId, ORDER_FILE, sealOrder } from "../cli/core/handoff.mjs"
import { main } from "../cli/main.mjs"

test("the order is believed only with the digest prepare reported, and only for its own role", () => {
  const order = { v: 1, role: "fix", issue: 5, prompt: "do it" }
  const { text, sha256 } = sealOrder(order)
  assert.match(sha256, /^[0-9a-f]{64}$/)
  assert.equal(sha256, digest(text))
  // the id the agent part writes into its result is the same digest, whichever side of a file the order is on
  assert.equal(orderId(order), sha256)
  assert.equal(orderId(JSON.parse(text)), sha256)
  assert.deepEqual(openOrder(text, sha256, "fix"), order)
  // replaced on the way: one byte is enough
  assert.throws(() => openOrder(text.replace('"issue":5', '"issue":6'), sha256, "fix"), /digest does not match/)
  // no digest, a digest of the wrong shape, the digest of the replacement itself given by nobody
  for (const bad of ["", undefined, "abc", sha256.toUpperCase(), `${sha256} `]) assert.throws(() => openOrder(text, bad, "fix"), /digest does not match/)
  assert.throws(() => openOrder(text, sha256, "review"), /not one for "review"/)
  assert.throws(() => openOrder(null, sha256, "fix"), /digest does not match/)
})

test("cleanUsage: numbers that are numbers, model names that look like names, an outage the engine knows", () => {
  assert.deepEqual(cleanUsage(null), { turns: 0, usd: 0, models: [] })
  assert.deepEqual(cleanUsage({ turns: 20, usd: 1.5, models: ["claude-x-1[1m]", "a b", 7, "<!-- -->"] }), { turns: 20, usd: 1.5, models: ["claude-x-1[1m]"] })
  assert.deepEqual(cleanUsage({ turns: -1, usd: "NaN", models: "m" }), { turns: 0, usd: 0, models: [] })
  assert.deepEqual(cleanUsage({ turns: 2.7, usd: Infinity }), { turns: 2, usd: 0, models: [] })
  assert.deepEqual(cleanUsage({ unavailable: "quota", resets_at: "2026-01-10T15:00:00Z" }), { turns: 0, usd: 0, models: [], unavailable: "quota", resets_at: "2026-01-10T15:00:00Z" })
  assert.deepEqual(cleanUsage({ unavailable: "quota", resets_at: "<!-- x -->" }), { turns: 0, usd: 0, models: [], unavailable: "quota" })
  // a reason nobody knows is no outage, and a reset time without an outage is dropped
  assert.deepEqual(cleanUsage({ unavailable: "<script>", resets_at: "2026-01-10T15:00:00Z" }), { turns: 0, usd: 0, models: [] })
})

test("cleanResult: only the known fields, each of its type; anything else is no result", () => {
  for (const bad of [null, undefined, "", "not json", "[]", "7", [], 7, "x".repeat(MAX_RESULT_BYTES + 1)]) assert.equal(cleanResult(bad), null, String(bad).slice(0, 20))
  const r = cleanResult(JSON.stringify({ outcome: "staged", pr: 9, files: ["a"], reason: { toString: "x" }, detail: "d".repeat(9000), rc: "1", output: ["not", "an", "object"], usage: { turns: 3 } }))
  assert.deepEqual(Object.keys(r).sort(), ["detail", "error", "order", "outcome", "output", "rc", "reason", "usage", "why"])
  assert.deepEqual([r.outcome, r.reason, r.detail.length, r.rc, r.output, r.usage], ["staged", "", 4000, null, null, { turns: 3, usd: 0, models: [] }])
  assert.deepEqual(cleanResult({ outcome: "x", output: { a: 1 }, rc: 124 }).output, { a: 1 })
})

const capture = () => {
  const c = { out: [], err: [] }
  return { ...c, ctx: { out: (s) => c.out.push(s), err: (s) => c.err.push(s) } }
}

test("the part commands: publish refuses an order whose digest is not the given one before it does anything; each part needs its directories", async () => {
  const dir = mkdtempSync(join(tmpdir(), "handoff-test-"))
  const sealed = sealOrder({ v: 1, role: "fix", issue: 5 })
  mkdirSync(join(dir, "order"))
  writeFileSync(join(dir, "order", ORDER_FILE), sealed.text.replace("5", "6"))
  // env is empty: reaching GitHub (or even asking for a token) would fail with another message
  const run = async (argv) => {
    const c = capture()
    return [await main(argv, { ...c.ctx, env: {}, cwd: dir }), c.err.join("\n")]
  }
  assert.deepEqual(await run(["fix", "publish", "--order=order", `--sha256=${sealed.sha256}`, "--result=result"]), [1, "the work order is not the one the prepare job wrote (its digest does not match); nothing was published"])
  assert.match((await run(["fix", "publish", "--order=order", "--sha256=", "--result=result"]))[1], /digest does not match/)
  assert.match((await run(["review", "publish", "--sha256=x", "--result=result"]))[1], /this part needs --order DIR/)
  // the agent part: an order for the other role, or none
  writeFileSync(join(dir, "order", ORDER_FILE), sealed.text)
  assert.match((await run(["review", "agent", "--order=order", "--result=result"]))[1], /not one for "review"/)
  assert.match((await run(["fix", "agent", "--result=result"]))[1], /this part needs --order DIR/)
  // prepare still needs its numbers; the other two do not
  assert.match((await run(["fix", "prepare", "--order=order"]))[1], /fix needs --issue/)
  assert.match((await run(["review", "prepare", "--order=order"]))[1], /review needs --pr/)
  // an order that is right gets as far as needing the repository (no GITHUB_REPOSITORY here)
  symlinkSync(join(dir, "order", ORDER_FILE), join(dir, "link"))
  assert.match((await run(["fix", "publish", "--order=order", `--sha256=${sealed.sha256}`, "--result=result"]))[1], /GITHUB_REPOSITORY must be set/)
})
