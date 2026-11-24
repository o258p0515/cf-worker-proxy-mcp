import { createSign } from "node:crypto";

const env = process.env;
const errors = [];
const warnings = [];
const add = (name, reason, fix, example) => errors.push({ name, reason, fix, example });
const email = env.CF_API_EMAIL || "";
const apiKey = env.CF_API_KEY || "";
const domain = env.CF_DOMAIN || "";
const mcpDomain = (env.MCP_DOMAIN || "").trim();
const mcpToken = env.MCP_TOKEN || "";
const gitExecutorToken = env.GIT_EXECUTOR_TOKEN || "";

if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) add("CF_API_EMAIL", "Thiếu hoặc sai định dạng email.", "Nhập email Cloudflare dùng cho Global API Key.", "dev@example.com");
if (apiKey.length < 30 || /\s/.test(apiKey)) add("CF_API_KEY", "Global API Key thiếu hoặc không hợp lệ.", "Tạo Global API Key đủ quyền Zone Read, DNS Read/Edit và Workers KV Edit.", "<Cloudflare Global API Key>");
if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(domain)) add("CF_DOMAIN", "Phải là hostname thuần.", "Nhập domain đã active trong Cloudflare.", "example.com");
if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(mcpDomain)) add("MCP_DOMAIN", "Thiếu hoặc sai hostname MCP.", "Thêm secret MCP_DOMAIN dạng hostname thuần.", "github-mcp-proxy.example.com");
if (mcpDomain && domain && !(mcpDomain.toLowerCase() === domain.toLowerCase() || mcpDomain.toLowerCase().endsWith("." + domain.toLowerCase()))) warnings.push("MCP_DOMAIN must belong to the active Cloudflare zone selected by CF_DOMAIN.");
if (gitExecutorToken.length < 32) add("GIT_EXECUTOR_TOKEN", "Dedicated Git executor secret is required and must be at least 32 characters.", "Set the same random secret in GitHub Actions and deploy it to the Worker.", "<random-32-byte-secret>");
if (mcpToken.length < 24 || /\s/.test(mcpToken)) add("MCP_TOKEN", "Token bắt buộc, tối thiểu 24 ký tự và không có whitespace.", "Tạo token ngẫu nhiên dài ít nhất 32 bytes.", "mcp_live_<random-secret>");
if (!env.MCP_API_PASSPHRASE || env.MCP_API_PASSPHRASE.length < 24 || /\s/.test(env.MCP_API_PASSPHRASE)) add("MCP_API_PASSPHRASE", "API Explorer passphrase phải có ít nhất 24 ký tự, không whitespace.", "Tạo passphrase riêng, không dùng lại MCP_TOKEN.", "<random-passphrase-32-chars>");
if (!/^[A-Za-z0-9._-]{8,128}$/.test(env.MCP_OAUTH_CLIENT_ID || "")) add("MCP_OAUTH_CLIENT_ID", "OAuth Client ID bắt buộc cho API Explorer.", "Cấu hình client ID 8-128 ký tự.", "github-mcp-proxy-client");
if (!env.MCP_OAUTH_CLIENT_SECRET || env.MCP_OAUTH_CLIENT_SECRET.length < 24 || /\s/.test(env.MCP_OAUTH_CLIENT_SECRET)) add("MCP_OAUTH_CLIENT_SECRET", "OAuth Client Secret bắt buộc và tối thiểu 24 ký tự.", "Tạo client secret mới.", "<OAuth client secret>");

