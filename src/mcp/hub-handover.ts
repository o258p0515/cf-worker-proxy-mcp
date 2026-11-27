import type { Env, RtdbAccount } from "../types";
import { getAccounts } from "../rtdb/account-store";
import { runLocalMcpHubControlTool } from "./localmcp-hub-control";

const HEADERS = {
  "Cache-Control": "no-store, private, max-age=0",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff"
};
const PERSISTENT_PROVIDERS = new Set(["instabox", "upstashbox"]);
const RUNNER_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

function reply(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status, headers: HEADERS });
}

async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b))
  ]);
  const x = new Uint8Array(left);
  const y = new Uint8Array(right);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0 && a.length > 0 && b.length > 0;
}

function tagValue(tags: string[], prefix: string): string {
  const match = tags.find((tag) => tag.startsWith(prefix));
  return match ? match.slice(prefix.length) : "";
}

function nextRunnerName(predecessorId: string, tags: string[], generation: number): string {
  const fromTag = tagValue(tags, "name:");
  const baseRaw = fromTag || predecessorId.replace(/-\d{8,}$/, "");
  const stripped = baseRaw.replace(/-g\d+$/i, "").replace(/[^A-Za-z0-9_.-]/g, "-").replace(/^-+|-+$/g, "") || "gha";
  const suffix = `-g${generation}`;
  const maxBase = Math.max(1, 64 - suffix.length);
  return stripped.slice(0, maxBase) + suffix;
}

function sanitizeInheritedTags(tags: string[]): string {
  const filtered = tags
    .map((t) => String(t).trim())
    .filter((t) =>
      Boolean(t) &&
      !t.startsWith("provider:") &&
      !t.startsWith("os:") &&
      !t.startsWith("account:") &&
      !t.startsWith("run:") &&
      !t.startsWith("gen:") &&
      !t.startsWith("name:") &&
      /^[A-Za-z0-9_.:-]+$/.test(t)
    );
  return [...new Set(filtered)].join(",");
}

function parseRepo(repo: string): { owner?: string; repo?: string } {
  const parts = repo.trim().split("/").filter(Boolean);
  if (parts.length === 2 && /^[A-Za-z0-9_.-]{1,100}$/.test(parts[0]!) && /^[A-Za-z0-9_.-]{1,100}$/.test(parts[1]!)) {
    return { owner: parts[0], repo: parts[1] };
  }
  return {};
}

function accountHasProvider(account: RtdbAccount, provider: string): boolean {
  const secrets = account.localmcpgo_secrets || {};
  if (provider === "github") return Boolean(account.token);
  if (provider === "azure") return Boolean(secrets.AZURE_DEVOPS_PAT && secrets.AZURE_DEVOPS_ORG_URL);
  if (provider === "instabox") return Boolean(secrets.INSTABOX_API_KEY);
  if (provider === "upstashbox") return Boolean(secrets.UPSTASH_BOX_API_KEY);
  return false;
}

function pickAccountForProvider(
  allAccounts: Record<string, RtdbAccount>,
  preferredAlias: string,
  provider: string
): { alias: string; account: RtdbAccount } | null {
  const preferred = preferredAlias ? allAccounts[preferredAlias] : undefined;
  if (preferred && preferred.enabled !== false && !preferred.readonly && accountHasProvider(preferred, provider)) {
    return { alias: preferredAlias, account: preferred };
  }
  for (const [alias, account] of Object.entries(allAccounts)) {
    if (account && account.enabled !== false && !account.readonly && accountHasProvider(account, provider)) {
      return { alias, account };
    }
  }
  return null;
}

