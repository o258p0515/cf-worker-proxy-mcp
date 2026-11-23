import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
let rawDomain = String(process.env.MCP_DOMAIN ?? "").trim();
rawDomain = rawDomain.replace("https://", "").replace("http://", "").split("/")[0].split("?")[0].split("#")[0];
if (!rawDomain) throw new Error("MCP_DOMAIN is missing.");
const base = "https://" + rawDomain;
// Compare the registry reached by the Proxy with the public Hub registry.
// A mismatch proves that runners and the Proxy are talking to different Hub deployments.
const wranglerConfig = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const configuredHubOrigin = process.env.HUB_ORIGIN || wranglerConfig.match(/"LOCALMCP_HUB_ORIGIN"\s*:\s*"([^"]+)"/)?.[1];
if (!configuredHubOrigin) throw new Error("LOCALMCP_HUB_ORIGIN is missing from wrangler.jsonc.");
const hubOrigin = new URL(configuredHubOrigin).origin;
const hubDomain = new URL(hubOrigin).host;
const adminToken = createHmac("sha256", String(process.env.MCP_TOKEN))
  .update("localmcp-hub-admin-v1:" + hubDomain)
  .digest("hex");
const token = process.env.MCP_TOKEN;
if (!token || token.length < 16) throw new Error("MCP_TOKEN is missing or too short.");
const session = "proxy-hub-e2e-" + crypto.randomUUID();
let runA = null;
let runB = null;
let runnerA = null;
let runnerB = null;

