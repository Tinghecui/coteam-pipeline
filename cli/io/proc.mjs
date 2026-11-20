// Child processes. One place so roles can be tested with a fake `io`.
import { spawnSync } from "node:child_process"

// Run a command without a shell. Returns { rc, stdout, stderr }; never throws on a
// non-zero exit (callers decide what a failure means).
export function run(cmd, args = [], { cwd, env, input, timeoutMs } = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    env: env ?? process.env,
    input,
    timeout: timeoutMs,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  })
  if (r.error && r.error.code !== "ETIMEDOUT") throw r.error
  return { rc: r.status ?? (r.error ? 124 : 1), stdout: r.stdout || "", stderr: r.stderr || "" }
}

// Same, but a non-zero exit is an Error carrying the end of stderr.
export function must(cmd, args = [], opts = {}) {
  const r = run(cmd, args, opts)
  if (r.rc !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(" ")} failed (${r.rc}): ${r.stderr.trim().slice(-600)}`)
  return r.stdout
}

// A shell line from the user's config (stack.setup / stack.check). Output is returned, not inherited.
export const shell = (line, opts = {}) => run("bash", ["-lc", line], opts)
