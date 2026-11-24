import { spawnSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const configPath = resolve(process.argv[2] || process.env.WRANGLER_CONFIG || "wrangler.preview.jsonc");
const outDir = resolve(process.env.WRANGLER_OUTDIR || ".wrangler-content-upload");
const email = process.env.CF_API_EMAIL;
const key = process.env.CF_API_KEY;
if (!email || !key) throw new Error("CF_API_EMAIL and CF_API_KEY are required for Cloudflare API upload");

const config = JSON.parse(await readFile(configPath, "utf8"));
const accountId = config.account_id || process.env.CLOUDFLARE_ACCOUNT_ID;
const workerName = config.name;
if (!accountId || !workerName) throw new Error("Wrangler config must include account_id and name");

const build = spawnSync("npx", [
  "wrangler", "deploy", "--dry-run", "--outdir", outDir, "--config", configPath
], { stdio: "inherit", env: process.env });
if (build.error) throw build.error;
if (build.status !== 0) throw new Error("Wrangler dry-run bundle failed with exit code " + build.status);

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await walk(path));
    else if (entry.isFile() && !entry.name.endsWith(".map")) result.push(path);
  }
  return result;
}
const builtFiles = await walk(outDir);
if (!builtFiles.length) throw new Error("Wrangler dry-run produced no uploadable files");
const mainSource = config.main || "src/index.ts";
const mainStem = basename(mainSource).replace(/\.(tsx?|jsx?)$/, "");
const mainPath = builtFiles.find(path => basename(path) === mainStem + ".js")
  || builtFiles.find(path => basename(path) === "index.js")
  || builtFiles.find(path => /\.(m?js)$/.test(path));
if (!mainPath) throw new Error("Could not identify the bundled Worker entry module");
const mainModule = basename(mainPath);

function mimeFor(path) {
  if (/\.(m?js)$/.test(path)) return "application/javascript+module";
  if (path.endsWith(".wasm")) return "application/wasm";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".html")) return "text/html";
  if (path.endsWith(".txt")) return "text/plain";
  return "application/octet-stream";
}

const form = new FormData();
form.append("metadata", new Blob([JSON.stringify({ main_module: mainModule })], { type: "application/json" }), "metadata.json");
const uploaded = [];
for (const path of builtFiles) {
  const filename = basename(path);
  const bytes = await readFile(path);
  form.append(filename, new Blob([bytes], { type: mimeFor(path) }), filename);
  uploaded.push({ name: filename, bytes: bytes.byteLength });
}

const endpoint = "https://api.cloudflare.com/client/v4/accounts/" + accountId
  + "/workers/scripts/" + encodeURIComponent(workerName) + "/content";
const response = await fetch(endpoint, {
  method: "PUT",
  headers: { "X-Auth-Email": email, "X-Auth-Key": key },
  body: form
});
const payload = await response.json();
if (!response.ok || payload.success !== true) {
  const messages = (payload.errors || []).map(error => error.message).join("; ");
  throw new Error("Cloudflare Worker content upload failed (HTTP " + response.status + "): " + messages);
}
console.log(JSON.stringify({
  success: true,
  worker: workerName,
  account_id: accountId,
  main_module: mainModule,
  uploaded_files: uploaded,
  etag: payload.result?.etag || null,
  note: "Updated Worker code content only; existing bindings, migrations, routes and secrets were preserved."
}, null, 2));

const healthOrigin = config.vars?.PUBLIC_ORIGIN || process.env.PREVIEW_DOMAIN;
if (healthOrigin) {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= 12; attempt++) {
    try {
      const health = await fetch(String(healthOrigin).replace(/\/$/, "") + "/health", { signal: AbortSignal.timeout(10000) });
      lastStatus = health.status;
      if (health.ok) {
        console.log("Preview health check passed: HTTP " + health.status);
        break;
      }
    } catch {}
    if (attempt === 12) throw new Error("Worker uploaded but health check did not pass; last HTTP status " + lastStatus);
    await new Promise(resolve => setTimeout(resolve, 2500));
  }
}
