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

if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) add("CF_API_EMAIL", "Thiếu hoặc sai định dạng email.", "Nhập email Cloudflare dùng cho Global API Key.", "dev@example.com");
if (apiKey.length < 30 || /\\s/.test(apiKey)) add("CF_API_KEY", "Global API Key thiếu hoặc không hợp lệ.", "Tạo Global API Key đủ quyền Zone Read, DNS Read/Edit và Workers KV Edit.", "<Cloudflare Global API Key>");
if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(domain)) add("CF_DOMAIN", "Phải là hostname thuần.", "Nhập domain đã active trong Cloudflare.", "example.com");
if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(mcpDomain)) add("MCP_DOMAIN", "Thiếu hoặc sai hostname MCP.", "Thêm secret MCP_DOMAIN dạng hostname thuần.", "github-mcp-proxy.example.com");
if (mcpDomain && domain && !(mcpDomain.toLowerCase() === domain.toLowerCase() || mcpDomain.toLowerCase().endsWith("." + domain.toLowerCase()))) warnings.push("MCP_DOMAIN must belong to the active Cloudflare zone selected by CF_DOMAIN.");
if (mcpToken.length < 24 || /\\s/.test(mcpToken)) add("MCP_TOKEN", "Token bắt buộc, tối thiểu 24 ký tự và không có whitespace.", "Tạo token ngẫu nhiên dài ít nhất 32 bytes.", "mcp_live_<random-secret>");
if (!env.MCP_API_PASSPHRASE || env.MCP_API_PASSPHRASE.length < 24 || /\\s/.test(env.MCP_API_PASSPHRASE)) add("MCP_API_PASSPHRASE", "API Explorer passphrase phải có ít nhất 24 ký tự, không whitespace.", "Tạo passphrase riêng, không dùng lại MCP_TOKEN.", "<random-passphrase-32-chars>");
if (!/^[A-Za-z0-9._-]{8,128}$/.test(env.MCP_OAUTH_CLIENT_ID || "")) add("MCP_OAUTH_CLIENT_ID", "OAuth Client ID bắt buộc cho API Explorer.", "Cấu hình client ID 8-128 ký tự.", "github-mcp-proxy-client");
if (!env.MCP_OAUTH_CLIENT_SECRET || env.MCP_OAUTH_CLIENT_SECRET.length < 24 || /\\s/.test(env.MCP_OAUTH_CLIENT_SECRET)) add("MCP_OAUTH_CLIENT_SECRET", "OAuth Client Secret bắt buộc và tối thiểu 24 ký tự.", "Tạo client secret mới.", "<OAuth client secret>");

