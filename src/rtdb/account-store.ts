import type { AuthContext, CachedSandboxRunner, Env, RtdbAccount } from "../types";
import { getGoogleAccessToken } from "./google-jwt";

const CACHE_KEY = "rtdb:accounts:v1";
const TTL_SECONDS = 300;
let memory: { expiresAt: number; accounts: Record<string, RtdbAccount> } | null = null;
let activeRtdbUrl = "";

export type RtdbConfig = { url: string; mode: "firebase_service_account" | "legacy_auth_fallback" };

function normalizedOrgs(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map(item => item.trim());
}

function normalizedSecrets(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && value.trim()) out[key.trim()] = value.trim();
  }
  return out;
}

function normalizedCachedRunner(raw: unknown): CachedSandboxRunner | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const item = raw as Record<string, unknown>;
  const id = typeof item.id === "string" ? item.id.trim() : "";
  const runnerId = typeof item.runner_id === "string" ? item.runner_id.trim() : "";
  if (!id || !runnerId) return undefined;
  return {
    id,
    runner_id: runnerId,
    ...(typeof item.name === "string" && item.name.trim() ? { name: item.name.trim() } : {}),
    ...(typeof item.template === "string" && item.template.trim() ? { template: item.template.trim() } : {}),
    ...(typeof item.runtime === "string" && item.runtime.trim() ? { runtime: item.runtime.trim() } : {}),
    ...(typeof item.size === "string" && item.size.trim() ? { size: item.size.trim() } : {}),
    ...(typeof item.updated_at === "string" && item.updated_at.trim() ? { updated_at: item.updated_at.trim() } : {})
  };
}

function normalizedCachedRunners(raw: unknown): RtdbAccount["localmcpgo_runners"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const item = raw as Record<string, unknown>;
  const instabox = normalizedCachedRunner(item.instabox);
  const upstashbox = normalizedCachedRunner(item.upstashbox);
  if (!instabox && !upstashbox) return undefined;
  return {
    ...(instabox ? { instabox } : {}),
    ...(upstashbox ? { upstashbox } : {})
  };
}

function hasEnabledAccounts(raw: unknown): boolean {
  return !!raw && typeof raw === "object" && !Array.isArray(raw) && Object.values(raw as Record<string, any>)
    .some(account => {
      if (!account || typeof account !== "object" || account.enabled === false) return false;
      const secrets = account.localmcpgo_secrets && typeof account.localmcpgo_secrets === "object" ? account.localmcpgo_secrets : {};
      return (typeof account.token === "string" && !!account.token.trim())
        || (typeof secrets.AZURE_DEVOPS_PAT === "string" && !!secrets.AZURE_DEVOPS_PAT.trim()
          && typeof secrets.AZURE_DEVOPS_ORG_URL === "string" && !!secrets.AZURE_DEVOPS_ORG_URL.trim())
        || (typeof secrets.INSTABOX_API_KEY === "string" && !!secrets.INSTABOX_API_KEY.trim())
        || (typeof secrets.UPSTASH_BOX_API_KEY === "string" && !!secrets.UPSTASH_BOX_API_KEY.trim());
    });
}

function normalize(raw: unknown): Record<string, RtdbAccount> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, RtdbAccount> = {};
  for (const [alias, value] of Object.entries(raw as Record<string, any>)) {
    const account = value && typeof value === "object" && value.accounts && typeof value.accounts === "object" ? value.accounts : value;
    const rawSecrets = account?.localmcpgo_secrets && typeof account.localmcpgo_secrets === "object"
      ? (account.localmcpgo_secrets as Record<string, string>)
      : {};
    const githubToken = typeof account?.token === "string" ? account.token.trim() : "";
    const azureConfigured = !!rawSecrets.AZURE_DEVOPS_PAT?.trim() && !!rawSecrets.AZURE_DEVOPS_ORG_URL?.trim();
    const instaboxConfigured = !!rawSecrets.INSTABOX_API_KEY?.trim();
    const upstashConfigured = !!rawSecrets.UPSTASH_BOX_API_KEY?.trim();
    if (!account || (!githubToken && !azureConfigured && !instaboxConfigured && !upstashConfigured)) continue;
    out[alias] = {
      username: String(account.username || ""),
      token: githubToken,
      description: String(account.description || ""),
      orgs: normalizedOrgs(account.orgs),
      enabled: account.enabled !== false,
      readonly: Boolean(account.readonly),
      localmcpgo_secrets: normalizedSecrets(account.localmcpgo_secrets),
      localmcpgo_runners: normalizedCachedRunners(account.localmcpgo_runners),
      allowed_repositories: normalizedOrgs(account.allowed_repositories),
      git_credentials: account.git_credentials && typeof account.git_credentials === "object" && !Array.isArray(account.git_credentials)
        ? {
            enabled: account.git_credentials.enabled !== false,
            allowed_repositories: normalizedOrgs(account.git_credentials.allowed_repositories)
          }
        : undefined
    };
  }
  return out;
}

