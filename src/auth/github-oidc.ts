const JWKS_URL = "https://token.actions.githubusercontent.com/.well-known/jwks";
const EXPECTED_AUDIENCE = "localmcpcoder-git-credential";
const EXPECTED_REPOSITORY = "o258p0515/localmcpcoder-go";
const EXPECTED_WORKFLOW_REF = EXPECTED_REPOSITORY + "/.github/workflows/git-executor-runner.yml@refs/heads/main";
type Claims = Record<string, unknown>;
type JwkSet = { keys: (JsonWebKey & { kid?: string })[] };
let cachedKeys: JwkSet["keys"] = [];
let cachedAt = 0;
let lastForcedRefreshAt = 0;
const JWKS_TIMEOUT_MS = 5_000;
const JWKS_REFRESH_COOLDOWN_MS = 30_000;

function decode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}
function decodeJson(value: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(decode(value))) as Record<string, unknown>;
}
async function signingKeys(force = false): Promise<JwkSet["keys"]> {
  if (!force && cachedKeys.length && Date.now() - cachedAt < 5 * 60_000) return cachedKeys;
  if (force) {
    const now = Date.now();
    if (now - lastForcedRefreshAt < JWKS_REFRESH_COOLDOWN_MS && cachedKeys.length) return cachedKeys;
    lastForcedRefreshAt = now;
  }
  const response = await fetch(JWKS_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(JWKS_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error("OIDC signing keys unavailable");
  const body = await response.json() as JwkSet;
  if (!Array.isArray(body.keys) || !body.keys.length) throw new Error("OIDC signing keys invalid");
  cachedKeys = body.keys;
  cachedAt = Date.now();
  return cachedKeys;
}
export async function verifyGitHubActionsOIDC(token: string): Promise<Claims | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || token.length > 16_384) return null;
    const header = decodeJson(parts[0]!);
    const claims = decodeJson(parts[1]!);
    if (header.alg !== "RS256" || typeof header.kid !== "string") return null;
    let key = (await signingKeys()).find(k => k.kid === header.kid);
    if (!key) key = (await signingKeys(true)).find(k => k.kid === header.kid);
    if (!key) return null;
    const publicKey = await crypto.subtle.importKey("jwk", key, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    if (!await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, decode(parts[2]!) as BufferSource, new TextEncoder().encode(parts[0] + "." + parts[1]))) return null;
    const now = Math.floor(Date.now() / 1000);
    const aud = claims.aud;
    if (!(aud === EXPECTED_AUDIENCE || (Array.isArray(aud) && aud.includes(EXPECTED_AUDIENCE)))) return null;
    if (claims.iss !== "https://token.actions.githubusercontent.com") return null;
    if (typeof claims.exp !== "number" || claims.exp <= now || typeof claims.iat !== "number" || claims.iat > now + 60) return null;
    if (typeof claims.nbf === "number" && claims.nbf > now + 60) return null;
    if (claims.repository !== EXPECTED_REPOSITORY || claims.repository_owner !== "o258p0515") return null;
    if (claims.workflow_ref !== EXPECTED_WORKFLOW_REF || claims.ref !== "refs/heads/main") return null;
    if (claims.event_name !== "workflow_dispatch" || claims.sub !== "repo:" + EXPECTED_REPOSITORY + ":ref:refs/heads/main") return null;
    if (claims.runner_environment !== "github-hosted") return null;
    return claims;
  } catch { return null; }
}
