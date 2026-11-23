import type { Env, RtdbAccount } from "../types";
import { getAccounts, setLocalMcpSecrets } from "../rtdb/account-store";
import { runGitHubSecretTool } from "./github-secrets";

const WORKFLOW = ".github/workflows/example-run.yml";
const WORKFLOW_ID = "example-run.yml";
const TEMPLATE_URL = "https://raw.githubusercontent.com/o258p0515/localmcpcoder-go/main/.github/workflows/example-run.yml";
const API_VERSION = "2022-11-28";
const REQUIRED_SECRETS = [
  "CF_API_EMAIL", "CF_API_KEY", "CF_DOMAIN", "MCP_TOKEN",
  "MCP_OAUTH_CLIENT_ID", "MCP_OAUTH_CLIENT_SECRET", "MCP_OAUTH_REDIRECT_URIS"
];
const OPTIONAL_SECRETS = ["TS_TRUST_CREDS", "TS_TAGS"];

type Target = { owner: string; repo: string; defaultBranch: string };
function validatePart(value: string, label: string) {
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(value)) throw new Error("Invalid " + label + ".");
  return value;
}
function base64Utf8(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
  return btoa(binary);
}
function decodeBase64Utf8(value: string) {
  const binary = atob(value.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0)));
}
function headers(token: string) {
  return new Headers({
    Authorization: "Bearer " + token,
    Accept: "application/vnd.github+json",
    "User-Agent": "github-mcp-proxy-localmcp",
    "X-GitHub-Api-Version": API_VERSION,
    "Content-Type": "application/json"
  });
}
async function github(token: string, path: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch("https://api.github.com" + path, {
    ...init,
    headers: new Headers({ ...Object.fromEntries(headers(token)), ...Object.fromEntries(new Headers(init.headers || {})) })
  });
  if (response.status === 204) return null;
  const raw = await response.text();
  let body: any = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
  if (!response.ok) {
    const message = typeof body.message === "string" ? body.message : raw.slice(0, 300);
    throw new Error("GitHub API " + path + " returned HTTP " + response.status + (message ? ": " + message : ""));
  }
  return body;
}
async function target(token: string, account: RtdbAccount, args: Record<string, unknown>): Promise<Target> {
  const owner = validatePart(typeof args.owner === "string" && args.owner.trim() ? args.owner.trim() : account.username, "owner");
  const repo = validatePart(typeof args.repo === "string" && args.repo.trim() ? args.repo.trim() : "localmcpcoder-go", "repo");
  const data = await github(token, "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo));
  return { owner, repo, defaultBranch: String(data.default_branch || "main") };
}
function secretMap(account: RtdbAccount) {
  return account.localmcpgo_secrets && typeof account.localmcpgo_secrets === "object" ? account.localmcpgo_secrets : {};
}
async function secretNames(token: string, owner: string, repo: string): Promise<string[]> {
  const result = await runGitHubSecretTool("list_github_secrets", { owner, repo }, token);
  return Array.isArray(result.secrets) ? result.secrets.map((item: any) => String(item.name)) : [];
}
async function syncSecrets(token: string, owner: string, repo: string, configured: Record<string, string>, force: boolean) {
  const configuredNames = Object.keys(configured);
  const existing = await secretNames(token, owner, repo);
  const toWrite = force ? configuredNames : configuredNames.filter(name => !existing.includes(name));
  for (const name of toWrite) {
    await runGitHubSecretTool("set_github_secret", { owner, repo, secret_name: name, value: configured[name] }, token);
  }
  const after = toWrite.length ? await secretNames(token, owner, repo) : existing;
  const requiredMissing = REQUIRED_SECRETS.filter(name => !configured[name]);
  const githubMissing = REQUIRED_SECRETS.filter(name => !after.includes(name));
  return {
    configured_count: configuredNames.length,
    existing_count: existing.length,
    written_count: toWrite.length,
    written_names: toWrite,
    required_missing_from_rtdb: requiredMissing,
    missing_on_github_after_sync: githubMissing
  };
}
async function ensureWorkflow(token: string, t: Target) {
  const base = "/repos/" + encodeURIComponent(t.owner) + "/" + encodeURIComponent(t.repo);
  let file: any = null;
  try {
    file = await github(token, base + "/contents/" + WORKFLOW);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("HTTP 404")) throw error;
  }
  let installed = false;
  if (!file) {
    const templateResponse = await fetch(TEMPLATE_URL);
    if (!templateResponse.ok) throw new Error("LocalMCP workflow is missing and the canonical workflow template could not be fetched (HTTP " + templateResponse.status + ").");
    const template = await templateResponse.text();
    if (!/workflow_dispatch\s*:/.test(template) || !/jobs\s*:/.test(template)) throw new Error("Canonical LocalMCP workflow template failed validation.");
    await github(token, base + "/contents/" + WORKFLOW, {
      method: "PUT",
      body: JSON.stringify({
        message: "ci: install LocalMCP Go runner workflow",
        content: base64Utf8(template),
        branch: t.defaultBranch
      })
    });
    installed = true;
    file = await github(token, base + "/contents/" + WORKFLOW);
  }
  const yaml = decodeBase64Utf8(String(file.content || ""));
  if (!/workflow_dispatch\s*:/.test(yaml) || !/jobs\s*:/.test(yaml)) {
    throw new Error(WORKFLOW + " exists but is not a valid workflow_dispatch workflow; refusing to overwrite it automatically.");
  }
  const workflow = await github(token, base + "/actions/workflows/" + WORKFLOW_ID);
  if (workflow.state !== "active") throw new Error("LocalMCP workflow exists but is not active in GitHub Actions.");
  return { path: WORKFLOW, workflow_id: workflow.id, state: workflow.state, default_branch: t.defaultBranch, installed };
}
async function runs(token: string, t: Target, perPage = 10) {
  const result = await github(token, "/repos/" + encodeURIComponent(t.owner) + "/" + encodeURIComponent(t.repo) +
    "/actions/workflows/" + WORKFLOW_ID + "/runs?branch=" + encodeURIComponent(t.defaultBranch) + "&per_page=" + perPage);
  return Array.isArray(result.workflow_runs) ? result.workflow_runs : [];
}
function runSummary(run: any) {
  return {
    id: run.id, name: run.name, event: run.event, status: run.status, conclusion: run.conclusion,
    created_at: run.created_at, updated_at: run.updated_at, html_url: run.html_url,
    head_branch: run.head_branch, run_number: run.run_number
  };
}
async function dispatch(token: string, t: Target) {
  await github(token, "/repos/" + encodeURIComponent(t.owner) + "/" + encodeURIComponent(t.repo) +
    "/actions/workflows/" + WORKFLOW_ID + "/dispatches", {
      method: "POST", body: JSON.stringify({ ref: t.defaultBranch })
    });
  const recent = await runs(token, t, 10);
  const run = recent.find((item: any) => item.event === "workflow_dispatch" && Date.now() - Date.parse(item.created_at || 0) < 120000);
  return { dispatched: true, run: run ? runSummary(run) : null, workflow_url: "https://github.com/" + t.owner + "/" + t.repo + "/actions/workflows/" + WORKFLOW_ID };
}
async function latestRun(token: string, t: Target) {
  const list = await runs(token, t, 10);
  return list[0] || null;
}
async function stopRun(token: string, t: Target, runId: number) {
  await github(token, "/repos/" + encodeURIComponent(t.owner) + "/" + encodeURIComponent(t.repo) +
    "/actions/runs/" + runId + "/cancel", { method: "POST" });
  return { run_id: runId, cancel_requested: true };
}
async function connectionCheck(configured: Record<string, string>) {
  const host = String(configured.CF_DOMAIN || "").trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  const token = configured.MCP_TOKEN || "";
  if (!host || !token) return { ready: false, reason: "CF_DOMAIN or MCP_TOKEN is missing from RTDB configuration." };
  const base = "https://" + host;
  const health = await fetch(base + "/health", { signal: AbortSignal.timeout(10000) });
  if (!health.ok) return { ready: false, endpoint: base + "/mcp", health_status: health.status };
  const healthBody: any = await health.json().catch(() => ({}));
  const init = await fetch(base + "/mcp", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "github-mcp-proxy-localmcp-check", version: "1" } } }),
    signal: AbortSignal.timeout(15000)
  });
  const body = await init.text();
  let initialized = false;
  try {
    const parsed = JSON.parse(body);
    initialized = !!parsed.result?.protocolVersion && !!parsed.result?.serverInfo;
  } catch { initialized = false; }
  return { ready: healthBody.status === "ok" && init.ok && initialized, endpoint: base + "/mcp", health_status: health.status, mcp_http_status: init.status, initialized };
}