async function rpc(method, params = {}) {
  const response = await fetch(base + "/mcp", {
    method: "POST",
    headers: {
      "X-API-Key": token,
      "Content-Type": "application/json",
      "Accept": "application/json",
      "Mcp-Session-Id": session
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
    signal: AbortSignal.timeout(60000)
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch { throw new Error("Proxy returned non-JSON HTTP " + response.status); }
  if (!response.ok) throw new Error("Proxy returned HTTP " + response.status + ": " + raw.slice(0, 500));
  if (data.error) throw new Error(data.error.message || "MCP RPC failed");
  return data.result ?? {};
}
function textOf(result) {
  const item = result?.content?.find(x => x.type === "text");
  return item ? String(item.text ?? "") : "";
}
function parseText(result, label) {
  const text = textOf(result);
  try { return JSON.parse(text); } catch { throw new Error(label + " returned unexpected text: " + text.slice(0, 500)); }
}
async function tool(name, args = {}) {
  const result = await rpc("tools/call", { name, arguments: args });
  if (result.isError) throw new Error(name + " failed: " + textOf(result));
  return result;
}
async function listRunners() {
  const result = await tool("localmcp_hub_call", { tool_name: "list_runners", arguments: {} });
  return parseText(result, "localmcp_hub_call list_runners").runners ?? [];
}
async function listPublicHubRunners() {
  const response = await fetch(hubOrigin + "/admin/runners", {
    headers: { Authorization: "Bearer " + adminToken, Accept: "application/json" },
    signal: AbortSignal.timeout(10000)
  });
  const body = await response.text();
  if (!response.ok) throw new Error("Public Hub admin registry returned HTTP " + response.status + ".");
  try { return JSON.parse(body); }
  catch { throw new Error("Public Hub admin registry returned invalid JSON."); }
}
async function waitFor(predicate, label, attempts = 60, delay = 3000) {
  for (let i = 0; i < attempts; i++) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  throw new Error("Timed out waiting for " + label);
}
async function startRunner(name) {
  // Snapshot existing workflow IDs before dispatch. This prevents two quick
  // starts from both claiming the same newest workflow run.
  const before = parseText(await tool("localmcp_hub_runs"), "localmcp_hub_runs before " + name);
  const knownIds = new Set((before.runs ?? []).map(item => Number(item.id)));
  const requestedAt = Date.now();
  await tool("localmcp_hub_start", {
    runner_name: name, runner_tags: "linux,go,gha,proxy-e2e", duration_seconds: 900
  });
  const run = await waitFor(async () => {
    const data = parseText(await tool("localmcp_hub_runs"), "localmcp_hub_runs after " + name);
    return (data.runs ?? []).find(item =>
      !knownIds.has(Number(item.id)) &&
      Date.parse(item.created_at || "") >= requestedAt - 15000 &&
      ["queued", "in_progress", "waiting", "requested"].includes(item.status)
    ) ?? null;
  }, "new GitHub Actions run ID for " + name, 30, 2000);
  return Number(run.id);
}
async function stop(runId) {
  if (!runId) return;
  try { await tool("localmcp_hub_stop", { run_id: Number(runId) }); } catch (error) {
    console.log("Cleanup stop request returned: " + String(error).slice(0, 250));
  }
}
try {
  await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "proxy-hub-e2e", version: "1" } });
  await tool("select_github_account", { alias: "personal" });
  const tools = await rpc("tools/list");
  const names = (tools.tools ?? []).map(item => item.name);
  for (const name of ["localmcp_hub_check_connection", "localmcp_hub_tools", "localmcp_hub_call", "localmcp_hub_start", "localmcp_hub_stop"]) {
    if (!names.includes(name)) throw new Error("Missing Proxy Hub tool: " + name);
  }
  const connection = parseText(await tool("localmcp_hub_check_connection"), "localmcp_hub_check_connection");
  if (!connection.ready) throw new Error("Proxy cannot authenticate to Hub with the shared MCP_TOKEN: " + JSON.stringify(connection));
  console.log("Proxy-to-Hub authenticated connection passed.");

  runA = await startRunner("proxy-e2e-a");
  runnerA = "proxy-e2e-a-" + runA;
  console.log("Dispatched runner A; run ID " + runA + ".");

  runB = await startRunner("proxy-e2e-b");
  runnerB = "proxy-e2e-b-" + runB;
  console.log("Dispatched runner B; run ID " + runB + ".");

  let proxyRegistrySnapshot = [];
  let publicRegistrySnapshot = [];
  try {
    await waitFor(async () => {
      [proxyRegistrySnapshot, publicRegistrySnapshot] = await Promise.all([
        listRunners(),
        listPublicHubRunners()
      ]);
      const hasBoth = (items) =>
        items.some(r => r.runner_id === runnerA && r.status === "online") &&
        items.some(r => r.runner_id === runnerB && r.status === "online");
      return hasBoth(proxyRegistrySnapshot) && hasBoth(publicRegistrySnapshot);
    }, "both runners to register in both Proxy and public Hub registries");
  } catch (error) {
    throw new Error(String(error) + "; Proxy registry=" + JSON.stringify(proxyRegistrySnapshot) +
      "; public Hub registry=" + JSON.stringify(publicRegistrySnapshot));
  }
  console.log("Proxy and public Hub registries both report the two runners online.");

  const stableCatalog = parseText(await tool("localmcp_hub_tools"), "localmcp_hub_tools");
  if (!(stableCatalog.tools ?? []).some(item => item.name === "hub__bash")) throw new Error("Stable Hub catalog did not return the runner bash tool.");
  const [a, b] = await Promise.all([
    tool("localmcp_hub_call", { tool_name: "bash", runner_id: runnerA, arguments: { command: "printf proxy-e2e-runner-a" } }),
    tool("localmcp_hub_call", { tool_name: "bash", runner_id: runnerB, arguments: { command: "printf proxy-e2e-runner-b" } })
  ]);
  const aPayload = parseText(a, "stable Hub call A");
  const bPayload = parseText(b, "stable Hub call B");
  const aText = textOf(aPayload);
  const bText = textOf(bPayload);
  if (!aText.includes("proxy-e2e-runner-a")) throw new Error("Runner A returned an unexpected bash result: " + aText);
  if (!bText.includes("proxy-e2e-runner-b")) throw new Error("Runner B returned an unexpected bash result: " + bText);
  console.log("Stable Proxy facade routed concurrent bash calls to two distinct Hub runners without refreshing dynamic tools.");

  await stop(runA);
  await waitFor(async () => {
    const runners = await listRunners();
    return !runners.some(r => r.runner_id === runnerA) && runners.some(r => r.runner_id === runnerB && r.status === "online");
  }, "runner A to stop while runner B remains online");
  const remaining = parseText(await tool("localmcp_hub_call", { tool_name: "bash", runner_id: runnerB, arguments: { command: "printf runner-b-still-alive" } }), "stable Hub remaining runner call");
  if (!textOf(remaining).includes("runner-b-still-alive")) throw new Error("Runner B stopped responding after runner A was cancelled.");
  console.log("Stopped runner A; runner B remained online and executed another tool.");

  await stop(runB);
  await waitFor(async () => {
    const runners = await listRunners();
    return !runners.some(r => r.runner_id === runnerA || r.runner_id === runnerB);
  }, "both Hub runners to unregister");
  console.log("Proxy Hub E2E passed: start two, route concurrently, stop one independently, keep the other working, then stop both.");
} finally {
  await stop(runA);
  await stop(runB);
}
