// Trade a GitHub App's private key for an installation token limited to one repository.
// The token lasts an hour, so long runs ask for a new one (cli/io/real.mjs does, after 40 minutes).
//
// This file must stay self-contained: it may import Node's built-in modules and nothing else.
// cli/io/real.mjs reads its text once, when the engine starts, and later runs that text in a
// child process (`node -e`) to renew the token, so that nothing is loaded from the engine's
// checkout after the agent has run (test/main.test.mjs checks both).
import { createSign } from "node:crypto"

const b64 = (x) => Buffer.from(typeof x === "string" ? x : JSON.stringify(x)).toString("base64url")

// The signed app JWT (RS256). `iat` is set a minute back so a runner whose clock runs a
// little fast is still accepted; it is valid for nine minutes.
export function appJwt({ appId, pem, now = new Date() }) {
  if (!/^\d+$/.test(String(appId ?? ""))) throw new Error("app-token: the app id must be a number")
  const key = String(pem || "").trim()
  if (!key.includes("PRIVATE KEY")) throw new Error("app-token: the key is not a PEM private key")
  const t = Math.floor(now.getTime() / 1000)
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: t - 60, exp: t + 540, iss: String(appId) })}`
  try {
    return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(key).toString("base64url")}`
  } catch (e) {
    throw new Error(`app-token: the private key could not sign: ${e.message}`)
  }
}

// One call to the API as the app itself (authenticated with the JWT).
function appApi({ jwt, apiUrl, fetch }) {
  return async (method, path, body) => {
    const r = await fetch(`${String(apiUrl).replace(/\/+$/, "")}${path}`, {
      method,
      headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "coteam-pipeline" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(`app-token: ${method} ${path} -> ${r.status} ${j.message || ""}`.trim())
    return j
  }
}

// -> { token, permissions }. repo: "owner/name"; the token works for that repository only, even
// when the app is installed on more. permissions: what the token may do, as GitHub reports it
// with the token ({ contents: "write", issues: "write", ... }; {} when it said nothing).
// fetch and now are injectable for tests.
export async function mintAppToken({ appId, pem, repo, apiUrl = "https://api.github.com", fetch = globalThis.fetch, now = new Date() }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(repo || ""))) throw new Error(`app-token: the repository must be written owner/name, got ${JSON.stringify(repo ?? null)}`)
  const api = appApi({ jwt: appJwt({ appId, pem, now }), apiUrl, fetch })
  const inst = await api("GET", `/repos/${repo}/installation`)
  const tok = await api("POST", `/app/installations/${inst.id}/access_tokens`, { repositories: [repo.split("/")[1]] })
  if (!tok.token) throw new Error("app-token: the response carried no token")
  const permissions = tok.permissions && typeof tok.permissions === "object" && !Array.isArray(tok.permissions) ? tok.permissions : {}
  return { token: String(tok.token), permissions }
}

// -> the login everything the app writes appears under: "<app-slug>[bot]". An installation
// token cannot ask who it is (GET /user is refused), so the slug is read as the app itself.
export async function appLogin({ appId, pem, apiUrl = "https://api.github.com", fetch = globalThis.fetch, now = new Date() }) {
  const app = await appApi({ jwt: appJwt({ appId, pem, now }), apiUrl, fetch })("GET", "/app")
  if (!app.slug || !/^[\w.-]+$/.test(String(app.slug))) throw new Error("app-token: GET /app carried no slug")
  return `${app.slug}[bot]`
}
