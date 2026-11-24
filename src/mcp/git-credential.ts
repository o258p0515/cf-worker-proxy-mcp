import type { Env } from "../types";
import { resolveAccount } from "../rtdb/account-store";
const OPERATIONS = new Set(["clone", "fetch", "pull", "push"]);
function normalizeRepository(value: string): string | null {
  const raw = value.trim().replace(/^https:\/\/github\.com\//i, "").replace(/\.git$/i, "").toLowerCase();
  const parts = raw.split("/");
  if (parts.length !== 2 || !/^[a-z0-9_.-]+$/.test(parts[0]!) || !/^[a-z0-9_.-]+$/.test(parts[1]!)) return null;
  return parts.join("/");
}
const HEADERS = { "Cache-Control": "no-store, private, max-age=0", Pragma: "no-cache", "X-Content-Type-Options": "nosniff" };
function reply(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status, headers: HEADERS });
}
async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b))
  ]);
  const x = new Uint8Array(left), y = new Uint8Array(right);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0 && a.length > 0 && b.length > 0;
}
export async function handleGitCredential(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
  if (!env.GIT_EXECUTOR_TOKEN || env.GIT_EXECUTOR_TOKEN.length < 32) return reply({ error: "executor_auth_not_configured" }, 503);
  const bearer = req.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  if (!await constantTimeEqual(bearer, env.GIT_EXECUTOR_TOKEN)) return reply({ error: "unauthorized" }, 401);
  let input: Record<string, unknown>;
  try {
    const raw = await req.text();
    if (raw.length > 4096) return reply({ error: "request_too_large" }, 413);
    input = JSON.parse(raw) as Record<string, unknown>;
  } catch { return reply({ error: "invalid_json" }, 400); }
  const alias = typeof input.account === "string" ? input.account.trim() : "";
  const operation = typeof input.operation === "string" ? input.operation.trim() : "";
  const repository = typeof input.repository === "string" ? normalizeRepository(input.repository) : null;
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(alias)) return reply({ error: "invalid_account" }, 400);
  if (!OPERATIONS.has(operation)) return reply({ error: "invalid_operation" }, 400);
  if (!repository) return reply({ error: "invalid_repository" }, 400);
  try {
    const result = await resolveAccount(env, alias);
    if (!result.ok) return reply({ error: "account_unavailable" }, 404);
    if (operation === "push" && result.account.readonly) return reply({ error: "account_readonly" }, 403);
    const allowedRepositories = Array.isArray(result.account.git_repositories)
      ? result.account.git_repositories.map((item) => normalizeRepository(String(item))).filter((item): item is string => item !== null)
      : [];
    if (!allowedRepositories.includes(repository)) {
      console.info(JSON.stringify({ event: "git_credential_denied", account: alias, operation, repository, request_id: req.headers.get("CF-Ray") || "unknown", timestamp: new Date().toISOString(), reason: "repository_not_allowlisted" }));
      return reply({ error: "repository_not_allowlisted" }, 403);
    }
    console.info(JSON.stringify({ event: "git_credential_issued", account: alias, operation, repository, request_id: req.headers.get("CF-Ray") || "unknown", timestamp: new Date().toISOString() }));
    return reply({ account: alias, username: result.account.username || "x-access-token", credential: result.account.token });
  } catch { return reply({ error: "credential_provider_unavailable" }, 503); }
}
