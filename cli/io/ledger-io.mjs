// The ledger file: `ledger.jsonl` on its own branch (`pipeline/ledger`) of the user's
// repository. The branch holds nothing else, so it never meets the rules that protect the
// code branches. What the entries mean is in cli/core/ledger.mjs.
import { parseLedger } from "../core/ledger.mjs"

export const LEDGER_BRANCH = "pipeline/ledger"
export const LEDGER_FILE = "ledger.jsonl"
// Where the fetched tip is kept locally (outside refs/heads and refs/remotes: nothing else uses it).
const LOCAL_REF = "refs/pipeline/ledger"

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// git: makeGit({ cwd }) of any checkout of the repository (objects are written there, the
//   working tree and the current branch are not touched); url defaults to git.url.
// sleep(ms): synchronous wait between attempts (tests pass a no-op); attempts: pushes tried.
// label: who is writing, for the commit message.
export function makeLedger({ git, url = git.url, branch = LEDGER_BRANCH, log = () => {}, sleep = sleepSync, attempts = 5, label = "pipeline" }) {
  const ref = `refs/heads/${branch}`

  // The branch's newest commit, or "" when the branch does not exist yet. A remote that
  // cannot be reached is an error, never "no ledger yet": budgets would start again from zero.
  const tip = () => {
    const r = git.tryRemote(["ls-remote", "--exit-code", url, ref])
    if (r.rc === 0) return r.stdout.trim().split(/\s+/)[0] || ""
    if (r.rc === 2) return ""
    throw new Error(`ledger: cannot reach the remote (git ls-remote exit ${r.rc}): ${r.stderr.trim().slice(-300)}`)
  }

  // -> { sha, text }: the tip and the file as it is there ("" for both before the first entry).
  const fetchText = () => {
    const sha = tip()
    if (!sha) return { sha: "", text: "" }
    git.remote(["fetch", "-q", "--no-tags", url, `+${ref}:${LOCAL_REF}`])
    const got = git.git(["rev-parse", LOCAL_REF]).trim()
    // The branch exists but has no ledger file (someone created it by hand): start the file.
    const show = git.try(["show", `${got}:${LEDGER_FILE}`])
    return { sha: got, text: show.rc === 0 ? show.stdout : "" }
  }

  return {
    branch,
    tip,
    // Every entry, oldest first. Throws when the remote cannot be reached.
    read() {
      return parseLedger(fetchText().text)
    },
    // Add one entry as a new commit on top of the branch tip. Another run may be writing at
    // the same moment: a rejected push means fetch again and retry. Throws when it never got in.
    append(entry) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("ledger: an entry is a JSON object")
      const line = JSON.stringify(entry)
      let last = ""
      for (let i = 1; i <= attempts; i++) {
        try {
          const { sha, text } = fetchText()
          const body = `${text && !text.endsWith("\n") ? `${text}\n` : text}${line}\n`
          const blob = git.git(["hash-object", "-w", "--stdin"], { input: body }).trim()
          const tree = git.git(["mktree"], { input: `100644 blob ${blob}\t${LEDGER_FILE}\n` }).trim()
          const commit = git.git(["commit-tree", tree, ...(sha ? ["-p", sha] : []), "-m", `ledger: ${label}`]).trim()
          // A plain push: it is refused when the branch moved since the fetch.
          const push = git.tryRemote(["push", "-q", url, `${commit}:${ref}`])
          if (push.rc === 0) {
            log(`ledger: recorded in ${commit.slice(0, 9)}`)
            return commit
          }
          last = push.stderr.trim().slice(-300)
        } catch (e) {
          last = e.message
        }
        if (i < attempts) sleep(i * 5000)
      }
      throw new Error(`ledger: the entry was not recorded after ${attempts} attempts: ${last}`)
    },
  }
}
