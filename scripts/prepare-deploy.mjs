import {readFile,writeFile,appendFile} from "node:fs/promises";

const email=process.env.CF_API_EMAIL;
const key=process.env.CF_API_KEY;
const domain=process.env.CF_DOMAIN;
const configuredMcpDomain=(process.env.MCP_DOMAIN||"").trim().toLowerCase();

if(!email||!key||!domain)throw new Error("CF_API_EMAIL, CF_API_KEY and CF_DOMAIN are required");
if(!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(configuredMcpDomain)){
  throw new Error("MCP_DOMAIN is required and must be a hostname only (no scheme, path, port, or trailing dot). Configure it as a GitHub Actions repository secret.");
}

async function cf(path,init={}){const r=await fetch("https://api.cloudflare.com/client/v4"+path,{...init,headers:{"X-Auth-Email":email,"X-Auth-Key":key,"Content-Type":"application/json",...(init.headers||{})}});const d=await r.json();if(!r.ok||!d.success)throw new Error("Cloudflare API failed for "+path+" (HTTP "+r.status+"): "+(d.errors||[]).map(x=>x.message).join("; "));return d.result;}
const zones=await cf("/zones?per_page=50"),zone=zones.filter(z=>z.status==="active"&&(domain===z.name||domain.endsWith("."+z.name))).sort((a,b)=>b.name.length-a.name.length)[0];
if(!zone)throw new Error("No active Cloudflare zone found for CF_DOMAIN");
const publicDomain=configuredMcpDomain;
if(!(publicDomain===zone.name||publicDomain.endsWith("."+zone.name))){
  throw new Error("MCP_DOMAIN "+publicDomain+" is not inside the active Cloudflare zone selected by CF_DOMAIN ("+zone.name+").");
}
const subdomainPath="/accounts/"+zone.account.id+"/workers/subdomain";
let workersSubdomain=null;
try {
  workersSubdomain=(await cf(subdomainPath))?.subdomain||null;
} catch(error) {
  if(!String(error).includes("(HTTP 404)"))throw error;
}
if(!workersSubdomain){
  const requested="localmcpcoder-"+zone.account.id.slice(0,6).toLowerCase();
  workersSubdomain=(await cf(subdomainPath,{method:"PUT",body:JSON.stringify({subdomain:requested})}))?.subdomain||requested;
  console.error("Provisioned the required account workers.dev subdomain.");
}else{
  console.error("Reusing the existing account workers.dev subdomain.");
}
async function dnsRecords(hostname){
  return cf("/zones/"+zone.id+"/dns_records?name="+encodeURIComponent(hostname));
}
const fixedRecords=await dnsRecords(publicDomain);
const hasProxiedDns=fixedRecords.some(record=>
  record.proxied===true&&["A","AAAA","CNAME"].includes(record.type)
);
if(!hasProxiedDns){
  throw new Error("MCP_DOMAIN "+publicDomain+" must have an existing proxied A/AAAA/CNAME DNS record in Cloudflare zone "+zone.name+".");
}
const workerDomain=publicDomain;
const workerRoutes=[{pattern:publicDomain+"/*",zone_name:zone.name}];
console.error("Using MCP_DOMAIN from GitHub Actions secret: https://"+publicDomain+"/mcp");
const namespaces=await cf("/accounts/"+zone.account.id+"/storage/kv/namespaces?per_page=100");
async function ensure(title){const found=namespaces.find(x=>x.title===title);if(found)return found.id;return (await cf("/accounts/"+zone.account.id+"/storage/kv/namespaces",{method:"POST",body:JSON.stringify({title})})).id;}
const oauth=await ensure("github-mcp-oauth-kv"),cache=await ensure("github-mcp-cache-kv");
let cfg=await readFile(new URL("../wrangler.jsonc",import.meta.url),"utf8");
cfg=cfg.replaceAll("__CF_ACCOUNT_ID__",zone.account.id).replaceAll("__WORKER_ROUTES__",JSON.stringify(workerRoutes)).replaceAll("__PUBLIC_DOMAIN__",publicDomain).replaceAll("__OAUTH_KV_ID__",oauth).replaceAll("__CACHE_KV_ID__",cache);
await writeFile(new URL("../wrangler.deploy.jsonc",import.meta.url),cfg);
if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,"## GitHub MCP Proxy endpoint\n\nhttps://"+publicDomain+"/mcp\n");
if(process.env.GITHUB_ENV)await appendFile(process.env.GITHUB_ENV,"CLOUDFLARE_ACCOUNT_ID="+zone.account.id+"\nCLOUDFLARE_API_KEY="+key+"\nCLOUDFLARE_EMAIL="+email+"\nWORKER_DOMAIN="+workerDomain+"\nPUBLIC_DOMAIN="+publicDomain+"\n");
console.error("Prepared Cloudflare deployment config for "+workerDomain+"; credentials are not printed.");
