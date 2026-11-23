import type { RtdbAccount } from "../types";
import { runGitHubSecretTool } from "./github-secrets";

const WORKFLOW_PATH = ".github/workflows/hub-runner.yml";
const WORKFLOW_ID = "hub-runner.yml";
const TEMPLATE_URL = "https://raw.githubusercontent.com/o258p0515/localmcpcoder-go/feat/shared-mcp-token/.github/workflows/hub-runner.yml";
const REQUIRED = ["MCP_TOKEN", "HUB_URLS"];

type Target = { owner: string; repo: string; ref: string };
function secrets(account: RtdbAccount): Record<string, string> {
  return account.localmcpgo_secrets && typeof account.localmcpgo_secrets === "object" ? account.localmcpgo_secrets : {};
}
function part(value: string, label: string): string {
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(value)) throw new Error("Invalid " + label + ".");
  return value;
}
function headers(token: string) {
  return new Headers({ Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "User-Agent": "github-mcp-proxy-hub", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" });
}
async function github(token: string, path: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch("https://api.github.com" + path, { ...init, headers: new Headers({ ...Object.fromEntries(headers(token)), ...Object.fromEntries(new Headers(init.headers || {})) }) });
  if (response.status === 204) return null;
  const raw = await response.text();
  let body: any = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
  if (!response.ok) throw new Error("GitHub API " + path + " returned HTTP " + response.status + (body.message ? ": " + body.message : ""));
  return body;
}
async function target(account: RtdbAccount, args: Record<string, unknown>): Promise<Target> {
  const owner = part(typeof args.owner === "string" && args.owner.trim() ? args.owner.trim() : account.username, "owner");
  const repo = part(typeof args.repo === "string" && args.repo.trim() ? args.repo.trim() : "localmcpcoder-go", "repo");
  const info = await github(account.token, "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo));
  const ref = part(typeof args.ref === "string" && args.ref.trim() ? args.ref.trim() : String(info.default_branch || "main"), "ref");
  return { owner, repo, ref };
}
async function secretNames(token: string, owner: string, repo: string): Promise<string[]> {
  const result = await runGitHubSecretTool("list_github_secrets", { owner, repo }, token);
  return Array.isArray(result.secrets) ? result.secrets.map((item: any) => String(item.name)) : [];
}
async function syncHubSecrets(token: string, owner: string, repo: string, configured: Record<string, string>) {
  const missingConfig = REQUIRED.filter(name => !configured[name]);
  if (missingConfig.length) throw new Error("Required Hub secrets are missing from RTDB localmcpgo_secrets: " + missingConfig.join(", ") + ". Configure them with localmcp_configure_secrets.");
  const before = await secretNames(token, owner, repo);
  const write = REQUIRED.filter(name => !before.includes(name));
  for (const name of write) await runGitHubSecretTool("set_github_secret", { owner, repo, secret_name: name, value: configured[name] }, token);
  const after = write.length ? await secretNames(token, owner, repo) : before;
  const missing = REQUIRED.filter(name => !after.includes(name));
  return { required: REQUIRED, existing_count: before.length, written_names: write, missing_on_github_after_sync: missing, values_returned: false };
}
async function ensureWorkflow(token: string, t: Target) {
  const base = "/repos/" + encodeURIComponent(t.owner) + "/" + encodeURIComponent(t.repo);
  let file: any = null;
  try { file = await github(token, base + "/contents/" + WORKFLOW_PATH + "?ref=" + encodeURIComponent(t.ref)); }
  catch (error) { if (!(error instanceof Error) || !error.message.includes("HTTP 404")) throw error; }
  let installed = false;
  if (!file) {
    const response = await fetch(TEMPLATE_URL);
    if (!response.ok) throw new Error("Canonical LocalMCP Hub workflow template could not be fetched (HTTP " + response.status + ").");
    const template = await response.text();
    if (!/workflow_dispatch\s*:/.test(template) || !/HUB_URLS/.test(template) || !/MCP_TOKEN/.test(template)) throw new Error("Canonical Hub workflow template failed validation.");
    const bytes = new TextEncoder().encode(template);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
    await github(token, base + "/contents/" + WORKFLOW_PATH, { method: "PUT", body: JSON.stringify({ message: "ci: install LocalMCP Hub runner workflow", content: btoa(binary), branch: t.ref }) });
    installed = true;
    file = await github(token, base + "/contents/" + WORKFLOW_PATH + "?ref=" + encodeURIComponent(t.ref));
  }
  const content = atob(String(file.content || "").replace(/\s/g, ""));
  const yaml = new TextDecoder().decode(Uint8Array.from(content, c => c.charCodeAt(0)));
  if (!/workflow_dispatch\s*:/.test(yaml) || !/HUB_URLS/.test(yaml) || !/MCP_TOKEN/.test(yaml)) throw new Error(WORKFLOW_PATH + " exists but is not a valid Hub runner workflow; refusing to overwrite it.");
  const workflow = await github(token, base + "/actions/workflows/" + WORKFLOW_ID);
  if (workflow.state !== "active") throw new Error("LocalMCP Hub runner workflow exists but is not active in GitHub Actions.");
  return { path: WORKFLOW_PATH, workflow_id: workflow.id, state: workflow.state, ref: t.ref, installed };
}
async function listRuns(token: string, t: Target, perPage = 20) {
  const response = await github(token, "/repos/" + encodeURIComponent(t.owner) + "/" + encodeURIComponent(t.repo) + "/actions/workflows/" + WORKFLOW_ID + "/runs?branch=" + encodeURIComponent(t.ref) + "&per_page=" + perPage);
  return Array.isArray(response.workflow_runs) ? response.workflow_runs : [];
}
function summary(run: any) {
  return { id: run.id, name: run.name, display_title: run.display_title, event: run.event, status: run.status, conclusion: run.conclusion, created_at: run.created_at, updated_at: run.updated_at, html_url: run.html_url, head_branch: run.head_branch, run_number: run.run_number };
}
async function dispatch(token: string, t: Target, args: Record<string, unknown>) {
  const runnerName = typeof args.runner_name === "string" && args.runner_name.trim() ? args.runner_name.trim() : "gha";
  const runnerTags = typeof args.runner_tags === "string" && args.runner_tags.trim() ? args.runner_tags.trim() : "linux,go,gha";
  const duration = args.duration_seconds === undefined ? 20400 : Number(args.duration_seconds);
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(runnerName)) throw new Error("runner_name must contain 1-64 letters, numbers, dots, underscores or hyphens.");
  if (runnerTags.length > 256 || !/^[A-Za-z0-9_.-]+(?:,[A-Za-z0-9_.-]+)*$/.test(runnerTags)) throw new Error("runner_tags must be a comma-separated list of simple tags.");
  if (!Number.isInteger(duration) || duration < 60 || duration > 20400) throw new Error("duration_seconds must be between 60 and 20400.");
  const path = "/repos/" + encodeURIComponent(t.owner) + "/" + encodeURIComponent(t.repo) + "/actions/workflows/" + WORKFLOW_ID + "/dispatches";
  await github(token, path, { method: "POST", body: JSON.stringify({ ref: t.ref, inputs: { runner_name: runnerName, runner_tags: runnerTags, duration_seconds: String(duration) } }) });
  const recent = await listRuns(token, t, 10);
  const run = recent.find((item: any) => item.event === "workflow_dispatch" && Date.now() - Date.parse(item.created_at || 0) < 120000);
  return { dispatched: true, runner_name: runnerName, runner_tags: runnerTags, duration_seconds: duration, run: run ? summary(run) : null, workflow_url: "https://github.com/" + t.owner + "/" + t.repo + "/actions/workflows/" + WORKFLOW_ID };
}
export async function runHubRunnerTool(name: string, args: Record<string, unknown>, account: RtdbAccount) {
  const t = await target(account, args);
  const base = "/repos/" + encodeURIComponent(t.owner) + "/" + encodeURIComponent(t.repo);
  if (name === "localmcp_hub_check_workflow") return { repository: t.owner + "/" + t.repo, ...(await ensureWorkflow(account.token, t)) };
  if (name === "localmcp_hub_check_secrets") {
    const configured = secrets(account), existing = await secretNames(account.token, t.owner, t.repo);
    return { repository: t.owner + "/" + t.repo, configured_names: Object.keys(configured).filter(key => REQUIRED.includes(key)), github_names: existing, required_missing_from_rtdb: REQUIRED.filter(key => !configured[key]), required_missing_on_github: REQUIRED.filter(key => !existing.includes(key)), values_returned: false };
  }
  if (name === "localmcp_hub_start") {
    const workflow = await ensureWorkflow(account.token, t);
    const synced = await syncHubSecrets(account.token, t.owner, t.repo, secrets(account));
    if (synced.missing_on_github_after_sync.length) throw new Error("GitHub still reports required Hub secrets missing: " + synced.missing_on_github_after_sync.join(", "));
    return { repository: t.owner + "/" + t.repo, workflow, secrets: synced, ...(await dispatch(account.token, t, args)) };
  }
  if (name === "localmcp_hub_runs") return { repository: t.owner + "/" + t.repo, runs: (await listRuns(account.token, t)).map(summary) };
  if (name === "localmcp_hub_status") {
    const run = args.run_id ? await github(account.token, base + "/actions/runs/" + Number(args.run_id)) : (await listRuns(account.token, t, 1))[0];
    if (!run) return { repository: t.owner + "/" + t.repo, status: "not_started" };
    const jobs = await github(account.token, base + "/actions/runs/" + run.id + "/jobs?per_page=100");
    return { repository: t.owner + "/" + t.repo, run: summary(run), jobs: (jobs.jobs || []).map((job: any) => ({ id: job.id, name: job.name, status: job.status, conclusion: job.conclusion, steps: (job.steps || []).map((step: any) => ({ name: step.name, status: step.status, conclusion: step.conclusion })) })) };
  }
  if (name === "localmcp_hub_stop") {
    const runId = Number(args.run_id);
    if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error("run_id is required and must be a positive GitHub Actions run ID.");
    await github(account.token, base + "/actions/runs/" + runId + "/cancel", { method: "POST" });
    return { repository: t.owner + "/" + t.repo, run_id: runId, cancel_requested: true };
  }
  throw new Error("Unsupported LocalMCP Hub workflow tool: " + name);
}
