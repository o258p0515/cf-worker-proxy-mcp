1	import type { Env, RtdbAccount } from "../types";
    2	import { decryptAesGcm, encryptAesGcm } from "../utils/crypto";
    3	import { googleAccessToken, resolveServiceAccountFromEnv } from "./google-jwt";
    4	
    5	let memory: { accounts: Record<string, RtdbAccount>; expires: number } | null = null;
    6	
    7	function normalizeDbUrl(raw: string, removeAuth = false): string {
    8	  const url = new URL(raw);
    9	  if (url.protocol !== "https:" || !(/\.(firebaseio\.com|firebasedatabase\.app)$/.test(url.hostname))) {
   10	    throw new Error("RTDB URL must use HTTPS and a Firebase database hostname");
   11	  }
   12	  url.pathname = url.pathname.replace(/\/+$/, "");
   13	  if (!url.pathname || url.pathname === "/") url.pathname = "/github_accounts.json";
   14	  else if (url.pathname === "/github_accounts") url.pathname += ".json";
   15	  else if (!url.pathname.endsWith(".json")) throw new Error("RTDB URL path must point to github_accounts.json");
   16	  if (removeAuth) url.searchParams.delete("auth");
   17	  return url.toString();
   18	}
   19	
   20	function hasEnabledAccounts(raw: unknown): boolean {
   21	  return !!raw && typeof raw === "object" && !Array.isArray(raw)
   22	    && Object.values(raw).some(value => {
   23	      const account = value as Partial<RtdbAccount> | null;
   24	      return !!account && typeof account.token === "string" && !!account.token.trim() && account.enabled !== false;
   25	    });
   26	}
   27	
   28	function normalize(raw: unknown): Record<string, RtdbAccount> {
   29	  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("RTDB github_accounts node must be a JSON object");
   30	  const out: Record<string, RtdbAccount> = {};
   31	  for (const [alias, value] of Object.entries(raw)) {
   32	    const account = value as Partial<RtdbAccount>;
   33	    if (!account || typeof account.token !== "string" || !account.token.trim()) continue;
   34	    out[alias] = {
   35	      username: String(account.username || ""),
   36	      token: account.token,
   37	      description: String(account.description || ""),
   38	      orgs: Array.isArray(account.orgs) ? account.orgs.map(String) : [],
   39	      enabled: account.enabled !== false,
   40	      readonly: account.readonly === true,
   41	      is_catalog_source: account.is_catalog_source === true
   42	    };
   43	  }
   44	  return out;
   45	}
   46	
   47	export async function getAccounts(env: Env, options: { forceRefresh?: boolean } = {}): Promise<Record<string, RtdbAccount>> {
   48	  const ttl = Math.max(30, Number(env.RTDB_CACHE_TTL_SECONDS) || 300);
   49	  if (!options.forceRefresh && memory && memory.expires > Date.now()) return memory.accounts;
   50	  if (!options.forceRefresh) {
   51	    const cached = await env.CACHE_KV.get("rtdb:accounts:v1");
   52	    if (cached) {
   53	      try {
   54	        const accounts = JSON.parse(await decryptAesGcm(cached, env.MCP_TOKEN));
   55	        memory = { accounts, expires: Date.now() + ttl * 1000 };
   56	        return accounts;
   57	      } catch {
   58	        // A changed MCP_TOKEN makes old encrypted cache entries unreadable; fetch fresh data.
   59	      }
   60	    }
   61	  }
   62	
   63	  const serviceAccount = resolveServiceAccountFromEnv(env);
   64	  const headers = new Headers();
   65	  let url: string;
   66	  if (serviceAccount) {
   67	    const rawUrl = env.RTDB_URL?.trim() || env.RTDB_AUTH_URL?.trim() || "";
   68	    if (!rawUrl) throw new Error("RTDB_URL or RTDB_AUTH_URL is required with a Firebase Service Account");
   69	    url = normalizeDbUrl(rawUrl, true);
   70	    headers.set("Authorization", "Bearer " + await googleAccessToken(env));
   71	  } else {
   72	    const rawUrl = env.RTDB_AUTH_URL?.trim() || "";
   73	    if (!rawUrl) throw new Error("RTDB is not configured: provide Firebase Service Account + RTDB_URL or RTDB_AUTH_URL");
   74	    url = normalizeDbUrl(rawUrl);
   75	    if (!new URL(url).searchParams.get("auth")) throw new Error("RTDB_AUTH_URL must include ?auth= when Service Account credentials are not configured");
   76	  }
   77	
   78	  let response = await fetch(url, { headers });
   79	  if (!response.ok) throw new Error("Firebase RTDB request failed (HTTP " + response.status + ")");
   80	  let raw: unknown = await response.json();
   81	  if (!hasEnabledAccounts(raw) && new URL(url).pathname === "/github_accounts.json") {
   82	    const envUrl = new URL(url);
   83	    envUrl.pathname = "/env/github_accounts.json";
   84	    const envResponse = await fetch(envUrl, { headers });
   85	    if (envResponse.ok) {
   86	      const envRaw: unknown = await envResponse.json();
   87	      if (hasEnabledAccounts(envRaw)) {
   88	        raw = envRaw;
   89	        url = envUrl.toString();
   90	      }
   91	    }
   92	  }
   93	  const accounts = normalize(raw);
   94	  if (!Object.values(accounts).some(account => account.enabled)) throw new Error("Firebase RTDB contains no enabled GitHub account with a token at /github_accounts or /env/github_accounts");
   95	
   96	  memory = { accounts, expires: Date.now() + ttl * 1000 };
   97	  await env.CACHE_KV.put("rtdb:accounts:v1", await encryptAesGcm(JSON.stringify(accounts), env.MCP_TOKEN), { expirationTtl: ttl });
   98	  return accounts;
   99	}
  100	
  101	export async function listPublicAccounts(env: Env) {
  102	  const accounts = await getAccounts(env);
  103	  return Object.entries(accounts)
  104	    .filter(([, account]) => account.enabled)
  105	    .map(([alias, account]) => ({
  106	      alias, username: account.username, description: account.description,
  107	      orgs: account.orgs, readonly: account.readonly
  108	    }));
  109	}
  110	
  111	export async function resolveAccount(env: Env, alias: string) {
  112	  const accounts = await getAccounts(env);
  113	  const availableAccounts = Object.entries(accounts)
  114	    .filter(([, account]) => account.enabled)
  115	    .map(([key, account]) => ({
  116	      alias: key, username: account.username, description: account.description,
  117	      orgs: account.orgs, readonly: account.readonly
  118	    }));
  119	  const account = accounts[alias];
  120	  return account?.enabled
  121	    ? { ok: true as const, account }
  122	    : { ok: false as const, reason: "invalid_or_missing", availableAccounts };
  123	}
  124	
  125	export async function clearAccountCaches(env: Env) {
  126	  memory = null;
  127	  await Promise.all(["rtdb:accounts:v1", "mcp:tools_catalog:v1", "mcp:tools_catalog:v2", "mcp:tools_catalog:v3"].map(key => env.CACHE_KV.delete(key)));
  128	}