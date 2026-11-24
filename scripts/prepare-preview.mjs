import { appendFile, writeFile } from "node:fs/promises";

const email = process.env.CF_API_EMAIL;
const key = process.env.CF_API_KEY;
const domain = process.env.CF_DOMAIN;
const workerName = "github-mcp-proxy-issue68-preview";
if (!email || !key || !domain) throw new Error("CF_API_EMAIL, CF_API_KEY and CF_DOMAIN are required for preview deployment");

async function cf(path, init = {}) {
  const response = await fetch("https://api.cloudflare.com/client/v4" + path, {
    ...init,
    headers: { "X-Auth-Email": email, "X-Auth-Key": key, "Content-Type": "application/json", ...(init.headers || {}) }
  });
  const data = await response.json();
  if (!response.ok || !data.success) throw new Error("Cloudflare API failed for " + path + " (HTTP " + response.status + "): " + (data.errors || []).map(item => item.message).join("; "));
  return data.result;
}

const zones = await cf("/zones?per_page=50");
const zone = zones.filter(item => item.status === "active" && (domain === item.name || domain.endsWith("." + item.name))).sort((a, b) => b.name.length - a.name.length)[0];
if (!zone) throw new Error("No active Cloudflare zone found for CF_DOMAIN");
const subdomain = (await cf("/accounts/" + zone.account.id + "/workers/subdomain"))?.subdomain;
if (!subdomain) throw new Error("Cloudflare workers.dev subdomain is not configured; preview deploy will not change account-wide subdomain settings.");
const namespaces = await cf("/accounts/" + zone.account.id + "/storage/kv/namespaces?per_page=100");
async function ensureNamespace(title) {
  const existing = namespaces.find(item => item.title === title);
  if (existing) return existing.id;
  return (await cf("/accounts/" + zone.account.id + "/storage/kv/namespaces", { method: "POST", body: JSON.stringify({ title }) })).id;
}
const oauth = await ensureNamespace(workerName + "-oauth-kv");
const cache = await ensureNamespace(workerName + "-cache-kv");
const publicOrigin = "https://" + workerName + "." + subdomain + ".workers.dev";
const config = {
  name: workerName,
  main: "src/index.ts",
  compatibility_date: "2026-01-01",
  compatibility_flags: ["nodejs_compat"],
  account_id: zone.account.id,
  workers_dev: true,
  vars: {
    PUBLIC_ORIGIN: publicOrigin,
    GITHUB_MCP_UPSTREAM_URL: "https://api.githubcopilot.com/mcp/",
    GITHUB_MCP_TOOLSETS: "all",
    RTDB_CACHE_TTL_SECONDS: "3600",
    LOCALMCP_HUB_ORIGIN: "https://hub.o258p0515.dpdns.org"
  },
  services: [{ binding: "LOCALMCP_HUB", service: "localmcp-hub" }],
  kv_namespaces: [{ binding: "OAUTH_KV", id: oauth }, { binding: "CACHE_KV", id: cache }],
  durable_objects: { bindings: [{ name: "SSE_SESSIONS", class_name: "SseSessionDO" }] },
  migrations: [{ tag: "v1", new_sqlite_classes: ["SseSessionDO"] }]
};
await writeFile(new URL("../wrangler.preview.jsonc", import.meta.url), JSON.stringify(config, null, 2) + "\n");
if (process.env.GITHUB_ENV) {
  await appendFile(process.env.GITHUB_ENV, "CLOUDFLARE_ACCOUNT_ID=" + zone.account.id + "\nCLOUDFLARE_API_KEY=" + key + "\nCLOUDFLARE_EMAIL=" + email + "\nPREVIEW_DOMAIN=" + publicOrigin + "\n");
}
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, "## Isolated branch preview\n\n" + publicOrigin + "/mcp\n\nThis Worker uses separate KV namespaces and a separate Durable Object namespace; it has no production DNS route.\n");
}
console.log("Prepared isolated preview Worker " + workerName + " at " + publicOrigin + "; no production routes or KV namespaces were changed.");