let mode = "";
let serviceAccount = null;
try {
  if (env.FIREBASE_SERVICE_ACCOUNT_JSON_B64?.trim()) {
    const encoded = env.FIREBASE_SERVICE_ACCOUNT_JSON_B64.replace(/\\s/g, "").replace(/-/g, "+").replace(/_/g, "/");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error("Base64 có ký tự không hợp lệ");
    serviceAccount = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")); mode = "service_account_b64";
  } else if (env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim()) { serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON); mode = "service_account_json"; }
  if (serviceAccount && (serviceAccount.type !== "service_account" || !String(serviceAccount.client_email).includes("@") || !String(serviceAccount.private_key).includes("BEGIN PRIVATE KEY"))) throw new Error("JSON không phải Service Account đầy đủ");
} catch (error) { add(env.FIREBASE_SERVICE_ACCOUNT_JSON_B64?.trim() ? "FIREBASE_SERVICE_ACCOUNT_JSON_B64" : "FIREBASE_SERVICE_ACCOUNT_JSON", (error instanceof Error ? error.message : "Invalid Service Account JSON") + "; secret không được in ra log.", "Tạo lại Base64 một dòng từ Service Account JSON.", "base64 service-account.json"); }
function normalizeRtdbUrl(raw, removeAuth = false) { const url = new URL(raw); if (url.protocol !== "https:" || !/\\.(firebaseio\\.com|firebasedatabase\\.app)$/.test(url.hostname)) throw new Error("RTDB URL must use HTTPS and a Firebase database hostname"); url.pathname = url.pathname.replace(/\\/+$/, ""); if (!url.pathname || url.pathname === "/") url.pathname = "/github_accounts.json"; else if (url.pathname === "/github_accounts") url.pathname += ".json"; else if (!url.pathname.endsWith(".json")) throw new Error("RTDB URL path must point to github_accounts.json"); if (removeAuth) url.searchParams.delete("auth"); return url.toString(); }
let rtdbUrl = serviceAccount ? (env.RTDB_URL?.trim() || env.RTDB_AUTH_URL?.trim() || "") : (env.RTDB_AUTH_URL?.trim() || "");
try { if (!rtdbUrl) throw new Error("No RTDB URL supplied"); rtdbUrl = normalizeRtdbUrl(rtdbUrl, Boolean(serviceAccount)); if (!serviceAccount && !new URL(rtdbUrl).searchParams.get("auth")) throw new Error("Fallback URL must include ?auth= when Service Account is not configured"); }
catch (error) { add("RTDB_URL / RTDB_AUTH_URL", error instanceof Error ? error.message : "Invalid RTDB URL", "Use Firebase database URL; fallback must include ?auth=.", "https://project-default-rtdb.asia-southeast1.firebasedatabase.app/github_accounts.json"); }
if (!serviceAccount && !env.RTDB_AUTH_URL?.trim()) add("Firebase RTDB authentication", "Thiếu Service Account và RTDB_AUTH_URL fallback.", "Thêm FIREBASE_SERVICE_ACCOUNT_JSON_B64 + RTDB_URL hoặc RTDB_AUTH_URL có ?auth=.", "FIREBASE_SERVICE_ACCOUNT_JSON_B64 + RTDB_URL");
if (errors.length) { console.error("[PRE-FLIGHT CHECK FAILED] " + errors.length + " lỗi cấu hình:"); errors.forEach((e,i)=>console.error((i+1)+". "+e.name+"\\n   "+e.reason+"\\n   "+e.fix+"\\n   "+e.example)); process.exit(1); }
function hasEnabledAccounts(v) { return !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v).some(a=>a?.token&&String(a.token).trim()&&a.enabled!==false); }
async function fetchRtdbAccounts(url, accessToken) { const primary=new URL(url); if(accessToken)primary.searchParams.set("access_token",accessToken); let response=await fetch(primary); if(!response.ok)throw new Error("RTDB live check failed (HTTP "+response.status+")"); let data=await response.json(),selectedPath=primary.pathname; if(!hasEnabledAccounts(data)&&primary.pathname==="/github_accounts.json"){const envUrl=new URL(primary);envUrl.pathname="/env/github_accounts.json";const er=await fetch(envUrl);if(er.ok){const ed=await er.json();if(hasEnabledAccounts(ed)){data=ed;selectedPath=envUrl.pathname;}}} return {data,selectedPath}; }
function describe(v){if(v===null)return "null";if(Array.isArray(v))return "array";if(typeof v!=="object")return typeof v;return "object with "+Object.keys(v).length+" entries";}
async function cloudflare(path){const r=await fetch("https://api.cloudflare.com/client/v4"+path,{headers:{"X-Auth-Email":email,"X-Auth-Key":apiKey}});const d=await r.json();if(!r.ok||!d.success)throw new Error("Cloudflare API validation failed (HTTP "+r.status+")");return d.result;}
let enabledAccounts=0;
try {
 const user=await cloudflare("/user");if(!user)throw new Error("Cloudflare credentials rejected");
 const zones=await cloudflare("/zones?per_page=50"),zone=zones.filter(z=>z.status==="active"&&(domain===z.name||domain.endsWith("."+z.name))).sort((a,b)=>b.name.length-a.name.length)[0];if(!zone)throw new Error("No active Cloudflare zone matches CF_DOMAIN");
 if(!(mcpDomain.toLowerCase()===zone.name.toLowerCase()||mcpDomain.toLowerCase().endsWith("."+zone.name.toLowerCase())))throw new Error("MCP_DOMAIN is outside the active Cloudflare zone");
 const dns=await cloudflare("/zones/"+zone.id+"/dns_records?name="+encodeURIComponent(mcpDomain));if(!dns.some(x=>x.proxied===true&&["A","AAAA","CNAME"].includes(x.type)))throw new Error("MCP_DOMAIN needs an existing proxied DNS record");
 if(serviceAccount){const now=Math.floor(Date.now()/1000),encode=v=>Buffer.from(JSON.stringify(v)).toString("base64url"),unsigned=encode({alg:"RS256",typ:"JWT"})+"."+encode({iss:serviceAccount.client_email,scope:"https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email",aud:serviceAccount.token_uri||"https://oauth2.googleapis.com/token",iat:now,exp:now+3600});const signer=createSign("RSA-SHA256");signer.update(unsigned);const assertion=unsigned+"."+signer.sign(String(serviceAccount.private_key).replace(/\\n/g,"\\n"),"base64url");const tr=await fetch(serviceAccount.token_uri||"https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion})});if(!tr.ok)throw new Error("Firebase Service Account OAuth validation failed (HTTP "+tr.status+")");const td=await tr.json(),{data,selectedPath}=await fetchRtdbAccounts(rtdbUrl,td.access_token);if(!hasEnabledAccounts(data))throw new Error("RTDB "+selectedPath+" has no enabled account records ("+describe(data)+")");enabledAccounts=Object.values(data).filter(a=>a?.token&&a.enabled!==false).length;
 }else{const {data,selectedPath}=await fetchRtdbAccounts(rtdbUrl);if(!hasEnabledAccounts(data))throw new Error("RTDB "+selectedPath+" has no enabled account records ("+describe(data)+")");enabledAccounts=Object.values(data).filter(a=>a?.token&&a.enabled!==false).length;}
 console.log("[PRE-FLIGHT CHECK PASSED] Cloudflare hostname and RTDB verified; enabled accounts="+enabledAccounts+". Secrets were not printed.");warnings.forEach(x=>console.warn("WARNING: "+x));
}catch(error){console.error("[PRE-FLIGHT CHECK FAILED] "+(error instanceof Error?error.message:"Live check failed")+"; credentials and RTDB values were redacted.");process.exit(1);}
