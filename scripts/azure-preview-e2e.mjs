const endpoint = String(process.env.PREVIEW_DOMAIN || "").replace(/\/$/, "") + "/mcp";
const token = String(process.env.MCP_TOKEN || "");
const alias = "azure-aerielaaeriel651971";
const project = "me";
const repository = "me";
const sourceRef = "main";
if (!endpoint.startsWith("https://") || token.length < 16) throw new Error("Preview endpoint or MCP_TOKEN is not configured.");
let rpcId = 0;
async function call(name, args = {}) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "X-API-Key": token, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } })
  });
  const raw = await response.text();
  let message;
  try { message = raw ? JSON.parse(raw) : {}; } catch { throw new Error(name + " returned non-JSON HTTP " + response.status + "."); }
  const text = message.result?.content?.find(item => item.type === "text")?.text;
  if (!response.ok || message.error || message.result?.isError) throw new Error(name + " failed (HTTP " + response.status + "): " + String(text || message.error?.message || raw).slice(0, 1200));
  if (typeof text === "string") { try { return JSON.parse(text); } catch { return text; } }
  return message.result;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runOne(os) {
  let runId = 0;
  let runnerId = "";
  let runnerOnline = false;
  try {
    await call("select_github_account", { alias });
    const check = await call("localmcp_hub_check_secrets", { provider: "azure", project });
    if (!check.credential_validated || !check.hub_credentials_ready) throw new Error("Azure account validation failed: " + JSON.stringify({ credential_validated: check.credential_validated, hub_credentials_ready: check.hub_credentials_ready, missing_hub_secrets: check.missing_hub_secrets }));
    console.log("Azure account validated for " + os + "; Hub URL source: " + check.hub_urls_source + ".");

    const started = await call("localmcp_hub_start", {
      provider: "azure", project, repository, os,
      runner_name: "issue68-e2e-" + os,
      runner_tags: "issue68,e2e,preview",
      duration_seconds: 600,
      source_ref: sourceRef
    });
    runId = Number(started.run_id);
    runnerId = String(started.runner_id || "");
    if (!Number.isSafeInteger(runId) || runId <= 0 || !runnerId) throw new Error("Azure start did not return a valid run_id and runner_id: " + JSON.stringify(started));
    console.log("Azure pipeline queued: " + JSON.stringify({ os, run_id: runId, runner_id: runnerId, status: started.status, pipeline: started.pipeline }));

    let lastStatus;
    for (let attempt = 0; attempt < 48; attempt++) {
      lastStatus = await call("localmcp_hub_status", { provider: "azure", project, run_id: runId, runner_id: runnerId });
      if (lastStatus.runner_online === true) { runnerOnline = true; break; }
      if (lastStatus.state === "completed" || ["failed", "canceled", "cancelled"].includes(String(lastStatus.result || lastStatus.status).toLowerCase())) {
        throw new Error("Azure pipeline finished before its runner registered: " + JSON.stringify({ os, state: lastStatus.state, result: lastStatus.result, timeline: lastStatus.timeline }));
      }
      await sleep(10000);
    }
    if (!runnerOnline) throw new Error("Timed out waiting for Azure runner registration. Last status: " + JSON.stringify({ os, state: lastStatus?.state, status: lastStatus?.status, runner_online: lastStatus?.runner_online, hub_error: lastStatus?.hub_error, timeline: lastStatus?.timeline }));
    console.log("Runner connected to LocalMCP Hub: " + runnerId);

    const hubRunners = await call("hub__list_runners", {});
    const registered = (hubRunners.runners || []).some(runner => runner.runner_id === runnerId && runner.status === "online");
    if (!registered) throw new Error("list_runners did not report the Azure runner online: " + JSON.stringify(hubRunners));
    const info = await call("hub__system_info", { runner_id: runnerId });
    const infoText = JSON.stringify(info);
    if (!infoText.toLowerCase().includes(os)) throw new Error("Runner OS mismatch; expected " + os + ": " + infoText.slice(0, 1000));
    console.log("Runner system_info passed: " + infoText.slice(0, 1000));
    const shellMarker = "ISSUE68_" + os.toUpperCase() + "_SHELL_OK";
    const shellResult = await call("hub__bash", { command: os === "windows" ? "Write-Output " + shellMarker : "printf '" + shellMarker + "\\n'", runner_id: runnerId });
    if (!JSON.stringify(shellResult).includes(shellMarker)) throw new Error("Runner shell execution failed for " + os + ": " + JSON.stringify(shellResult).slice(0, 1000));
    console.log("Runner shell passed: " + shellMarker);

    const logList = await call("localmcp_hub_logs", { provider: "azure", project, run_id: runId, runner_id: runnerId });
    const logs = Array.isArray(logList.logs) ? logList.logs : [];
    if (!logs.length) throw new Error("Azure Build Logs API returned no log records for run " + runId + ".");
    const page = await call("localmcp_hub_logs", { provider: "azure", project, run_id: runId, log_id: Number(logs[0].id), start_line: 1, end_line: 30 });
    if (!Array.isArray(page.lines)) throw new Error("Azure Build Logs API did not return a bounded line page.");
    console.log("Azure log pagination passed: " + JSON.stringify({ os, log_id: page.log_id, start_line: page.start_line, end_line: page.end_line, returned_lines: page.lines.length, nextStartLine: page.nextStartLine }));
  } finally {
    if (runId > 0) {
      await call("localmcp_hub_stop", { provider: "azure", project, run_id: runId, runner_id: runnerId });
      let finalStatus;
      for (let attempt = 0; attempt < 60; attempt++) {
        finalStatus = await call("localmcp_hub_status", { provider: "azure", project, run_id: runId, runner_id: runnerId });
        if (finalStatus.state === "completed" && finalStatus.runner_online !== true) break;
        if (attempt > 0 && attempt % 12 === 0) {
          await call("localmcp_hub_stop", { provider: "azure", project, run_id: runId, runner_id: runnerId });
        }
        await sleep(5000);
      }
      console.log("Azure runner cleanup: " + JSON.stringify({ os, run_id: runId, state: finalStatus?.state, result: finalStatus?.result, runner_online: finalStatus?.runner_online }));
      if (finalStatus?.state !== "completed" || finalStatus?.runner_online === true) throw new Error("Runner did not fully stop and disconnect: " + runnerId);
    }
  }
  console.log("LIVE_AZURE_E2E_PASS " + JSON.stringify({ os, run_id: runId, runner_id: runnerId, runner_online_verified: runnerOnline, cleanup_requested: runId > 0 }));
}

for (const os of ["linux", "windows"]) await runOne(os);
console.log("LIVE_AZURE_E2E_ALL_PASS");
   91