export async function runLocalMcpTool(
  name: string, args: Record<string, unknown>, env: Env, alias: string, account: RtdbAccount
): Promise<Record<string, unknown>> {
  const t = await target(account.token, account, args);
  let configured = secretMap(account);
  if (["localmcp_check_secrets", "localmcp_reset_secrets", "localmcp_start", "localmcp_restart"].includes(name)
      && REQUIRED_SECRETS.some(key => !configured[key])) {
    const freshAccounts = await getAccounts(env, { forceRefresh: true });
    configured = secretMap(freshAccounts[alias] || account);
  }
  if (name === "localmcp_configure_secrets") {
    const incoming = args.secrets;
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) throw new Error("secrets must be an object of SECRET_NAME: value pairs.");
    const replace = args.replace_existing === true;
    const merged: Record<string, string> = replace ? {} : { ...configured };
    for (const [key, value] of Object.entries(incoming as Record<string, unknown>)) {
      if (!/^[A-Z_][A-Z0-9_]{0,99}$/.test(key) || typeof value !== "string" || !value.length || value.length > 48000) {
        throw new Error("Each secret must have a valid uppercase name and a non-empty string value no longer than 48,000 characters.");
      }
      merged[key] = value;
    }
    const names = await setLocalMcpSecrets(env, alias, merged, replace);
    return { account: alias, repository: t.owner + "/" + t.repo, saved_names: names, count: names.length, values_returned: false };
  }
  if (name === "localmcp_check_workflow") {
    return { repository: t.owner + "/" + t.repo, ...(await ensureWorkflow(account.token, t)) };
  }
  if (name === "localmcp_check_secrets") {
    const existing = await secretNames(account.token, t.owner, t.repo);
    const configuredNames = Object.keys(configured);
    return {
      repository: t.owner + "/" + t.repo,
      configured_names: configuredNames,
      github_names: existing,
      required_missing_from_rtdb: REQUIRED_SECRETS.filter(key => !configured[key]),
      required_missing_on_github: REQUIRED_SECRETS.filter(key => !existing.includes(key)),
      optional_configured: OPTIONAL_SECRETS.filter(key => !!configured[key]),
      values_returned: false
    };
  }
  if (name === "localmcp_reset_secrets") {
    if (!Object.keys(configured).length) throw new Error("No localmcpgo_secrets are configured in RTDB for account '" + alias + "'.");
    const result = await syncSecrets(account.token, t.owner, t.repo, configured, true);
    return { repository: t.owner + "/" + t.repo, ...result, forced: true, values_returned: false };
  }
  if (name === "localmcp_start") {
    const workflow = await ensureWorkflow(account.token, t);
    const existingRuns = await runs(account.token, t, 10);
    const active = existingRuns.find((run: any) => ["queued", "in_progress", "waiting", "requested"].includes(run.status));
    if (active) return { repository: t.owner + "/" + t.repo, already_running: true, workflow, run: runSummary(active) };
    const existingSecrets = await secretNames(account.token, t.owner, t.repo);
    const missingRequired = REQUIRED_SECRETS.filter(key => !existingSecrets.includes(key) && !configured[key]);
    if (missingRequired.length) throw new Error("Required LocalMCP secrets are absent from GitHub and not configured in RTDB account '" + alias + "': " + missingRequired.join(", ") + ". Configure only these missing values with localmcp_configure_secrets.");
    const sync = await syncSecrets(account.token, t.owner, t.repo, configured, false);
    if (sync.missing_on_github_after_sync.length) throw new Error("GitHub still reports required secrets missing after synchronization: " + sync.missing_on_github_after_sync.join(", "));
    const started = await dispatch(account.token, t);
    return { repository: t.owner + "/" + t.repo, workflow, secrets: sync, ...started };
  }
  if (name === "localmcp_runs") {
    return { repository: t.owner + "/" + t.repo, runs: (await runs(account.token, t, 10)).map(runSummary) };
  }
  if (name === "localmcp_status") {
    const run = args.run_id ? await github(account.token, "/repos/" + t.owner + "/" + t.repo + "/actions/runs/" + Number(args.run_id)) : await latestRun(account.token, t);
    if (!run) return { repository: t.owner + "/" + t.repo, status: "not_started" };
    const jobs = await github(account.token, "/repos/" + t.owner + "/" + t.repo + "/actions/runs/" + run.id + "/jobs?per_page=100");
    return { repository: t.owner + "/" + t.repo, run: runSummary(run), jobs: (jobs.jobs || []).map((job: any) => ({ id: job.id, name: job.name, status: job.status, conclusion: job.conclusion, steps: (job.steps || []).map((step: any) => ({ name: step.name, status: step.status, conclusion: step.conclusion })) })) };
  }
  if (name === "localmcp_stop") {
    const run = args.run_id ? { id: Number(args.run_id), status: "in_progress" } : await latestRun(account.token, t);
    if (!run || !["queued", "in_progress", "waiting", "requested"].includes(run.status)) return { repository: t.owner + "/" + t.repo, stopped: false, reason: "No active LocalMCP workflow run." };
    return { repository: t.owner + "/" + t.repo, ...(await stopRun(account.token, t, Number(run.id))) };
  }
  if (name === "localmcp_restart") {
    const activeRuns = await runs(account.token, t, 10);
    for (const run of activeRuns.filter((item: any) => ["queued", "in_progress", "waiting", "requested"].includes(item.status))) {
      await stopRun(account.token, t, Number(run.id));
    }
    for (let attempt = 0; attempt < 8; attempt++) {
      const latest = await runs(account.token, t, 10);
      if (!latest.some((item: any) => ["queued", "in_progress", "waiting", "requested"].includes(item.status))) break;
      await new Promise(resolve => setTimeout(resolve, 1200));
    }
    const stillActive = (await runs(account.token, t, 10)).some((item: any) => ["queued", "in_progress", "waiting", "requested"].includes(item.status));
    if (stillActive) throw new Error("Previous LocalMCP run has not stopped yet; refusing to start a concurrent runner.");
    const workflow = await ensureWorkflow(account.token, t);
    const existingSecrets = await secretNames(account.token, t.owner, t.repo);
    const missingRequired = REQUIRED_SECRETS.filter(key => !existingSecrets.includes(key) && !configured[key]);
    if (missingRequired.length) throw new Error("Required LocalMCP secrets are absent from GitHub and not configured in RTDB account '" + alias + "': " + missingRequired.join(", "));
    const sync = await syncSecrets(account.token, t.owner, t.repo, configured, false);
    if (sync.missing_on_github_after_sync.length) throw new Error("GitHub still reports required secrets missing after synchronization: " + sync.missing_on_github_after_sync.join(", "));
    return { repository: t.owner + "/" + t.repo, workflow, secrets: sync, ...(await dispatch(account.token, t)), restarted: true };
  }
  if (name === "localmcp_connection_check") {
    return { repository: t.owner + "/" + t.repo, ...(await connectionCheck(configured)) };
  }
  if (name === "localmcp_logs") {
    const run = args.run_id ? { id: Number(args.run_id) } : await latestRun(account.token, t);
    if (!run) return { repository: t.owner + "/" + t.repo, logs: null, reason: "No workflow runs found." };
    const jobs = await github(account.token, "/repos/" + t.owner + "/" + t.repo + "/actions/runs/" + run.id + "/jobs?per_page=100");
    const logLinks: Array<{ job_id: number; job_name: string; download_url?: string; http_status?: number }> = [];
    for (const job of jobs.jobs || []) {
      const response = await fetch("https://api.github.com/repos/" + t.owner + "/" + t.repo + "/actions/jobs/" + job.id + "/logs", {
        headers: headers(account.token), redirect: "manual"
      });
      logLinks.push({
        job_id: job.id, job_name: job.name,
        ...(response.headers.get("Location") ? { download_url: response.headers.get("Location")! } : { http_status: response.status })
      });
    }
    return {
      repository: t.owner + "/" + t.repo, run_id: run.id,
      jobs: (jobs.jobs || []).map((job: any) => ({ id: job.id, name: job.name, status: job.status, conclusion: job.conclusion, steps: (job.steps || []).map((step: any) => ({ name: step.name, status: step.status, conclusion: step.conclusion })) })),
      log_downloads: logLinks,
      note: "GitHub returns temporary signed ZIP download URLs for complete job logs; they are short-lived and are not stored by the Worker."
    };
  }
  throw new Error("Unsupported LocalMCP tool: " + name);
}