let mode = "";
let serviceAccount = null;
try {
  if (env.FIREBASE_SERVICE_ACCOUNT_JSON_B64?.trim()) {
    const encoded = env.FIREBASE_SERVICE_ACCOUNT_JSON_B64.replace(/\s/g, "").replace(/-/g, "+").replace(/_/g, "/");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error("Base64 có ký tự không hợp lệ");
    serviceAccount = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    mode = "service_account_b64";
  } else if (env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim()) {
    serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
    mode = "service_account_json";
  }
  if (serviceAccount && (serviceAccount.type !== "service_account" || !String(serviceAccount.client_email).includes("@") || !String(serviceAccount.private_key).includes("BEGIN PRIVATE KEY"))) throw new Error("JSON không phải Service Account đầy đủ");
} catch (error) {
  add(env.FIREBASE_SERVICE_ACCOUNT_JSON_B64?.trim() ? "FIREBASE_SERVICE_ACCOUNT_JSON_B64" : "FIREBASE_SERVICE_ACCOUNT_JSON", (error instanceof Error ? error.message : "Invalid Service Account JSON") + "; secret không được in ra log.", "Tạo lại Base64 một dòng từ Service Account JSON.", "base64 service-account.json");
}

function normalizeRtdbUrl(raw, removeAuth = false) {
  const url = new URL(raw);
  if (url.protocol !== "https:" || !/\.(firebaseio\.com|firebasedatabase\.app)$/.test(url.hostname)) throw new Error("RTDB URL must use HTTPS and a Firebase database hostname");
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (!url.pathname || url.pathname === "/") url.pathname = "/github_accounts.json";
  else if (url.pathname === "/github_accounts") url.pathname += ".json";
  else if (!url.pathname.endsWith(".json")) throw new Error("RTDB URL path must point to github_accounts.json");
  if (removeAuth) url.searchParams.delete("auth");
  return url.toString();
}

let rtdbUrl = serviceAccount ? (env.RTDB_URL?.trim() || env.RTDB_AUTH_URL?.trim() || "") : (env.RTDB_AUTH_URL?.trim() || "");
try {
  if (!rtdbUrl) throw new Error("No RTDB URL supplied");
  rtdbUrl = normalizeRtdbUrl(rtdbUrl, Boolean(serviceAccount));
  if (!serviceAccount && !new URL(rtdbUrl).searchParams.get("auth")) throw new Error("Fallback URL must include ?auth= when Service Account is not configured");
} catch (error) {
  add("RTDB_URL / RTDB_AUTH_URL", error instanceof Error ? error.message : "Invalid RTDB URL", "Use Firebase database URL; fallback must include ?auth=.", "https://project-default-rtdb.asia-southeast1.firebasedatabase.app/github_accounts.json");
}
if (!serviceAccount && !env.RTDB_AUTH_URL?.trim()) add("Firebase RTDB authentication", "Thiếu Service Account và RTDB_AUTH_URL fallback.", "Thêm FIREBASE_SERVICE_ACCOUNT_JSON_B64 + RTDB_URL hoặc RTDB_AUTH_URL có ?auth=.", "FIREBASE_SERVICE_ACCOUNT_JSON_B64 + RTDB_URL");

if (errors.length) {
  console.error("[PRE-FLIGHT CHECK FAILED] " + errors.length + " lỗi cấu hình:");
  errors.forEach((e, i) => console.error((i + 1) + ". " + e.name + "\n   " + e.reason + "\n   " + e.fix + "\n   " + e.example));
  process.exit(1);
}

const hasAccounts = value => !!value && typeof value === "object" && !Array.isArray(value) && Object.values(value).some(a => {
  if (!a || a.enabled === false) return false;
  const secrets = a.localmcpgo_secrets && typeof a.localmcpgo_secrets === "object" ? a.localmcpgo_secrets : {};
  const github = typeof a.token === "string" && !!a.token.trim();
  const azure = typeof secrets.AZURE_DEVOPS_PAT === "string" && !!secrets.AZURE_DEVOPS_PAT.trim()
    && typeof secrets.AZURE_DEVOPS_ORG_URL === "string" && !!secrets.AZURE_DEVOPS_ORG_URL.trim();
  return github || azure;
});
async function fetchRtdbAccounts(url, accessToken) {
  const primary = new URL(url);
  if (accessToken) primary.searchParams.set("access_token", accessToken);
  let response = await fetch(primary);
  if (!response.ok) throw new Error("RTDB live check failed (HTTP " + response.status + ")");
  let data = await response.json();
  let selectedPath = primary.pathname;
  if (!hasAccounts(data) && primary.pathname === "/github_accounts.json") {
    const envUrl = new URL(primary);
    envUrl.pathname = "/env/github_accounts.json";
    const envResponse = await fetch(envUrl);
    if (envResponse.ok) {
      const envData = await envResponse.json();
      if (hasAccounts(envData)) { data = envData; selectedPath = envUrl.pathname; }
    }
  }
  return { data, selectedPath };
}
async function cloudflare(path) {
  const response = await fetch("https://api.cloudflare.com/client/v4" + path, { headers: { "X-Auth-Email": email, "X-Auth-Key": apiKey } });
  const data = await response.json();
  if (!response.ok || !data.success) throw new Error("Cloudflare API validation failed (HTTP " + response.status + ")");
  return data.result;
}

