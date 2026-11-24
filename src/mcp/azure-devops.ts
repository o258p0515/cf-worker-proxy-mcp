import type { RtdbAccount } from "../types";
import { setLocalMcpCache } from "../rtdb/account-store";
import type { AuthContext } from "../types";
import { callHubTool, HUB_TOOL_PREFIX } from "./hub";

const API = "7.1";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_LOG_LINES = 500;
type AzureContext = { org: string; pat: string; headers: Headers };
type Project = { id: string; name: string; state?: string };
type Repository = { id: string; name: string; defaultBranch?: string; project?: Project };
type Pipeline = { id: number; name: string; folder?: string; url?: string };
type Discovery = { fingerprint: string; discovered_at: number; projects: Project[]; repositories: Record<string, Repository[]>; pipelines: Record<string, Pipeline[]> };

function secrets(account: RtdbAccount) { return account.localmcpgo_secrets || {}; }
const DEFAULT_HUB_URL = "https://hub.o258p0515.dpdns.org";
function effectiveHubUrls(account: RtdbAccount, env: any) {
  const configured = String(secrets(account).HUB_URLS || "").trim();
  const runtimeDefault = String(env.LOCALMCP_HUB_ORIGIN || "").trim();
  const value = configured || runtimeDefault || DEFAULT_HUB_URL;
  const urls = value.split(",").map((item: string) => item.trim()).filter(Boolean);
  for (const item of urls) {
    const url = new URL(item);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) throw new Error("HUB_URLS must contain HTTPS Hub base URLs.");
    if (url.username || url.password || url.search || url.hash) throw new Error("HUB_URLS must contain clean base URLs.");
  }
  return { value: urls.join(","), source: configured ? "RTDB localmcpgo_secrets" : runtimeDefault ? "Proxy LOCALMCP_HUB_ORIGIN" : "built-in default" };
}
function context(account: RtdbAccount): AzureContext {
  const values = secrets(account);
  const pat = String(values.AZURE_DEVOPS_PAT || "").trim();
  const rawOrg = String(values.AZURE_DEVOPS_ORG_URL || "").trim();
  if (!pat || !rawOrg) throw new Error("Azure DevOps account requires AZURE_DEVOPS_PAT and AZURE_DEVOPS_ORG_URL in RTDB localmcpgo_secrets.");
  let url: URL;
  try { url = new URL(rawOrg); } catch { throw new Error("AZURE_DEVOPS_ORG_URL must be a valid Azure DevOps organization URL."); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("AZURE_DEVOPS_ORG_URL must be a clean HTTPS organization URL.");
  const match = url.hostname === "dev.azure.com" ? url.pathname.match(/^\/([A-Za-z0-9_.-]+)\/?$/) : url.hostname.endsWith(".visualstudio.com") ? [null, url.hostname.split(".")[0]] : null;
  if (!match?.[1]) throw new Error("AZURE_DEVOPS_ORG_URL must look like https://dev.azure.com/{organization}.");
  return { org: "https://dev.azure.com/" + encodeURIComponent(match[1]), pat, headers: new Headers({ Authorization: "Basic " + btoa(":" + pat), Accept: "application/json", "Content-Type": "application/json" }) };
}
function safeError(status: number, body: any, retryAfter?: string | null) {
  const message = typeof body?.message === "string" ? body.message : typeof body?.typeKey === "string" ? body.typeKey : "Azure DevOps request failed";
  const retry = retryAfter && /^\d+$/.test(retryAfter) ? " Retry after " + retryAfter + " seconds." : "";
  return new Error("Azure DevOps API returned HTTP " + status + ": " + message.replace(/(?:PAT|token|password)\s*[:=]\s*\S+/ig, "[REDACTED]").slice(0, 400) + retry);
}
async function request(ctx: AzureContext, path: string, init: RequestInit = {}, apiVersion = API): Promise<any> {
  const url = ctx.org + path + (path.includes("?") ? "&" : "?") + "api-version=" + apiVersion;
  const method = String(init.method || "GET").toUpperCase();
  const attempts = method === "GET" ? 2 : 1;
  let response: Response | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      response = await fetch(url, { ...init, headers: new Headers({ ...Object.fromEntries(ctx.headers), ...Object.fromEntries(new Headers(init.headers || {})) }), signal: AbortSignal.timeout(15000) });
    } catch (error) {
      if (attempt + 1 < attempts) { await new Promise(resolve => setTimeout(resolve, 200)); continue; }
      throw new Error("Azure DevOps network request failed: " + (error instanceof Error ? error.message : "network interruption") + ". Retry the operation; non-idempotent pipeline creation and queue requests are never retried automatically.");
    }
    if (attempt + 1 < attempts && [502, 503, 504].includes(response.status)) { await response.body?.cancel(); await new Promise(resolve => setTimeout(resolve, 200)); continue; }
    break;
  }
  if (!response) throw new Error("Azure DevOps returned no HTTP response.");
  const contentType = String(response.headers.get("Content-Type") || "").toLowerCase();
  if (response.status === 203 || contentType.includes("text/html")) {
    await response.body?.cancel();
    throw new Error("Azure DevOps returned an authentication redirect or HTML login page (HTTP " + response.status + "). Verify AZURE_DEVOPS_PAT, organization access, and PAT scopes; no response body or credential was logged.");
  }
  if (response.status === 204) return null;
  const raw = await response.text();
  let body: any = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = raw; }
  if (!response.ok) throw safeError(response.status, body, response.headers.get("Retry-After"));
  return body;
}
async function fingerprint(ctx: AzureContext) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ctx.org + "\n" + ctx.pat));
  return Array.from(new Uint8Array(digest)).map(v => v.toString(16).padStart(2, "0")).join("");
}
function projectName(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
function chooseProject(projects: Project[], requested: unknown): Project {
  const name = projectName(requested);
  if (name) {
    const found = projects.find(p => p.name.toLowerCase() === name.toLowerCase() || p.id === name);
    if (!found) throw new Error("Azure DevOps project '" + name + "' was not found. Available projects: " + projects.map(p => p.name).join(", "));
    return found;
  }
  if (projects.length !== 1) throw new Error("Choose an Azure DevOps project explicitly. Available projects: " + projects.map(p => p.name).join(", "));
  return projects[0]!;
}
function chooseRepository(repositories: Repository[], requested: unknown): Repository {
  const name = projectName(requested);
  if (name) {
    const found = repositories.find(r => r.name.toLowerCase() === name.toLowerCase() || r.id === name);
    if (!found) throw new Error("Azure DevOps repository '" + name + "' was not found. Available repositories: " + repositories.map(r => r.name).join(", "));
    return found;
  }
  if (repositories.length !== 1) throw new Error("Choose an Azure DevOps repository explicitly. Available repositories: " + repositories.map(r => r.name).join(", "));
  return repositories[0]!;
}
async function discover(ctx: AzureContext, account: RtdbAccount, alias: string, env: any): Promise<Discovery> {
  const fp = await fingerprint(ctx);
  const cached = account.localmcpgo_cache?.azure_devops as Discovery | undefined;
  if (cached && cached.fingerprint === fp && Date.now() - Number(cached.discovered_at || 0) < CACHE_TTL_MS && Array.isArray(cached.projects)) return cached;
  const projectsData = await request(ctx, "/_apis/projects?$top=100&stateFilter=wellFormed");
  const projects: Project[] = (projectsData.value || []).map((p: any) => ({ id: String(p.id), name: String(p.name), state: p.state }));
  const value: Discovery = { fingerprint: fp, discovered_at: Date.now(), projects, repositories: {}, pipelines: {} };
  await setLocalMcpCache(env, alias, { ...(account.localmcpgo_cache || {}), azure_devops: value });
  return value;
}
async function ensureProjectResources(ctx: AzureContext, account: RtdbAccount, alias: string, env: any, discovery: Discovery, project: Project) {
  if (Array.isArray(discovery.repositories[project.id]) && Array.isArray(discovery.pipelines[project.id])) return;
  const [reposData, pipelinesData] = await Promise.all([
    request(ctx, "/" + encodeURIComponent(project.name) + "/_apis/git/repositories"),
    request(ctx, "/" + encodeURIComponent(project.name) + "/_apis/pipelines")
  ]);
  discovery.repositories[project.id] = (reposData.value || []).map((r: any) => ({ id: String(r.id), name: String(r.name), defaultBranch: String(r.defaultBranch || "refs/heads/main"), project }));
  discovery.pipelines[project.id] = (pipelinesData.value || []).map((p: any) => ({ id: Number(p.id), name: String(p.name), folder: p.folder, url: p.url }));
  await setLocalMcpCache(env, alias, { ...(account.localmcpgo_cache || {}), azure_devops: discovery });
}

function yamlForRunner(alias: string) {
  return `# LOCALMCP_HUB_RUNNER_TEMPLATE: v2
variables:
  - group: LocalMCP-Hub-${alias}
  - name: runner_os
    value: linux
  - name: runner_vm_image
    value: ubuntu-latest
  - name: runner_name
    value: localmcp
  - name: runner_tags
    value: go
  - name: duration_seconds
    value: 3000
  - name: source_ref
    value: main
jobs:
  - job: localmcp_runner
    displayName: LocalMCP Hub runner ($(runner_os))
    timeoutInMinutes: 60
    pool:
      vmImage: $(runner_vm_image)
    steps:
      - checkout: self
      - bash: git clone --depth 1 --branch "$(source_ref)" https://github.com/o258p0515/localmcpcoder-go.git "$(Agent.TempDirectory)/localmcpcoder-go"
        displayName: Checkout LocalMCP Go source
      - task: GoTool@0
        inputs:
          version: '1.23.x'
      - script: go test ./...
        workingDirectory: $(Agent.TempDirectory)/localmcpcoder-go/go
        displayName: Go tests
      - script: go build -trimpath -o $(Agent.TempDirectory)/localmcpcoder-mcp ./cmd/mcp
        workingDirectory: $(Agent.TempDirectory)/localmcpcoder-go/go
        displayName: Build runner
        condition: eq(variables['runner_os'], 'linux')
      - powershell: go build -trimpath -o $(Agent.TempDirectory)\localmcpcoder-mcp.exe ./cmd/mcp
        workingDirectory: $(Agent.TempDirectory)/localmcpcoder-go/go
        displayName: Build Windows runner
        condition: eq(variables['runner_os'], 'windows')
      - bash: |
          set -euo pipefail
          RUNNER_ID=az-$(runner_os)-$(Build.BuildId)
          TAGS="provider:azure,os:$(runner_os),account:${alias},run:$(Build.BuildId),name:$(runner_name),$(runner_tags)"
          timeout --signal=TERM --kill-after=20s "$(duration_seconds)s" \
            "$(Agent.TempDirectory)/localmcpcoder-mcp" --root "$(Agent.TempDirectory)/mcp-root" --tunnel hub \
            --hub-urls "$HUB_URLS" --runner-id "$RUNNER_ID" --runner-tags "$TAGS"
        displayName: Start Linux Hub runner
        condition: eq(variables['runner_os'], 'linux')
        env:
          HUB_URLS: $(HUB_URLS)
          MCP_TOKEN: $(MCP_TOKEN)
      - powershell: |
          $ErrorActionPreference = 'Stop'
          $runnerId = 'az-$(runner_os)-$(Build.BuildId)'
          $tags = 'provider:azure,os:$(runner_os),account:${alias},run:$(Build.BuildId),name:$(runner_name),$(runner_tags)'
          $env:HUB_URLS = '$(HUB_URLS)'
          $env:MCP_TOKEN = '$(MCP_TOKEN)'
          $p = Start-Process -FilePath '$(Agent.TempDirectory)\localmcpcoder-mcp.exe' -ArgumentList @('--root', '$(Agent.TempDirectory)\mcp-root', '--tunnel', 'hub', '--hub-urls', $env:HUB_URLS, '--runner-id', $runnerId, '--runner-tags', $tags) -PassThru -NoNewWindow
          $deadline = (Get-Date).AddSeconds([int]'$(duration_seconds)')
          while (-not $p.HasExited -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2; $p.Refresh() }
          if (-not $p.HasExited) { try { Invoke-RestMethod -Uri 'http://127.0.0.1:8787/internal/shutdown' -Method Post -Headers @{ Authorization = "Bearer $env:MCP_TOKEN" } | Out-Null } catch { Write-Warning 'Graceful runner shutdown request failed.' }; if (-not $p.WaitForExit(35000)) { Stop-Process -Id $p.Id -Force; Write-Warning 'Runner did not drain before the shutdown deadline.' } }
          elseif ($p.ExitCode -ne 0) { throw "Runner exited with code $($p.ExitCode)" }
        displayName: Start Windows Hub runner
        condition: eq(variables['runner_os'], 'windows')
        env:
          HUB_URLS: $(HUB_URLS)
          MCP_TOKEN: $(MCP_TOKEN)
`;
}
async function ensureRunnerYaml(ctx: AzureContext, project: Project, repository: Repository, alias: string) {
  const branch = (repository.defaultBranch || "refs/heads/main").replace(/^refs\\/heads\\//, "");
  const refs = await request(ctx, "/" + encodeURIComponent(project.name) + "/_apis/git/repositories/" + repository.id + "/refs?filter=heads/" + encodeURIComponent(branch));
  const ref = (refs.value || []).find((v: any) => v.name === "refs/heads/" + branch);
  if (!ref?.objectId) throw new Error("Could not resolve default branch '" + branch + "' for Azure Repos repository '" + repository.name + "'.");
  let existing: any = null;
  try {
    existing = await request(ctx, "/" + encodeURIComponent(project.name) + "/_apis/git/repositories/" + repository.id + "/items?path=%2Fazure-pipelines.yml&includeContent=true&versionDescriptor.version=" + encodeURIComponent(branch) + "&versionDescriptor.versionType=branch");
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("HTTP 404")) throw error;
  }
  const yaml = yamlForRunner(alias);
  if (existing && (typeof existing.content !== "string" || !existing.content.includes("LOCALMCP_HUB_RUNNER_TEMPLATE: v1") && !existing.content.includes("LOCALMCP_HUB_RUNNER_TEMPLATE: v2"))) {
    throw new Error("Azure Repos already contains /azure-pipelines.yml, but it is not managed by LocalMCP Hub. The file was not overwritten; choose another repository or integrate the runner YAML manually.");
  }
  if (existing?.content === yaml) return;
  await request(ctx, "/" + encodeURIComponent(project.name) + "/_apis/git/repositories/" + repository.id + "/pushes", {
    method: "POST",
    body: JSON.stringify({ refUpdates: [{ name: "refs/heads/" + branch, oldObjectId: ref.objectId }], commits: [{ comment: "ci: update LocalMCP Hub Azure Pipelines runner template v2", changes: [{ changeType: existing ? "edit" : "add", item: { path: "/azure-pipelines.yml" }, newContent: { content: yaml, contentType: "rawtext" } }] }] })
  });
}
async function bootstrap(ctx: AzureContext, project: Project, repository: Repository, alias: string, pipelineName = "LocalMCP Hub Runner"): Promise<Pipeline> {
  await ensureRunnerYaml(ctx, project, repository, alias);
  const created = await request(ctx, "/" + encodeURIComponent(project.name) + "/_apis/pipelines", { method: "POST", body: JSON.stringify({ name: pipelineName, folder: "\\\\", configuration: { type: "yaml", path: "/azure-pipelines.yml", repository: { id: repository.id, name: repository.name, type: "azureReposGit" } } }) });
  return { id: Number(created.id), name: String(created.name), folder: created.folder, url: created.url };
}
async function validateRunnerPipeline(ctx: AzureContext, project: Project, pipeline: Pipeline, repository: Repository) {
  const detail = await request(ctx, "/" + encodeURIComponent(project.name) + "/_apis/pipelines/" + pipeline.id);
  const configuration = detail.configuration || {};
  if (configuration.type !== "yaml" || configuration.path !== "/azure-pipelines.yml" || String(configuration.repository?.id || "") !== repository.id) {
    throw new Error("Azure Pipeline '" + pipeline.name + "' already exists but is not the LocalMCP Hub runner pipeline for repository '" + repository.name + "'. Choose another pipeline name or repository; the existing pipeline was not modified.");
  }
  return pipeline;
}
async function ensureVariableGroup(ctx: AzureContext, project: Project, alias: string, hubUrls: string, token: string, pipelineId: number) {
  const groupName = "LocalMCP-Hub-" + alias.replace(/[^A-Za-z0-9_.-]/g, "-");
  const query = await request(ctx, "/_apis/distributedtask/variablegroups?groupName=" + encodeURIComponent(groupName) + "&projectIds=" + encodeURIComponent(project.id), {}, "7.1");
  let group = (query.value || []).find((v: any) => v.name === groupName);
  const payload = { name: groupName, type: "Vsts", description: "LocalMCP Hub runtime credentials for account " + alias, variables: { HUB_URLS: { value: hubUrls, isSecret: true }, MCP_TOKEN: { value: token, isSecret: true } }, variableGroupProjectReferences: [{ name: groupName, projectReference: { id: project.id, name: project.name } }] };
  if (group) group = await request(ctx, "/_apis/distributedtask/variablegroups/" + group.id, { method: "PUT", body: JSON.stringify({ ...group, ...payload }) }, "7.1");
  else group = await request(ctx, "/_apis/distributedtask/variablegroups", { method: "POST", body: JSON.stringify(payload) }, "7.1");
  await request(ctx, "/" + encodeURIComponent(project.id) + "/_apis/pipelines/pipelinepermissions/variablegroup/" + group.id, { method: "PATCH", body: JSON.stringify({ pipelines: [{ id: pipelineId, authorized: true }] }) }, "7.1-preview.1");
  return { id: Number(group.id), name: groupName, secret_values_returned: false, authorized: true, pipeline_id: pipelineId };
}
function pipelineStatus(run: any) {
  const rawState = String(run.state || "unknown").toLowerCase();
  const state = rawState === "inprogress" ? "running" : rawState === "canceling" ? "cancelling" : rawState;
  const result = String(run.result || "").toLowerCase();
  return { id: Number(run.id), name: run.name, state, result: result || null, status: state === "completed" ? (result || "completed") : state, created_at: run.createdDate, finished_at: run.finishedDate, url: run._links?.web?.href || run.url };
}
async function findHubRunner(account: RtdbAccount, env: any, authContext: AuthContext, runnerId: string) {
  try {
    const hub = await callHubTool(HUB_TOOL_PREFIX + "list_runners", {}, account, authContext, String(secrets(account).MCP_TOKEN || env.MCP_TOKEN || ""), env.LOCALMCP_HUB, env.LOCALMCP_HUB_ORIGIN);
    let parsed: any = hub;
    if (Array.isArray(hub?.content)) {
      const text = hub.content.find((item: any) => item.type === "text")?.text;
      if (typeof text === "string") { try { parsed = JSON.parse(text); } catch { parsed = {}; } }
    }
    const runners = Array.isArray(parsed?.runners) ? parsed.runners : Array.isArray(parsed) ? parsed : [];
    const runner = runners.find((item: any) => item.runner_id === runnerId) || null;
    return { online: !!runner && String(runner.status || "").toLowerCase() === "online", runner, error: undefined as string | undefined };
  } catch (error) {
    return { online: null as boolean | null, runner: null, error: error instanceof Error ? error.message : "Hub status unavailable" };
  }
}
async function timelineRecords(ctx: AzureContext, project: Project, runId: number) {
  try {
    const timeline = await request(ctx, "/" + encodeURIComponent(project.name) + "/_apis/build/builds/" + runId + "/timeline");
    return Array.isArray(timeline.records) ? timeline.records : [];
  } catch { return []; }
}
function timelineSummary(records: any[]) {
  return records.filter(record => ["Job", "Task"].includes(String(record.type))).map(record => ({
    id: record.id, parent_id: record.parentId, type: record.type, name: record.name,
    state: record.state, result: record.result, log_id: record.log?.id,
    error_count: record.errorCount || 0,
    errors: Array.isArray(record.issues) ? record.issues.filter((issue: any) => issue.type === "error").map((issue: any) => String(issue.message || "").slice(0, 500)) : []
  }));
}

async function runAzureHubToolInternal(name: string, args: Record<string, unknown>, account: RtdbAccount, alias: string, env: any, authContext: AuthContext) {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(alias)) throw new Error("Azure account alias must contain only letters, digits, dot, underscore or hyphen (maximum 64 characters) so it can be used safely as a Variable Group name.");
  const ctx = context(account);
  const discovery = await discover(ctx, account, alias, env);
  const project = chooseProject(discovery.projects, args.project);
  await ensureProjectResources(ctx, account, alias, env, discovery, project);
  const repositories = discovery.repositories[project.id] || [];
  if (name === "localmcp_hub_check_secrets") {
    const hubUrlConfig = effectiveHubUrls(account, env);
    const hubUrls = hubUrlConfig.value;
    const hubToken = String(secrets(account).MCP_TOKEN || env.MCP_TOKEN || "").trim();
    return { provider: "azure", account: alias, organization: ctx.org, projects: discovery.projects.map(p => p.name), selected_project: project.name, repositories: repositories.map(r => r.name), pipelines: (discovery.pipelines[project.id] || []).map(p => ({ id: p.id, name: p.name })), credential_validated: true, hub_credentials_ready: !!hubUrls && hubToken.length >= 16, hub_urls_source: hubUrlConfig.source, missing_hub_secrets: [!hubUrls ? "HUB_URLS" : null, hubToken.length < 16 ? "MCP_TOKEN" : null].filter(Boolean), token_source: secrets(account).MCP_TOKEN ? "RTDB localmcpgo_secrets" : hubToken ? "Proxy runtime MCP_TOKEN" : null, credential_values_returned: false, cache: { discovered_at: new Date(discovery.discovered_at).toISOString(), ttl_seconds: CACHE_TTL_MS / 1000 } };
  }
  if (name === "localmcp_hub_start") {
    const repo = chooseRepository(repositories, args.repository);
    const pipelineList = discovery.pipelines[project.id] || [];
    const pipelineName = typeof args.pipeline === "string" && args.pipeline.trim() ? args.pipeline.trim() : "LocalMCP Hub Runner";
    let pipeline = args.pipeline_id ? pipelineList.find(p => p.id === Number(args.pipeline_id)) : pipelineList.find(p => p.name === pipelineName);
    if (!pipeline) {
      pipeline = await bootstrap(ctx, project, repo, alias, pipelineName);
      await validateRunnerPipeline(ctx, project, pipeline, repo);
      discovery.pipelines[project.id] = [...pipelineList, pipeline];
      await setLocalMcpCache(env, alias, { ...(account.localmcpgo_cache || {}), azure_devops: discovery });
    } else await validateRunnerPipeline(ctx, project, pipeline, repo);
    await ensureRunnerYaml(ctx, project, repo, alias);
    const os = args.os === "windows" ? "windows" : "linux";
    const requestedDuration = Number(args.duration_seconds ?? 3000);
    if (!Number.isInteger(requestedDuration) || requestedDuration < 60) throw new Error("duration_seconds must be an integer of at least 60 seconds.");
    const duration = Math.min(3300, requestedDuration);
    const runnerName = typeof args.runner_name === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(args.runner_name) ? args.runner_name : "localmcp";
    const runnerTags = typeof args.runner_tags === "string" && /^[A-Za-z0-9_:.,-]{1,300}$/.test(args.runner_tags) ? args.runner_tags : "go";
    const hubUrlConfig = effectiveHubUrls(account, env);
    const hubUrls = hubUrlConfig.value;
    const token = String(secrets(account).MCP_TOKEN || env.MCP_TOKEN || "").trim();
    if (!hubUrls || token.length < 16) throw new Error("Azure runner requires an effective Hub URL and MCP_TOKEN in RTDB or Proxy runtime.");
    const variableGroup = await ensureVariableGroup(ctx, project, alias, hubUrls, token, pipeline.id);
    const run = await request(ctx, "/" + encodeURIComponent(project.name) + "/_apis/pipelines/" + pipeline.id + "/runs", { method: "POST", body: JSON.stringify({ resources: { repositories: { self: { refName: repo.defaultBranch || "refs/heads/main" } } }, variables: { runner_os: { value: os }, runner_vm_image: { value: os === "windows" ? "windows-latest" : "ubuntu-latest" }, runner_name: { value: runnerName }, runner_tags: { value: runnerTags }, duration_seconds: { value: String(duration) }, source_ref: { value: typeof args.source_ref === "string" && /^[A-Za-z0-9_./-]{1,128}$/.test(args.source_ref) ? args.source_ref : "main" } } }) });
    const runId = Number(run.id);
    const runnerId = (os === "windows" ? "az-win-" : "az-linux-") + runId;
    const hubState = await findHubRunner(account, env, authContext, runnerId);
    const runStatus = pipelineStatus(run);
    return { provider: "azure", account: alias, project: project.name, repository: repo.name, pipeline: { id: pipeline.id, name: pipeline.name }, variable_group: variableGroup, run_id: runId, runner_id: runnerId, os, runner_name: runnerName, runner_tags: ["provider:azure", "os:" + os, "account:" + alias, "run:" + runId, "name:" + runnerName, ...runnerTags.split(",")], duration_seconds: duration, ...runStatus, status: runStatus.state === "running" && !hubState.online ? "queued" : runStatus.status, runner_online: hubState.online, hub_runner: hubState.runner, ...(hubState.error ? { hub_error: hubState.error } : {}), workflow_url: run._links?.web?.href || run.url };
  }
  const pipelineList = discovery.pipelines[project.id] || [];
  const pipeline = args.pipeline_id
    ? pipelineList.find(p => p.id === Number(args.pipeline_id))
    : pipelineList.find(p => p.name === (typeof args.pipeline === "string" ? args.pipeline : "LocalMCP Hub Runner"));
  if (!pipeline && name !== "localmcp_hub_runs") throw new Error("LocalMCP Hub Azure Pipeline was not found. Start a runner with a selected repository to bootstrap it.");
  if (name === "localmcp_hub_runs") {
    const selected = pipeline ? [pipeline] : pipelineList;
    const values = await Promise.all(selected.map(async p => {
      const data = await request(ctx, "/" + encodeURIComponent(project.name) + "/_apis/pipelines/" + p.id + "/runs?$top=20");
      return (data.value || []).map((run: any) => ({ pipeline_id: p.id, pipeline_name: p.name, ...pipelineStatus(run) }));
    }));
    return { provider: "azure", account: alias, project: project.name, runs: values.flat() };
  }
  const runId = Number(args.run_id);
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error("run_id must be a positive Azure Pipeline run ID.");
  if (name === "localmcp_hub_status") {
    const run = await request(ctx, "/" + encodeURIComponent(project.name) + "/_apis/pipelines/" + pipeline!.id + "/runs/" + runId);
    const runnerId = typeof args.runner_id === "string" && /^az-(?:linux|win)-[A-Za-z0-9-]+$/.test(args.runner_id)
      ? args.runner_id
      : (String(run.templateParameters?.os || "linux") === "windows" ? "az-win-" : "az-linux-") + runId;
    const hubState = await findHubRunner(account, env, authContext, runnerId);
    const runStatus = pipelineStatus(run);
    const effectiveStatus = runStatus.state === "running" && !hubState.online ? "queued" : runStatus.status;
    const records = await timelineRecords(ctx, project, runId);
    return { provider: "azure", account: alias, project: project.name, pipeline_id: pipeline!.id, run_id: runId, runner_id: runnerId, ...runStatus, status: effectiveStatus, runner_online: hubState.online, runner_never_connected: runStatus.state === "completed" && !hubState.runner, hub_runner: hubState.runner, timeline: timelineSummary(records), ...(hubState.error ? { hub_error: hubState.error } : {}), note: "Azure Pipeline state and Hub runner registration are joined at read time; only a registered online Hub runner is ready for MCP execution." };
  }
  if (name === "localmcp_hub_stop") {
    const run = await request(ctx, "/" + encodeURIComponent(project.name) + "/_apis/pipelines/" + pipeline!.id + "/runs/" + runId);
    if (String(run.state).toLowerCase() === "completed") return { provider: "azure", run_id: runId, cancel_requested: false, reason: "Pipeline run is already completed." };
    await request(ctx, "/" + encodeURIComponent(project.name) + "/_apis/build/builds/" + runId, { method: "PATCH", body: JSON.stringify({ status: "cancelling" }) });
    return { provider: "azure", run_id: runId, cancel_requested: true };
  }
  if (name === "localmcp_hub_logs") {
    const logId = Number(args.log_id);
    if (!Number.isSafeInteger(logId) || logId <= 0) {
      const [logs, records] = await Promise.all([
        request(ctx, "/" + encodeURIComponent(project.name) + "/_apis/build/builds/" + runId + "/logs"),
        timelineRecords(ctx, project, runId)
      ]);
      return { provider: "azure", account: alias, project: project.name, pipeline_id: pipeline!.id, run_id: runId, logs: logs.value || [], timeline: timelineSummary(records), note: "Supply log_id to read log content. Logs are fetched statelessly in bounded line ranges; timeline entries identify the job and step associated with each log." };
    }
    const startLine = Math.max(1, Math.floor(Number(args.start_line || 1)));
    const endLine = Math.min(startLine + MAX_LOG_LINES - 1, Math.max(startLine, Math.floor(Number(args.end_line || startLine + MAX_LOG_LINES - 1))));
    const [content, records] = await Promise.all([
      request(ctx, "/" + encodeURIComponent(project.name) + "/_apis/build/builds/" + runId + "/logs/" + logId + "?startLine=" + startLine + "&endLine=" + endLine),
      timelineRecords(ctx, project, runId)
    ]);
    const text = typeof content === "string" ? content : JSON.stringify(content);
    const lines = text.replace(/\r?\n$/, "").split(/\r?\n/).filter((line: string) => line.length > 0);
    const requestedLines = endLine - startLine + 1;
    const hasMore = lines.length >= requestedLines;
    const record = records.find((item: any) => Number(item.log?.id) === logId);
    const parent = record?.parentId ? records.find((item: any) => item.id === record.parentId) : undefined;
    return { provider: "azure", account: alias, project: project.name, pipeline_id: pipeline!.id, run_id: runId, log_id: logId, job_id: parent?.id || (record?.type === "Job" ? record.id : null), job_name: parent?.name || (record?.type === "Job" ? record.name : null), step_name: record?.type === "Task" ? record.name : null, step_result: record?.result || null, errors: Array.isArray(record?.issues) ? record.issues.filter((issue: any) => issue.type === "error").map((issue: any) => String(issue.message || "").slice(0, 500)) : [], start_line: startLine, end_line: endLine, lines, nextStartLine: hasMore ? endLine + 1 : null, next_start_line: hasMore ? endLine + 1 : null, complete: !hasMore };
  }
  throw new Error("Unsupported Azure DevOps Hub operation: " + name);
}

export async function runAzureHubTool(name: string, args: Record<string, unknown>, account: RtdbAccount, alias: string, env: any, authContext: AuthContext = { method: "static_token", subject: "azure-hub-control" }) {
  try {
    return await runAzureHubToolInternal(name, args, account, alias, env, authContext);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/HTTP (401|403|404)\b/.test(message)) {
      try { await setLocalMcpCache(env, alias, { ...(account.localmcpgo_cache || {}), azure_devops: null }); } catch { /* Preserve the original Azure API error. */ }
    }
    throw error;
  }
}
  306