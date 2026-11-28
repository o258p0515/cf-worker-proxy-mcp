import type { AuthContext, RtdbAccount } from "../types";
import { runGitHubSecretTool } from "./github-secrets";
import { runAzureHubTool } from "./azure-devops";
import { runInstaBoxHubTool } from "./instabox";
import { runUpstashBoxHubTool } from "./upstash-box";
import {
  DEFAULT_GITHUB_WORKFLOW,
  appendRoutingTags,
  base64ToUtf8,
  isCustomGitHubWorkflowFilename,
  normalizeGitHubWorkflowFilename,
  utf8ToBase64,
  validateGitHubRunnerYaml
} from "./hub-workflow-utils";

const API_VERSION = "2022-11-28";

const DEFAULT_HUB_URL = "https://hub.o258p0515.dpdns.org";
const OPTIONAL_TS_SECRETS = ["TS_TRUST_CREDS", "TS_TAGS", "TS_AUTHKEY"] as const;
const WORKFLOW_MANAGEMENT_TOOLS = new Set([
  "localmcp_hub_list_workflows",
  "localmcp_hub_get_workflow",
  "localmcp_hub_upsert_workflow",
  "localmcp_hub_delete_workflow"
]);
const MUTATING_HUB_TOOLS = new Set([
  "localmcp_hub_start",
  "localmcp_hub_stop",
  "localmcp_hub_upsert_workflow",
  "localmcp_hub_delete_workflow"
]);

function configured(account: RtdbAccount, fallbackToken = "", env: any = {}) {
  const secrets = account.localmcpgo_secrets || {};
  const configuredUrls = String(secrets.HUB_URLS || "").trim();
  const runtimeDefault = String(env.LOCALMCP_HUB_ORIGIN || "").trim();
  const urls = String(configuredUrls || runtimeDefault || DEFAULT_HUB_URL).split(",").map(value => value.trim()).filter(Boolean);
  const hubUrlSource = configuredUrls ? "RTDB localmcpgo_secrets" : runtimeDefault ? "Proxy LOCALMCP_HUB_ORIGIN" : "built-in default";
  for (const value of urls) {
    const url = new URL(value);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) throw new Error("HUB_URLS must contain HTTPS Hub base URLs.");
    if (url.username || url.password || url.search || url.hash) throw new Error("HUB_URLS must contain clean base URLs.");
  }
  const rtdbToken = String(secrets.MCP_TOKEN || "").trim();
  const token = rtdbToken || String(fallbackToken || "").trim();
  if (token.length < 16) throw new Error("MCP_TOKEN is missing or too short in this account's RTDB localmcpgo_secrets and the Proxy runtime. The Hub and runner must use the same MCP_TOKEN.");
  return { HUB_URLS: urls.join(","), HUB_URLS_SOURCE: hubUrlSource, MCP_TOKEN: token, MCP_TOKEN_SOURCE: rtdbToken ? "RTDB localmcpgo_secrets" : "Proxy runtime MCP_TOKEN" };
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
async function workflow(token: string, repo: { owner: string; repo: string }, workflowName = DEFAULT_GITHUB_WORKFLOW) {
  const result = await github(token, "/repos/" + repo.owner + "/" + repo.repo + "/actions/workflows/" + encodeURIComponent(workflowName));
  if (result.state !== "active") throw new Error("Hub runner workflow '" + workflowName + "' exists but is not active.");
  return result;
}
async function runs(token: string, repo: { owner: string; repo: string }, count = 10, workflowName = DEFAULT_GITHUB_WORKFLOW) {
  const data = await github(token, "/repos/" + repo.owner + "/" + repo.repo + "/actions/workflows/" + encodeURIComponent(workflowName) + "/runs?per_page=" + count);
  return Array.isArray(data.workflow_runs) ? data.workflow_runs : [];
}
function summary(run: any) {
  return { id: run.id, status: run.status, conclusion: run.conclusion, created_at: run.created_at, updated_at: run.updated_at, html_url: run.html_url, head_branch: run.head_branch, run_number: run.run_number };
}
type HubProvider = "github" | "azure" | "instabox" | "upstashbox";
const VALID_PROVIDERS: readonly HubProvider[] = ["github", "azure", "instabox", "upstashbox"];