export function resolveRtdbConfig(env: Env): RtdbConfig | null {
  const url = env.RTDB_AUTH_URL?.trim();
  if (!url) return null;
  if (env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim()) return { url, mode: "firebase_service_account" };
  return new URL(url).searchParams.get("auth") ? { url, mode: "legacy_auth_fallback" } : null;
}

export async function authorizedRtdbUrl(env: Env, config: RtdbConfig, baseUrl = config.url) {
  const url = new URL(baseUrl);
  if (config.mode === "firebase_service_account") {
    url.searchParams.delete("auth");
    url.searchParams.set("access_token", await getGoogleAccessToken(env.FIREBASE_SERVICE_ACCOUNT_JSON!));
  }
  return url;
}

function accountsRootUrl(configUrl: string) {
  const url = new URL(configUrl);
  url.pathname = url.pathname.replace(/\/github_accounts\/?\.json$/, ".json");
  return url.toString();
}

export async function fetchRtdbAccounts(env: Env) {
  const config = resolveRtdbConfig(env);
  if (!config) return null;
  const primary = await authorizedRtdbUrl(env, config);
  const res = await fetch(primary.toString());
  if (!res.ok) throw new Error("RTDB fetch failed: " + res.status);
  const raw = await res.json();
  if (hasEnabledAccounts(raw)) {
    activeRtdbUrl = config.url;
    return normalize(raw);
  }
  const fallbackBase = accountsRootUrl(config.url);
  if (fallbackBase !== config.url) {
    const fallbackRes = await fetch((await authorizedRtdbUrl(env, config, fallbackBase)).toString());
    if (fallbackRes.ok) {
      const fallbackRaw = await fallbackRes.json();
      if (hasEnabledAccounts(fallbackRaw)) {
        activeRtdbUrl = fallbackBase;
        return normalize(fallbackRaw);
      }
    }
  }
  activeRtdbUrl = config.url;
  return normalize(raw);
}

export async function getAccounts(env: Env): Promise<Record<string, RtdbAccount>> {
  if (memory && memory.expiresAt > Date.now()) return memory.accounts;
  const cached = await env.CACHE_KV.get(CACHE_KEY);
  if (cached) {
    const parsed = normalize(JSON.parse(cached));
    if (Object.values(parsed).some(a => a.enabled)) {
      memory = { expiresAt: Date.now() + 60_000, accounts: parsed };
      return parsed;
    }
  }
  let accounts = await fetchRtdbAccounts(env);
  if (!accounts && env.GITHUB_ACCOUNTS) accounts = normalize(JSON.parse(env.GITHUB_ACCOUNTS));
  accounts = accounts || {};
  memory = { expiresAt: Date.now() + 60_000, accounts };
  if (Object.values(accounts).some(a => a.enabled)) await env.CACHE_KV.put(CACHE_KEY, JSON.stringify(accounts), { expirationTtl: TTL_SECONDS });
  return accounts;
}