export async function handleHubHandover(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
  const expectedToken = String(env.HUB_CONTROL_TOKEN || env.MCP_TOKEN || "").trim();
  if (expectedToken.length < 16) return reply({ error: "handover_auth_not_configured" }, 503);
  const bearer = req.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
  if (!await constantTimeEqual(bearer, expectedToken)) return reply({ error: "unauthorized" }, 401);

  let input: Record<string, unknown>;
  try {
    const raw = await req.text();
    if (raw.length > 16384) return reply({ error: "request_too_large" }, 413);
    input = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return reply({ error: "invalid_json" }, 400);
  }

  const predecessorId = typeof input.predecessor_id === "string" ? input.predecessor_id.trim() : "";
  if (!RUNNER_ID_RE.test(predecessorId)) return reply({ error: "invalid_predecessor_id" }, 400);

  const generation = input.generation === undefined ? 2 : Number(input.generation);
  if (!Number.isInteger(generation) || generation < 2 || generation > 20) {
    return reply({ error: "invalid_generation" }, 400);
  }

  const rawProvider = typeof input.provider === "string" ? input.provider.trim().toLowerCase() : "github";
  if (PERSISTENT_PROVIDERS.has(rawProvider)) {
    return reply({
      skipped: true,
      reason: "persistent_provider_uses_resume",
      provider: rawProvider,
      predecessor_id: predecessorId
    });
  }

  const os = typeof input.os === "string" && input.os.toLowerCase().includes("win") ? "windows" : "linux";
  const accountAlias = typeof input.account === "string" ? input.account.trim() : "";
  const repoStr = typeof input.repo === "string" ? input.repo.trim() : "";
  const tags = Array.isArray(input.tags) ? input.tags.map((item) => String(item)) : [];
  const inheritedTags = sanitizeInheritedTags(tags) || `${os},go,gha,agent`;
  const runnerName = nextRunnerName(predecessorId, tags, generation);

  const allAccounts = await getAccounts(env);

  // Azure DevOps MS-hosted Free Tier allows only 1 concurrent job per org, so
  // Make-Before-Break cannot overlap two Azure jobs. Fall back to GitHub Actions
  // (same OS) or a persistent Linux sandbox when GitHub is unavailable.
  let targetProvider = rawProvider === "azure" ? "github" : (rawProvider || "github");
  let fallbackFrom: string | undefined = rawProvider === "azure" ? "azure" : undefined;

  let chosen = pickAccountForProvider(allAccounts, accountAlias, targetProvider);
  if (!chosen && fallbackFrom === "azure" && os === "linux") {
    for (const alt of ["upstashbox", "instabox"]) {
      const candidate = pickAccountForProvider(allAccounts, accountAlias, alt);
      if (candidate) {
        targetProvider = alt;
        chosen = candidate;
        break;
      }
    }
  }
  if (!chosen) {
    return reply({
      error: `no writable account configured for handover provider '${targetProvider}'`,
      provider: targetProvider,
      ...(fallbackFrom ? { fallback_from: fallbackFrom } : {})
    }, 503);
  }

  const durationSeconds = typeof input.duration_seconds === "number" && Number.isInteger(input.duration_seconds)
    ? input.duration_seconds
    : undefined;
  const handoverAfter = typeof input.handover_after === "number" && Number.isInteger(input.handover_after)
    ? input.handover_after
    : undefined;
  const idleTimeout = typeof input.idle_timeout === "number" && Number.isInteger(input.idle_timeout)
    ? input.idle_timeout
    : undefined;

  const repoTarget = parseRepo(repoStr);
  const startArgs: Record<string, unknown> = {
    provider: targetProvider,
    os,
    runner_name: runnerName,
    runner_tags: inheritedTags,
    predecessor_id: predecessorId,
    generation,
    ...(durationSeconds !== undefined ? { duration_seconds: durationSeconds } : {}),
    ...(handoverAfter !== undefined ? { handover_after: handoverAfter } : {}),
    ...(idleTimeout !== undefined ? { idle_timeout: idleTimeout } : {}),
    ...repoTarget
  };

  try {
    const result = await runLocalMcpHubControlTool(
      "localmcp_hub_start",
      startArgs,
      chosen.account,
      env.MCP_TOKEN,
      chosen.alias,
      env,
      undefined,
      allAccounts
    );
    return reply({
      dispatched: true,
      predecessor_id: predecessorId,
      generation,
      target_provider: targetProvider,
      target_account: chosen.alias,
      ...(fallbackFrom ? { fallback_from: fallbackFrom } : {}),
      ...result
    });
  } catch (error) {
    return reply({
      error: error instanceof Error ? error.message : String(error),
      predecessor_id: predecessorId,
      target_provider: targetProvider
    }, 502);
  }
}