function accountProviders(account: RtdbAccount): HubProvider[] {
  const values = account.localmcpgo_secrets || {};
  return [
    ...(account.token ? ["github" as const] : []),
    ...(values.AZURE_DEVOPS_PAT && values.AZURE_DEVOPS_ORG_URL ? ["azure" as const] : []),
    ...(values.INSTABOX_API_KEY ? ["instabox" as const] : []),
    ...(values.UPSTASH_BOX_API_KEY ? ["upstashbox" as const] : [])
  ];
}
function resolveProviderAndAccount(
  account: RtdbAccount,
  alias: string,
  requested: unknown,
  allAccounts?: Record<string, RtdbAccount>
): { provider: HubProvider; targetAccount: RtdbAccount; targetAlias: string } {
  const provider = typeof requested === "string" ? requested.trim().toLowerCase() : "";
  if (provider && !VALID_PROVIDERS.includes(provider as HubProvider)) {
    throw new Error("provider must be one of: github, azure, instabox, upstashbox.");
  }
  const enabledEntries = Object.entries(allAccounts || { [alias || "selected"]: account })
    .filter(([, item]) => item && item.enabled !== false);
  const availableProviders = Array.from(new Set(enabledEntries.flatMap(([, item]) => accountProviders(item))));
  if (!availableProviders.length) throw new Error("No enabled account has supported GitHub, Azure DevOps, InstaBox, or Upstash Box credentials.");
  let chosenProvider: HubProvider;
  if (availableProviders.length === 1) {
    chosenProvider = availableProviders[0]!;
  } else {
    if (!provider) {
      throw new Error("Multiple providers are configured (" + availableProviders.join(", ") + "). Pass provider=" + availableProviders.map(p => `provider='${p}'`).join(" or ") + "; no provider is selected automatically.");
    }
    chosenProvider = provider as HubProvider;
  }
  if (accountProviders(account).includes(chosenProvider)) {
    return { provider: chosenProvider, targetAccount: account, targetAlias: alias };
  }
  const matches = enabledEntries.filter(([, item]) => accountProviders(item).includes(chosenProvider));
  if (matches.length === 1) {
    return { provider: chosenProvider, targetAccount: matches[0]![1], targetAlias: matches[0]![0] };
  }
  if (matches.length > 1) {
    throw new Error("Multiple accounts support provider '" + chosenProvider + "' (" + matches.map(([key]) => key).join(", ") + "). Call select_github_account with the intended alias.");
  }
  throw new Error("Provider '" + chosenProvider + "' is not configured for any enabled account.");
}

async function resolveBranch(token: string, repoPath: string, requestedRef: unknown): Promise<string> {
  if (typeof requestedRef === "string" && requestedRef.trim()) {
    const ref = requestedRef.trim();
    if (!/^[A-Za-z0-9_./-]{1,128}$/.test(ref) || ref.includes("..")) {
      throw new Error("Invalid git ref.");
    }
    return ref;
  }
  const repository = await github(token, repoPath);
  return String(repository.default_branch || "main");
}