export async function listPublicAccounts(env: Env) {
  const accounts = await getAccounts(env);
  return Object.entries(accounts)
    .filter(([, a]) => a.enabled)
    .map(([alias, account]) => ({
      alias, username: account.username, description: account.description,
      orgs: account.orgs, readonly: account.readonly,
      providers: [
        ...(account.token ? ["github"] : []),
        ...(account.localmcpgo_secrets?.AZURE_DEVOPS_PAT && account.localmcpgo_secrets?.AZURE_DEVOPS_ORG_URL ? ["azure"] : []),
        ...(account.localmcpgo_secrets?.INSTABOX_API_KEY ? ["instabox"] : []),
        ...(account.localmcpgo_secrets?.UPSTASH_BOX_API_KEY ? ["upstashbox"] : [])
      ]
    }));
}

export async function resolveAccount(env: Env, alias: string) {
  const accounts = await getAccounts(env);
  const availableAccounts = Object.entries(accounts)
    .filter(([, a]) => a.enabled)
    .map(([itemAlias, account]) => ({
      alias: itemAlias, username: account.username, description: account.description,
      orgs: account.orgs, readonly: account.readonly,
      providers: [
        ...(account.token ? ["github"] : []),
        ...(account.localmcpgo_secrets?.AZURE_DEVOPS_PAT && account.localmcpgo_secrets?.AZURE_DEVOPS_ORG_URL ? ["azure"] : []),
        ...(account.localmcpgo_secrets?.INSTABOX_API_KEY ? ["instabox"] : []),
        ...(account.localmcpgo_secrets?.UPSTASH_BOX_API_KEY ? ["upstashbox"] : [])
      ]
    }));
  const account = accounts[alias];
  if (!account || !account.enabled) return { ok: false as const, availableAccounts };
  return { ok: true as const, account, availableAccounts };
}

export async function getSelectedAlias(env: Env, ctx: AuthContext): Promise<string | null> {
  if (ctx.pinnedAccount) return ctx.pinnedAccount;
  const key = "session:account:" + (ctx.sessionId || ctx.subject);
  return env.CACHE_KV.get(key);
}

export async function saveSelectedAlias(env: Env, ctx: AuthContext, alias: string) {
  const key = "session:account:" + (ctx.sessionId || ctx.subject);
  await env.CACHE_KV.put(key, alias, { expirationTtl: 86400 });
}

export function accountWriteUrl(configUrl: string, alias: string, childPath = "localmcpgo_secrets") {
  const url = new URL(configUrl);
  url.pathname = url.pathname.replace(/\/?\.json$/, `/${encodeURIComponent(alias)}/${childPath}.json`);
  return url.toString();
}

export async function writeAccountSecrets(env: Env, alias: string, secrets: Record<string, string>) {
  const config = resolveRtdbConfig(env);
  if (!config) throw new Error("RTDB is not configured on this Worker.");
  if (!activeRtdbUrl) await getAccounts(env);
  const baseUrl = activeRtdbUrl || config.url;
  const target = await authorizedRtdbUrl(env, config, accountWriteUrl(baseUrl, alias, "localmcpgo_secrets"));
  const res = await fetch(target.toString(), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(secrets)
  });
  if (!res.ok) throw new Error("RTDB secret write failed: " + res.status);
  await clearAccountCaches(env);
}

export async function writeCachedSandboxRunner(
  env: Env,
  alias: string,
  provider: "instabox" | "upstashbox",
  runner: CachedSandboxRunner | null
) {
  const config = resolveRtdbConfig(env);
  if (!config || !alias) return;
  if (!activeRtdbUrl) await getAccounts(env).catch(() => null);
  const baseUrl = activeRtdbUrl || config.url;
  const target = await authorizedRtdbUrl(env, config, accountWriteUrl(baseUrl, alias, `localmcpgo_runners/${provider}`));
  const res = await fetch(target.toString(), {
    method: runner ? "PUT" : "DELETE",
    ...(runner ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(runner) } : {})
  });
  if (!res.ok) throw new Error("RTDB cached runner write failed: " + res.status);
  await clearAccountCaches(env);
}

export async function clearAccountCaches(env: Env) {
  memory = null;
  activeRtdbUrl = "";
  await Promise.all(["rtdb:accounts:v1", "mcp:tools_catalog:v1", "mcp:tools_catalog:v2", "mcp:tools_catalog:v3"].map(key => env.CACHE_KV.delete(key)));
}
