import type { Env } from "../types";
import { resolveAccount } from "../rtdb/account-store";

const OPERATIONS = new Set(["clone", "fetch", "pull", "push"]);
const GITHUB_REPOSITORY = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i;
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
function audit(fields: Record<string, string | number | undefined>) {
  // Never include credential/token values or request bodies in audit output.
  console.info(JSON.stringify({ event: "git_credential_audit", timestamp: new Date().toISOString(), ...fields }));
}
function auditIdentity(input: Record<string, unknown>) {
  const actor = typeof input.actor === "string" && /^[A-Za-z0-9-]{1,39}$/.test(input.actor) ? input.actor : "unknown";
  const workflowRunId = typeof input.workflow_run_id === "string" && /^\d{1,24}$/.test(input.workflow_run_id) ? input.workflow_run_id : "unknown";
  return { actor, workflow_run_id: workflowRunId };
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
  const repository = typeof input.repository === "string" ? input.repository.trim() : "";
  const identity = auditIdentity(input);
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(alias)) return reply({ error: "invalid_account" }, 400);
  if (!OPERATIONS.has(operation)) return reply({ error: "invalid_operation" }, 400);
  const match = GITHUB_REPOSITORY.exec(repository);
  if (!match) {
    audit({ account: alias, operation, repository: "invalid", ...identity, request_id: req.headers.get("cf-ray") || "unknown", decision: "denied", reason: "invalid_repository" });
    return reply({ error: "invalid_repository" }, 400);
  }
  const repositoryKey = (match[1] + "/" + match[2]).toLowerCase();
  try {
    const result = await resolveAccount(env, alias);
    if (!result.ok) {
      audit({ account: alias, operation, repository: repositoryKey, ...identity, request_id: req.headers.get("cf-ray") || "unknown", decision: "denied", reason: "account_unavailable" });
      return reply({ error: "account_unavailable" }, 404);
    }
    const allowedRepositories = (result.account.git_repositories ?? []).map((value) => value.trim().toLowerCase());
    if (!allowedRepositories.includes(repositoryKey)) {
      audit({ account: alias, username: result.account.username, operation, repository: repositoryKey, ...identity, request_id: req.headers.get("cf-ray") || "unknown", decision: "denied", reason: "repository_not_allowlisted" });
      return reply({ error: "repository_not_allowlisted" }, 403);
    }
    if (operation === "push" && result.account.readonly) {
      audit({ account: alias, username: result.account.username, operation, repository: repositoryKey, ...identity, request_id: req.headers.get("cf-ray") || "unknown", decision: "denied", reason: "account_readonly" });
      return reply({ error: "account_readonly" }, 403);
    }
    audit({ account: alias, username: result.account.username, operation, repository: repositoryKey, ...identity, request_id: req.headers.get("cf-ray") || "unknown", decision: "issued" });
    return reply({ account: alias, username: result.account.username || "x-access-token", credential: result.account.token });
  } catch {
    audit({ account: alias, operation, repository: repositoryKey, ...identity, request_id: req.headers.get("cf-ray") || "unknown", decision: "error", reason: "credential_provider_unavailable" });
    return reply({ error: "credential_provider_unavailable" }, 503);
  }
}
