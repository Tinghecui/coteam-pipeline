// What passes between the three parts of an agent role (docs/design-0.1.md, "Three jobs").
//
//   prepare  holds the bot's credential, never runs the agent or the repository's code.
//            Writes the work order.
//   agent    holds the model credential and nothing that can write to GitHub. Runs the
//            agent and the repository's code. Writes a result.
//   publish  holds the bot's credential, never runs the agent or the repository's code.
//            Reads the order and the result and writes to GitHub.
//
// The order travels prepare -> agent -> publish as a file the agent's machine could have
// replaced, so publish believes it only when its digest is the one prepare reported through
// the job's outputs, which the agent's machine cannot change. The result is written on the
// agent's machine and is believed in nothing: everything here that reads one cleans it first.
import { createHash } from "node:crypto"

export const ORDER_FILE = "order.json"
export const RESULT_FILE = "result.json"
export const BUNDLE_FILE = "change.bundle"
// A result larger than this is not read at all.
export const MAX_RESULT_BYTES = 4000000

export const digest = (text) => createHash("sha256").update(String(text), "utf8").digest("hex")

// The order as the file holds it, and the digest that goes into the job's outputs.
export function sealOrder(order) {
  const text = JSON.stringify(order)
  return { text, sha256: digest(text) }
}

// The same digest, from the order itself. The agent part writes it into its result, and
// publish takes a result only for the order it holds: a workflow run that is started again
// keeps the artifacts of its earlier attempt, and a tree made for an older order (an older
// base commit) must never be committed on top of a newer one.
export const orderId = (order) => digest(JSON.stringify(order))

// -> the order, or throws: publish must not act on an order nobody vouches for.
export function openOrder(text, sha256, role) {
  if (typeof text !== "string" || !/^[0-9a-f]{64}$/.test(String(sha256 || "")) || digest(text) !== sha256) throw new Error("the work order is not the one the prepare job wrote (its digest does not match); nothing was published")
  const order = JSON.parse(text)
  if (!order || typeof order !== "object" || order.role !== role) throw new Error(`the work order is not one for "${role}"`)
  return order
}

const UNAVAILABLE = ["quota", "overloaded", "auth", "not_started"]
const text = (v, max) => (typeof v === "string" ? v.slice(0, max) : "")

// The usage figures of a result, as far as they can be believed: numbers that are numbers,
// model names that look like model names, an outage reason the engine knows.
export function cleanUsage(u) {
  const n = (v, max) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.min(Number(v), max) : 0)
  const models = (Array.isArray(u?.models) ? u.models : []).filter((m) => typeof m === "string" && /^[\w.:@\[\]-]{1,80}$/.test(m)).slice(0, 8)
  const resets = typeof u?.resets_at === "string" && /^[\dT:.Z+-]{10,35}$/.test(u.resets_at) && Number.isFinite(Date.parse(u.resets_at)) ? u.resets_at : ""
  const unavailable = UNAVAILABLE.includes(u?.unavailable) ? u.unavailable : ""
  return { turns: Math.floor(n(u?.turns, 100000)), usd: n(u?.usd, 100000), models, ...(unavailable ? { unavailable, ...(resets ? { resets_at: resets } : {}) } : {}) }
}

// The result of an agent part, parsed from untrusted text. -> null when it is not one.
// Only the fields named here survive, each with the type it should have; whether `output`
// matches its schema is the role's check.
export function cleanResult(raw) {
  let r = raw
  if (typeof raw === "string") {
    if (raw.length > MAX_RESULT_BYTES) return null
    try {
      r = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!r || typeof r !== "object" || Array.isArray(r)) return null
  return {
    order: text(r.order, 64),
    outcome: text(r.outcome, 40),
    why: text(r.why, 40),
    reason: text(r.reason, 6000),
    detail: text(r.detail, 4000),
    error: text(r.error, 400),
    rc: Number.isInteger(r.rc) ? r.rc : null,
    output: r.output && typeof r.output === "object" && !Array.isArray(r.output) ? r.output : null,
    usage: cleanUsage(r.usage),
  }
}
