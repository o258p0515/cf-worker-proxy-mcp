import type { Env } from "../types";
import { resolveAccount } from "../rtdb/account-store";
import { verifyGitHubActionsOIDC } from "../auth/github-oidc";
const OPERATIONS = new Set(["clone", "fetch", "pull", "push"]);
const HEADERS = { "Cache-Control": "no-store, private, max-age=0", Pragma: "no-cache", "X-Content-Type-Options": "nosniff" };
function reply(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status, headers: HEADERS });
}
export async function handleGitCredential(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
  const bearer = req.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  if (!bearer || !await verifyGitHubActionsOIDC(bearer)) return reply({ error: "unauthorized" }, 401);
  let input: Record<string, unknown>;
  try {
    const raw = await req.text();
    if (raw.length > 4096) return reply({ error: "request_too_large" }, 413);
    input = JSON.parse(raw) as Record<string, unknown>;
  } catch { return reply({ error: "invalid_json" }, 400); }
  const alias = typeof input.account === "string" ? input.account.trim() : "";
  const operation = typeof input.operation === "string" ? input.operation.trim() : "";
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(alias)) return reply({ error: "invalid_account" }, 400);
  if (!OPERATIONS.has(operation)) return reply({ error: "invalid_operation" }, 400);
  try {
    const result = await resolveAccount(env, alias);
    if (!result.ok) return reply({ error: "account_unavailable" }, 404);
    if (operation === "push" && result.account.readonly) return reply({ error: "account_readonly" }, 403);
    return reply({ account: alias, username: result.account.username || "x-access-token", credential: result.account.token });
  } catch { return reply({ error: "credential_provider_unavailable" }, 503); }
}
