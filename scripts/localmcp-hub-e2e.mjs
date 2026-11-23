const base = new URL(process.env.MCP_DOMAIN).origin;
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
  return parseText(await tool("hub__list_runners"), "hub__list_runners").runners ?? [];
}
async function waitFor(predicate, label, attempts = 60, delay = 3000) {
  for (let i = 0; i < attempts; i++) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  throw new Error("Timed out waiting for " + label);
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
  for (const name of ["localmcp_hub_check_connection", "localmcp_hub_start", "localmcp_hub_stop", "hub__list_runners", "hub__select_runner"]) {
    if (!names.includes(name)) throw new Error("Missing Proxy Hub tool: " + name);
  }
  const connection = parseText(await tool("localmcp_hub_check_connection"), "localmcp_hub_check_connection");
  if (!connection.ready) throw new Error("Proxy cannot authenticate to Hub with the shared MCP_TOKEN: " + JSON.stringify(connection));
  console.log("Proxy-to-Hub authenticated connection passed.");

  const startA = parseText(await tool("localmcp_hub_start", {
    runner_name: "proxy-e2e-a", runner_tags: "linux,go,gha,proxy-e2e", duration_seconds: 900
  }), "localmcp_hub_start A");
  runA = startA.run?.id ?? null;
  if (!runA) throw new Error("Hub runner A was dispatched but its GitHub Actions run ID was not returned.");
  runnerA = "proxy-e2e-a-" + runA;
  console.log("Dispatched runner A; run ID " + runA + ".");

  const startB = parseText(await tool("localmcp_hub_start", {
    runner_name: "proxy-e2e-b", runner_tags: "linux,go,gha,proxy-e2e", duration_seconds: 900
  }), "localmcp_hub_start B");
  runB = startB.run?.id ?? null;
  if (!runB) throw new Error("Hub runner B was dispatched but its GitHub Actions run ID was not returned.");
  runnerB = "proxy-e2e-b-" + runB;
  console.log("Dispatched runner B; run ID " + runB + ".");

  await waitFor(async () => {
    const runners = await listRunners();
    return runners.some(r => r.runner_id === runnerA && r.status === "online") &&
      runners.some(r => r.runner_id === runnerB && r.status === "online");
  }, "both runners to register online");
  console.log("Hub Registry reports both runners online.");

  await tool("hub__select_runner", { runner_id: runnerA });
  const remoteTools = await rpc("tools/list");
  if (!(remoteTools.tools ?? []).some(item => item.name === "hub__bash")) {
    throw new Error("Hub runner tools were not exposed through the Proxy after selecting runner A.");
  }
  const [a, b] = await Promise.all([
    tool("hub__bash", { runner_id: runnerA, command: "printf proxy-e2e-runner-a" }),
    tool("hub__bash", { runner_id: runnerB, command: "printf proxy-e2e-runner-b" })
  ]);
  if (!textOf(a).includes("proxy-e2e-runner-a")) throw new Error("Runner A returned an unexpected bash result: " + textOf(a));
  if (!textOf(b).includes("proxy-e2e-runner-b")) throw new Error("Runner B returned an unexpected bash result: " + textOf(b));
  console.log("Proxy routed concurrent bash calls to two distinct Hub runners.");

  await stop(runA);
  await waitFor(async () => {
    const runners = await listRunners();
    return !runners.some(r => r.runner_id === runnerA) && runners.some(r => r.runner_id === runnerB && r.status === "online");
  }, "runner A to stop while runner B remains online");
  const remaining = await tool("hub__bash", { runner_id: runnerB, command: "printf runner-b-still-alive" });
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
