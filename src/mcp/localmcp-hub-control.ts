import type { RtdbAccount } from "../types";
import { runGitHubSecretTool } from "./github-secrets";

const WORKFLOW = "hub-runner.yml";
const API_VERSION = "2022-11-28";

function configured(account: RtdbAccount, fallbackToken = "") {
  const secrets = account.localmcpgo_secrets || {};
  const urls = String(secrets.HUB_URLS || "").split(",").map(value => value.trim()).filter(Boolean);
  if (!urls.length) throw new Error("HUB_URLS is missing from RTDB localmcpgo_secrets.");

  for (const value of urls) {
    const url = new URL(value);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) throw new Error("HUB_URLS must contain HTTPS Hub base URLs.");
    if (url.username || url.password || url.search || url.hash) throw new Error("HUB_URLS must contain clean base URLs.");
  }
  const rtdbToken = String(secrets.MCP_TOKEN || "").trim();
  const token = rtdbToken || String(fallbackToken || "").trim();
  if (token.length < 16) throw new Error("MCP_TOKEN is missing or too short in both RTDB localmcpgo_secrets and the Proxy runtime. The Hub and runner must use the same MCP_TOKEN.");
  return { HUB_URLS: urls.join(","), MCP_TOKEN: token, MCP_TOKEN_SOURCE: rtdbToken ? "RTDB localmcpgo_secrets" : "Proxy runtime MCP_TOKEN" };
}
function target(args: Record<string, unknown>, account: RtdbAccount) {
  const owner = typeof args.owner === "string" && args.owner.trim() ? args.owner.trim() : account.username;
  const repo = typeof args.repo === "string" && args.repo.trim() ? args.repo.trim() : "localmcpcoder-go";
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) throw new Error("Invalid repository owner or name.");
  return { owner, repo };
}
function headers(token: string) {
  return new Headers({ Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "User-Agent": "github-mcp-proxy-localmcp-hub", "X-GitHub-Api-Version": API_VERSION, "Content-Type": "application/json" });
}
async function github(token: string, path: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch("https://api.github.com" + path, { ...init, headers: new Headers({ ...Object.fromEntries(headers(token)), ...Object.fromEntries(new Headers(init.headers || {})) }) });
  if (response.status === 204) return null;
  const raw = await response.text();
  let body: any = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
  if (!response.ok) throw new Error("GitHub API " + path + " returned HTTP " + response.status + ": " + String(body.message || raw).slice(0, 400));
  return body;
}
async function workflow(token: string, repo: { owner: string; repo: string }) {
  const result = await github(token, "/repos/" + repo.owner + "/" + repo.repo + "/actions/workflows/" + WORKFLOW);
  if (result.state !== "active") throw new Error("Hub runner workflow exists but is not active.");
  return result;
}
async function runs(token: string, repo: { owner: string; repo: string }, count = 10) {
  const data = await github(token, "/repos/" + repo.owner + "/" + repo.repo + "/actions/workflows/" + WORKFLOW + "/runs?per_page=" + count);
  return Array.isArray(data.workflow_runs) ? data.workflow_runs : [];
}
function summary(run: any) {
  return { id: run.id, status: run.status, conclusion: run.conclusion, created_at: run.created_at, updated_at: run.updated_at, html_url: run.html_url, head_branch: run.head_branch, run_number: run.run_number };
}

