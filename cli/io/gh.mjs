// GitHub through the `gh` CLI. The token is passed in the child's environment only:
// never on the command line (other processes can read argv) and never written to disk.
import { must, run } from "./proc.mjs"

export function makeGh({ repo, token }) {
  // GH_CONFIG_DIR points at a directory that does not exist: the agent ran as this user and
  // could have written ~/.config/gh (a proxy or socket setting there would see the token).
  const env = { ...process.env, GH_TOKEN: token, GH_PROMPT_DISABLED: "1", GH_CONFIG_DIR: "/nonexistent/coteam-pipeline-gh" }
  const gh = (args, { input } = {}) => must("gh", args, { env, input })
  const api = (method, path, body) => {
    const args = ["api", "-X", method, path]
    if (body !== undefined) args.push("--input", "-")
    const out = gh(args, { input: body === undefined ? undefined : JSON.stringify(body) })
    return out.trim() ? JSON.parse(out) : null
  }
  const r = (path) => (path.startsWith("/") ? path.slice(1) : `repos/${repo}/${path}`)
  return {
    repo,
    get: (path) => api("GET", r(path)),
    // Every page of a list endpoint, concatenated.
    list: (path) =>
      gh(["api", "--paginate", "--slurp", r(path)])
        .trim()
        .split("\n")
        .filter(Boolean)
        .flatMap((l) => JSON.parse(l).flat()),
    post: (path, body) => api("POST", r(path), body),
    patch: (path, body) => api("PATCH", r(path), body),
    put: (path, body) => api("PUT", r(path), body),
    // 404 on delete means it is already gone; anything else is an error.
    del: (path) => {
      const res = run("gh", ["api", "-X", "DELETE", r(path)], { env })
      if (res.rc !== 0 && !/404|Not Found/.test(res.stderr)) throw new Error(`DELETE ${path}: ${res.stderr.trim().slice(-300)}`)
    },
    graphql: (query, variables = {}) => api("POST", "/graphql", { query, variables }),
    dispatch: (workflow, ref, inputs = {}) => api("POST", r(`actions/workflows/${workflow}/dispatches`), { ref, inputs }),
  }
}