try {
  if (!await cloudflare("/user")) throw new Error("Cloudflare credentials rejected");
  const zones = await cloudflare("/zones?per_page=50");
  const zone = zones.filter(item => item.status === "active" && (domain === item.name || domain.endsWith("." + item.name))).sort((a, b) => b.name.length - a.name.length)[0];
  if (!zone) throw new Error("No active Cloudflare zone matches CF_DOMAIN");
  const normalizedMcp = mcpDomain.toLowerCase();
  if (!(normalizedMcp === zone.name.toLowerCase() || normalizedMcp.endsWith("." + zone.name.toLowerCase()))) throw new Error("MCP_DOMAIN is outside the active Cloudflare zone");
  const dns = await cloudflare("/zones/" + zone.id + "/dns_records?name=" + encodeURIComponent(mcpDomain));
  if (!dns.some(record => record.proxied === true && ["A", "AAAA", "CNAME"].includes(record.type))) throw new Error("MCP_DOMAIN needs an existing proxied DNS record");

  let accessToken = null;
  if (serviceAccount) {
    const now = Math.floor(Date.now() / 1000);
    const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = encode({ alg: "RS256", typ: "JWT" }) + "." + encode({
      iss: serviceAccount.client_email,
      scope: "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email",
      aud: serviceAccount.token_uri || "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600
    });
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    const assertion = unsigned + "." + signer.sign(String(serviceAccount.private_key).replace(/\\n/g, "\n"), "base64url");
    const tokenResponse = await fetch(serviceAccount.token_uri || "https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion })
    });
    if (!tokenResponse.ok) throw new Error("Firebase Service Account OAuth validation failed (HTTP " + tokenResponse.status + ")");
    accessToken = (await tokenResponse.json()).access_token;
  }
  const { data, selectedPath } = await fetchRtdbAccounts(rtdbUrl, accessToken);
  if (!hasAccounts(data)) throw new Error("RTDB " + selectedPath + " has no enabled GitHub account records");
  const enabledAccounts = Object.values(data).filter(account => {
    if (!account || account.enabled === false) return false;
    const secrets = account.localmcpgo_secrets && typeof account.localmcpgo_secrets === "object" ? account.localmcpgo_secrets : {};
    return (typeof account.token === "string" && !!account.token.trim())
      || (typeof secrets.AZURE_DEVOPS_PAT === "string" && !!secrets.AZURE_DEVOPS_PAT.trim()
        && typeof secrets.AZURE_DEVOPS_ORG_URL === "string" && !!secrets.AZURE_DEVOPS_ORG_URL.trim());
  }).length;
  console.log("[PRE-FLIGHT CHECK PASSED] Cloudflare hostname and RTDB verified; mode=" + (mode || "legacy_auth_fallback") + "; enabled supported accounts=" + enabledAccounts + ". Secrets were not printed.");
  warnings.forEach(warning => console.warn("WARNING: " + warning));
} catch (error) {
  console.error("[PRE-FLIGHT CHECK FAILED] " + (error instanceof Error ? error.message : "Live check failed") + "; credentials and RTDB values were redacted.");
  process.exit(1);
}