export async function runLocalMcpHubControlTool(name: string, args: Record<string, unknown>, account: RtdbAccount, fallbackToken = "") {
  const repo = target(args, account);
  const path = "/repos/" + repo.owner + "/" + repo.repo;
  if (name === "localmcp_hub_check_secrets") {
    const configuredSecrets = configured(account, fallbackToken);
    const result = await runGitHubSecretTool("list_github_secrets", repo, account.token);
    const existing = Array.isArray(result.secrets) ? result.secrets.map((item: any) => String(item.name)) : [];
    const required = ["HUB_URLS", "MCP_TOKEN"];
    const rtdbSecrets = account.localmcpgo_secrets || {};
    const missingInRtdb = ["HUB_URLS"].filter(key => !String(rtdbSecrets[key] || "").trim());
    return { repository: repo.owner + "/" + repo.repo, configured_names: Object.keys(rtdbSecrets).filter(key => ["HUB_URLS", "MCP_TOKEN"].includes(key)), effective_configured_names: ["HUB_URLS", "MCP_TOKEN"], token_source: configuredSecrets.MCP_TOKEN_SOURCE, github_names: existing, missing_in_rtdb: missingInRtdb, missing_on_github: required.filter(key => !existing.includes(key)), sync_required: required, values_returned: false, note: "MCP_TOKEN is read from RTDB when present, otherwise the existing Proxy runtime MCP_TOKEN is reused. GitHub does not reveal stored values; localmcp_hub_start rewrites both GitHub Actions secrets before dispatch." };
  }
  if (name === "localmcp_hub_start") {
    const values = configured(account, fallbackToken);
    const runnerName = typeof args.runner_name === "string" && args.runner_name.trim() ? args.runner_name.trim() : "gha";
    const runnerTags = typeof args.runner_tags === "string" && args.runner_tags.trim() ? args.runner_tags.trim() : "linux,go,gha";
    const duration = args.duration_seconds === undefined ? 20400 : Number(args.duration_seconds);
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(runnerName)) throw new Error("runner_name must be 1-64 letters, digits, dot, underscore or hyphen.");
    if (runnerTags.length > 500 || !/^[A-Za-z0-9_.,-]*$/.test(runnerTags)) throw new Error("runner_tags contains unsupported characters or is too long.");
    if (!Number.isInteger(duration) || duration < 60 || duration > 20400) throw new Error("duration_seconds must be between 60 and 20400.");
    const existingSecrets = await runGitHubSecretTool("list_github_secrets", repo, account.token);
    const existingNames = Array.isArray(existingSecrets.secrets) ? existingSecrets.secrets.map((item: any) => String(item.name)) : [];
    const wf = await workflow(account.token, repo);
    // Always overwrite both values: GitHub only exposes secret names, so an existing
    // MCP_TOKEN may still be stale after the selected RTDB account was changed.
    await runGitHubSecretTool("set_github_secret", { ...repo, secret_name: "HUB_URLS", value: values.HUB_URLS }, account.token);
    await runGitHubSecretTool("set_github_secret", { ...repo, secret_name: "MCP_TOKEN", value: values.MCP_TOKEN }, account.token);
    const repository = await github(account.token, path);
    await github(account.token, path + "/actions/workflows/" + WORKFLOW + "/dispatches", { method: "POST", body: JSON.stringify({ ref: String(repository.default_branch || "main"), inputs: { runner_name: runnerName, runner_tags: runnerTags, duration_seconds: String(duration) } }) });
    const recent = await runs(account.token, repo, 10);
    const run = recent.find((item: any) => item.event === "workflow_dispatch" && Date.now() - Date.parse(item.created_at || 0) < 120000);
    return { repository: repo.owner + "/" + repo.repo, workflow: wf.path, dispatched: true, runner_name: runnerName, runner_tags: runnerTags, duration_seconds: duration, run: run ? summary(run) : null, workflow_url: "https://github.com/" + repo.owner + "/" + repo.repo + "/actions/workflows/" + WORKFLOW };
  }
  if (name === "localmcp_hub_runs") return { repository: repo.owner + "/" + repo.repo, runs: (await runs(account.token, repo, 20)).map(summary) };
  if (name === "localmcp_hub_status") {
    const run = args.run_id ? await github(account.token, path + "/actions/runs/" + Number(args.run_id)) : (await runs(account.token, repo, 1))[0];
    if (!run) return { repository: repo.owner + "/" + repo.repo, status: "not_started" };
    const jobs = await github(account.token, path + "/actions/runs/" + run.id + "/jobs?per_page=100");
    return { repository: repo.owner + "/" + repo.repo, run: summary(run), jobs: (jobs.jobs || []).map((job: any) => ({ id: job.id, name: job.name, status: job.status, conclusion: job.conclusion, steps: (job.steps || []).map((step: any) => ({ name: step.name, status: step.status, conclusion: step.conclusion })) })) };
  }
  if (name === "localmcp_hub_stop") {
    const all = args.run_id ? [] : await runs(account.token, repo, 20);
    const run = args.run_id ? await github(account.token, path + "/actions/runs/" + Number(args.run_id)) : all.find((item: any) => ["queued", "in_progress", "waiting", "requested"].includes(item.status));
    if (!run || !["queued", "in_progress", "waiting", "requested"].includes(run.status)) return { repository: repo.owner + "/" + repo.repo, stopped: false, reason: "The requested Hub runner workflow is not active." };
    await github(account.token, path + "/actions/runs/" + Number(run.id) + "/cancel", { method: "POST" });
    return { repository: repo.owner + "/" + repo.repo, run_id: Number(run.id), cancel_requested: true };
  }
  throw new Error("Unsupported LocalMCP Hub control tool: " + name);
}
