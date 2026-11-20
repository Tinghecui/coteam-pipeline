// git with the bot token. The token rides in the git process's own environment as an
// http.extraheader: not in argv, not in .git/config, so nothing the agent ran earlier in
// the checkout can read it back.
import { must, run } from "./proc.mjs"

export function makeGit({ repo, token, cwd, url = `https://github.com/${repo}.git`, author = { name: "coteam-pipeline", email: "coteam-pipeline@users.noreply.github.com" } }) {
  // Remote operations ignore the global and system git config: the agent ran in this
  // machine's home directory and could have left a `url.*.insteadOf` there to redirect the
  // authenticated push somewhere else.
  const authEnv = token
    ? {
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraheader",
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
      }
    : {}
  const base = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email }
  return {
    url,
    cwd,
    // Local operations: no token in the environment.
    git: (args, opts = {}) => must("git", args, { cwd, env: base, ...opts }),
    try: (args, opts = {}) => run("git", args, { cwd, env: base, ...opts }),
    // Operations that talk to the remote.
    remote: (args, opts = {}) => must("git", args, { cwd, env: { ...base, ...authEnv }, ...opts }),
    tryRemote: (args, opts = {}) => run("git", args, { cwd, env: { ...base, ...authEnv }, ...opts }),
  }
}