export async function runLocalMcpHubControlTool(name: string, args: Record<string, unknown>, account: RtdbAccount, fallbackToken = "", alias = "", env: any = {}, authContext?: AuthContext, allAccounts?: Record<string, RtdbAccount>) {
  const { provider, targetAccount, targetAlias } = resolveProviderAndAccount(account, alias, args.provider, allAccounts);
  if (targetAccount.readonly && MUTATING_HUB_TOOLS.has(name)) {
    throw new Error("Account '" + targetAlias + "' is read-only; this write operation is blocked.");
  }
  if (provider === "azure") return { ...(await runAzureHubTool(name, args, targetAccount, targetAlias, env, authContext)), provider: "azure" };
  if (provider === "instabox") {
    if (WORKFLOW_MANAGEMENT_TOOLS.has(name)) throw new Error(name + " is only supported for provider='github' or provider='azure'.");
    return { ...(await runInstaBoxHubTool(name, args, targetAccount, targetAlias, env, authContext)), provider: "instabox" };
  }
  if (provider === "upstashbox") {
    if (WORKFLOW_MANAGEMENT_TOOLS.has(name)) throw new Error(name + " is only supported for provider='github' or provider='azure'.");
    return { ...(await runUpstashBoxHubTool(name, args, targetAccount, targetAlias, env, authContext)), provider: "upstashbox" };
  }
  if (!targetAccount.token) throw new Error("The selected account has no GitHub token; choose provider='azure' for Azure DevOps operations.");
  const repo = target(args, targetAccount);
  const path = "/repos/" + repo.owner + "/" + repo.repo;

  if (name === "localmcp_hub_list_workflows") {
    const data = await github(targetAccount.token, path + "/actions/workflows?per_page=100");
    const items = Array.isArray(data.workflows) ? data.workflows : [];
    const workflows = items.map((wf: any) => {
      const wfPath = String(wf.path || "");
      const filename = wfPath.replace(/^\.github\/workflows\//i, "");
      return {
        id: Number(wf.id),
        name: String(wf.name || ""),
        filename,
        path: wfPath,
        state: String(wf.state || ""),
        is_default: filename === DEFAULT_GITHUB_WORKFLOW,
        is_custom_managed: isCustomGitHubWorkflowFilename(filename),
        html_url: wf.html_url || null
      };
    });
    return {
      provider: "github",
      repository: repo.owner + "/" + repo.repo,
      default_workflow: DEFAULT_GITHUB_WORKFLOW,
      workflows
    };
  }

  if (name === "localmcp_hub_get_workflow") {
    const wfName = normalizeGitHubWorkflowFilename(args.workflow);
    const wfPath = ".github/workflows/" + wfName;
    const ref = await resolveBranch(targetAccount.token, path, args.ref);
    const file = await github(targetAccount.token, path + "/contents/" + wfPath + "?ref=" + encodeURIComponent(ref));
    const yamlContent = base64ToUtf8(String(file.content || ""));
    const validation = validateGitHubRunnerYaml(yamlContent);
    let wfMeta: any = null;
    try {
      wfMeta = await github(targetAccount.token, path + "/actions/workflows/" + encodeURIComponent(wfName));
    } catch {
      wfMeta = null;
    }
    return {
      provider: "github",
      repository: repo.owner + "/" + repo.repo,
      workflow: wfName,
      path: wfPath,
      ref,
      sha: file.sha || null,
      workflow_id: wfMeta ? Number(wfMeta.id) : null,
      state: wfMeta ? String(wfMeta.state || "") : "unindexed",
      is_default: wfName === DEFAULT_GITHUB_WORKFLOW,
      is_custom_managed: isCustomGitHubWorkflowFilename(wfName),
      handover_compatible: validation.valid,
      validation_errors: validation.errors,
      yaml_content: yamlContent
    };
  }

  if (name === "localmcp_hub_upsert_workflow") {
    if (typeof args.workflow !== "string" || !args.workflow.trim()) {
      throw new Error("workflow filename is required (must match 'hub-runner-<name>.yml').");
    }
    const wfName = normalizeGitHubWorkflowFilename(args.workflow);
    if (!isCustomGitHubWorkflowFilename(wfName)) {
      throw new Error(
        "Custom GitHub workflow filename must match 'hub-runner-<name>.yml' (cannot overwrite default 'hub-runner.yml' or CI workflows)."
      );
    }
    const yamlContent = typeof args.yaml_content === "string" ? args.yaml_content : "";
    const validation = validateGitHubRunnerYaml(yamlContent);
    if (!validation.valid) {
      throw new Error("Raw YAML failed LocalMCP Hub handover validation: " + validation.errors.join(" "));
    }
    const wfPath = ".github/workflows/" + wfName;
    const ref = await resolveBranch(targetAccount.token, path, args.ref);
    let existing: any = null;
    try {
      existing = await github(targetAccount.token, path + "/contents/" + wfPath + "?ref=" + encodeURIComponent(ref));
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("HTTP 404")) throw error;
    }
    const message =
      typeof args.commit_message === "string" && args.commit_message.trim()
        ? args.commit_message.trim().slice(0, 200)
        : (existing ? "ci: update custom Hub runner workflow " : "ci: add custom Hub runner workflow ") + wfName;
    const putBody: Record<string, unknown> = {
      message,
      content: utf8ToBase64(yamlContent),
      branch: ref,
      ...(existing?.sha ? { sha: existing.sha } : {})
    };
    const putResult = await github(targetAccount.token, path + "/contents/" + wfPath, {
      method: "PUT",
      body: JSON.stringify(putBody)
    });
    let wfMeta: any = null;
    try {
      wfMeta = await github(targetAccount.token, path + "/actions/workflows/" + encodeURIComponent(wfName));
    } catch {
      wfMeta = null;
    }
    return {
      provider: "github",
      repository: repo.owner + "/" + repo.repo,
      workflow: wfName,
      path: wfPath,
      ref,
      action: existing ? "updated" : "created",
      sha: putResult?.content?.sha || null,
      commit_sha: putResult?.commit?.sha || null,
      workflow_id: wfMeta ? Number(wfMeta.id) : null,
      state: wfMeta ? String(wfMeta.state || "") : "pending_indexing",
      handover_compatible: true
    };
  }

  if (name === "localmcp_hub_delete_workflow") {
    if (typeof args.workflow !== "string" || !args.workflow.trim()) {
      throw new Error("workflow filename is required (must match 'hub-runner-<name>.yml').");
    }
    const wfName = normalizeGitHubWorkflowFilename(args.workflow);
    if (!isCustomGitHubWorkflowFilename(wfName)) {
      throw new Error(
        "Refusing to delete '" + wfName + "': only custom Hub workflows matching 'hub-runner-<name>.yml' can be deleted."
      );
    }
    const wfPath = ".github/workflows/" + wfName;
    const ref = await resolveBranch(targetAccount.token, path, args.ref);
    const existing = await github(targetAccount.token, path + "/contents/" + wfPath + "?ref=" + encodeURIComponent(ref));
    if (!existing?.sha) throw new Error("Workflow file '" + wfPath + "' was not found.");
    const message =
      typeof args.commit_message === "string" && args.commit_message.trim()
        ? args.commit_message.trim().slice(0, 200)
        : "ci: delete custom Hub runner workflow " + wfName;
    await github(targetAccount.token, path + "/contents/" + wfPath, {
      method: "DELETE",
      body: JSON.stringify({ message, sha: existing.sha, branch: ref })
    });
    return {
      provider: "github",
      repository: repo.owner + "/" + repo.repo,
      workflow: wfName,
      path: wfPath,
      ref,
      deleted: true
    };
  }

  if (name === "localmcp_hub_check_secrets") {
    const configuredSecrets = configured(targetAccount, fallbackToken, env);
    const result = await runGitHubSecretTool("list_github_secrets", repo, targetAccount.token);
    const existing = Array.isArray(result.secrets) ? result.secrets.map((item: any) => String(item.name)) : [];
    const required = ["HUB_URLS", "MCP_TOKEN"];
    const rtdbSecrets = targetAccount.localmcpgo_secrets || {};
    const missingInRtdb: string[] = [];
    const effectiveHubUrlSource = configuredSecrets.HUB_URLS_SOURCE;
    const optionalConfigured = OPTIONAL_TS_SECRETS.filter(key => !!String(rtdbSecrets[key] || "").trim());
    return { provider: "github", repository: repo.owner + "/" + repo.repo, configured_names: Object.keys(rtdbSecrets).filter(key => ["HUB_URLS", "MCP_TOKEN", ...OPTIONAL_TS_SECRETS].includes(key)), effective_configured_names: ["HUB_URLS", "MCP_TOKEN"], optional_configured_names: optionalConfigured, optional_missing_on_github: optionalConfigured.filter(key => !existing.includes(key)), hub_urls_source: effectiveHubUrlSource, token_source: configuredSecrets.MCP_TOKEN_SOURCE, github_names: existing, missing_in_rtdb: missingInRtdb, missing_on_github: required.filter(key => !existing.includes(key)), sync_required: required, values_returned: false };
  }
  if (name === "localmcp_hub_start") {
    const values = configured(targetAccount, fallbackToken, env);
    const wfName = normalizeGitHubWorkflowFilename(args.workflow);
    const isDefaultWorkflow = wfName === DEFAULT_GITHUB_WORKFLOW;
    const runnerName = typeof args.runner_name === "string" && args.runner_name.trim() ? args.runner_name.trim() : "gha";
    const baseRunnerTags = typeof args.runner_tags === "string" && args.runner_tags.trim() ? args.runner_tags.trim() : "go,gha";
    const runnerOs = args.os === "windows" ? "windows" : "linux";
    const duration = args.duration_seconds === undefined ? 20400 : Number(args.duration_seconds);
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(runnerName)) throw new Error("runner_name must be 1-64 letters, digits, dot, underscore or hyphen.");
    if (baseRunnerTags.length > 500 || !/^[A-Za-z0-9_.,:-]*$/.test(baseRunnerTags)) throw new Error("runner_tags contains unsupported characters or is too long.");
    if (!Number.isInteger(duration) || duration < 60 || duration > 20400) throw new Error("duration_seconds must be between 60 and 20400.");
    const runnerTags = isDefaultWorkflow ? baseRunnerTags : appendRoutingTags(baseRunnerTags, ["workflow:" + wfName]);
    const predecessorId = typeof args.predecessor_id === "string" ? args.predecessor_id.trim() : "";
    if (predecessorId && !/^[A-Za-z0-9._:-]{1,128}$/.test(predecessorId)) throw new Error("predecessor_id contains unsupported characters.");
    const generation = args.generation === undefined ? 1 : Number(args.generation);
    if (!Number.isInteger(generation) || generation < 1) throw new Error("generation must be a positive integer.");
    const handoverAfter = args.handover_after === undefined ? undefined : Number(args.handover_after);
    const idleTimeout = args.idle_timeout === undefined ? undefined : Number(args.idle_timeout);
    await runGitHubSecretTool("list_github_secrets", repo, targetAccount.token);
    const wf = await workflow(targetAccount.token, repo, wfName);
    await runGitHubSecretTool("set_github_secret", { ...repo, secret_name: "HUB_URLS", value: values.HUB_URLS }, targetAccount.token);
    await runGitHubSecretTool("set_github_secret", { ...repo, secret_name: "MCP_TOKEN", value: values.MCP_TOKEN }, targetAccount.token);
    for (const key of OPTIONAL_TS_SECRETS) {
      const val = String(targetAccount.localmcpgo_secrets?.[key] || "").trim();
      if (val) await runGitHubSecretTool("set_github_secret", { ...repo, secret_name: key, value: val }, targetAccount.token);
    }
    const repository = await github(targetAccount.token, path);
    const dispatchInputs: Record<string, string> = {
      runner_name: runnerName,
      runner_tags: runnerTags,
      duration_seconds: String(duration),
      runner_os: runnerOs,
      account_alias: targetAlias,
      ...(predecessorId ? { predecessor_id: predecessorId } : {}),
      ...(generation > 1 ? { generation: String(generation) } : {}),
      ...(handoverAfter !== undefined && Number.isInteger(handoverAfter) ? { handover_after: String(handoverAfter) } : {}),
      ...(idleTimeout !== undefined && Number.isInteger(idleTimeout) ? { idle_timeout: String(idleTimeout) } : {})
    };
    await github(targetAccount.token, path + "/actions/workflows/" + encodeURIComponent(wfName) + "/dispatches", { method: "POST", body: JSON.stringify({ ref: String(repository.default_branch || "main"), inputs: dispatchInputs }) });
    const recent = await runs(targetAccount.token, repo, 10, wfName);
    const run = recent.find((item: any) => item.event === "workflow_dispatch" && Date.now() - Date.parse(item.created_at || 0) < 120000);
    const runnerId = run ? (runnerOs === "windows" ? "gh-win-" : "gh-linux-") + run.id : null;
    return { provider: "github", repository: repo.owner + "/" + repo.repo, workflow: wf.path, workflow_file: wfName, dispatched: true, runner_name: runnerName, runner_os: runnerOs, runner_id: runnerId, runner_tags: ["provider:github", "os:" + runnerOs, "account:" + targetAlias, ...(run ? ["run:" + run.id] : []), "name:" + runnerName, ...runnerTags.split(",")], duration_seconds: duration, run: run ? summary(run) : null, workflow_url: "https://github.com/" + repo.owner + "/" + repo.repo + "/actions/workflows/" + wfName };
  }
  const wfName = normalizeGitHubWorkflowFilename(args.workflow);
  if (name === "localmcp_hub_runs") return { provider: "github", repository: repo.owner + "/" + repo.repo, workflow_file: wfName, runs: (await runs(targetAccount.token, repo, 20, wfName)).map(summary) };
  if (name === "localmcp_hub_status") {
    const run = args.run_id ? await github(targetAccount.token, path + "/actions/runs/" + Number(args.run_id)) : (await runs(targetAccount.token, repo, 1, wfName))[0];
    if (!run) return { provider: "github", repository: repo.owner + "/" + repo.repo, status: "not_started" };
    const jobs = await github(targetAccount.token, path + "/actions/runs/" + run.id + "/jobs?per_page=100");
    return { provider: "github", repository: repo.owner + "/" + repo.repo, run: summary(run), jobs: (jobs.jobs || []).map((job: any) => ({ id: job.id, name: job.name, status: job.status, conclusion: job.conclusion, steps: (job.steps || []).map((step: any) => ({ name: step.name, status: step.status, conclusion: step.conclusion })) })) };
  }
  if (name === "localmcp_hub_logs") {
    const run = args.run_id ? { id: Number(args.run_id) } : (await runs(targetAccount.token, repo, 1, wfName))[0];
    if (!run) return { provider: "github", repository: repo.owner + "/" + repo.repo, logs: null, reason: "No Hub workflow runs found." };
    const jobs = await github(targetAccount.token, path + "/actions/runs/" + run.id + "/jobs?per_page=100");
    const logDownloads = [];
    for (const job of jobs.jobs || []) {
      const response = await fetch("https://api.github.com/repos/" + repo.owner + "/" + repo.repo + "/actions/jobs/" + job.id + "/logs", { headers: headers(targetAccount.token), redirect: "manual" });
      logDownloads.push({ job_id: job.id, job_name: job.name, ...(response.headers.get("Location") ? { download_url: response.headers.get("Location") } : { http_status: response.status }) });
    }
    return { provider: "github", repository: repo.owner + "/" + repo.repo, run_id: run.id, jobs: (jobs.jobs || []).map((job: any) => ({ id: job.id, name: job.name, status: job.status, conclusion: job.conclusion, steps: (job.steps || []).map((step: any) => ({ name: step.name, status: step.status, conclusion: step.conclusion })) })), log_downloads: logDownloads, note: "GitHub supplies temporary signed job-log download URLs; they are not stored by the Worker." };
  }
  if (name === "localmcp_hub_stop") {
    const all = args.run_id ? [] : await runs(targetAccount.token, repo, 20, wfName);
    const run = args.run_id ? await github(targetAccount.token, path + "/actions/runs/" + Number(args.run_id)) : all.find((item: any) => ["queued", "in_progress", "waiting", "requested"].includes(item.status));
    if (!run || !["queued", "in_progress", "waiting", "requested"].includes(run.status)) return { provider: "github", repository: repo.owner + "/" + repo.repo, stopped: false, reason: "The requested Hub runner workflow is not active." };
    await github(targetAccount.token, path + "/actions/runs/" + Number(run.id) + "/cancel", { method: "POST" });
    return { provider: "github", repository: repo.owner + "/" + repo.repo, run_id: Number(run.id), cancel_requested: true };
  }
  throw new Error("Unsupported LocalMCP Hub control tool: " + name);
}
