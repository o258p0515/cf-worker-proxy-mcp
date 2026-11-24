import { afterEach, describe, expect, it, vi } from "vitest";
import { runAzureHubTool } from "../src/mcp/azure-devops";

const PAT = "unit-secret-azure-123456789abcdef";
const TOKEN = "unit-hub-secret-0123456789abcdef";
const account: any = {
  username: "aerielaaeriel651971", token: "", description: "Azure account", orgs: ["aerielaaeriel651971"], enabled: true, readonly: false,
  localmcpgo_secrets: { AZURE_DEVOPS_PAT: PAT, AZURE_DEVOPS_ORG_URL: "https://dev.azure.com/aerielaaeriel651971", HUB_URLS: "https://hub.example.test", MCP_TOKEN: TOKEN }
};
function env() {
  const values = new Map<string, string>();
  return { MCP_TOKEN: "proxy-runtime-secret", RTDB_AUTH_URL: "https://unit.firebaseio.com/github_accounts.json?auth=unit", CACHE_KV: { get: async (k: string) => values.get(k) || null, put: async (k: string, v: string) => values.set(k, v), delete: async (k: string) => values.delete(k) } } as any;
}
function discoveryFetch(calls: any[] = []) {
  return vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("unit.firebaseio.com")) return Response.json({ azure: { ...account, localmcpgo_cache: {} } });
    if (url.includes("/_apis/projects")) return Response.json({ value: [{ id: "project-id", name: "Project A" }] });
    if (url.includes("/_apis/git/repositories?") && url.includes("/Project%20A/")) return Response.json({ value: [{ id: "repo-id", name: "runner-config", defaultBranch: "refs/heads/main" }] });
    if (url.includes("/_apis/pipelines") && !url.includes("pipelinepermissions")) return Response.json({ value: [] });
    if (url.includes("localmcpgo_cache.json")) return Response.json({});
    throw new Error("Unexpected Azure test request: " + url);
  });
}
afterEach(() => vi.unstubAllGlobals());

describe("Azure DevOps Hub provider", () => {
  it("discovers projects, repositories and pipelines without returning credentials", async () => {
    const calls: any[] = [];
    vi.stubGlobal("fetch", discoveryFetch(calls));
    const result = await runAzureHubTool("localmcp_hub_check_secrets", { project: "Project A" }, account, "azure", env());
    expect(result).toMatchObject({ provider: "azure", credential_validated: true, selected_project: "Project A", repositories: ["runner-config"] });
    expect(JSON.stringify(result)).not.toContain(PAT);
    expect(calls.find(c => c.url.includes("/_apis/projects")).init.headers.get("Authorization")).toBe("Basic " + btoa(":" + PAT));
    expect(calls.some(c => c.url.includes("localmcpgo_cache.json") && c.init.method === "PUT")).toBe(true);
  });

  it("bootstraps once, caches the new pipeline, stores Hub credentials as secret variables and queues a unique Linux runner", async () => {
    const calls: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
      const url = String(input); calls.push({ url, init });
      if (url.includes("unit.firebaseio.com")) return Response.json({ azure: { ...account, localmcpgo_cache: {} } });
      if (url.includes("/_apis/projects")) return Response.json({ value: [{ id: "project-id", name: "Project A" }] });
      if (url.includes("/refs?filter=heads/main")) return Response.json({ value: [{ name: "refs/heads/main", objectId: "old-object" }] });
      if (url.includes("/_apis/git/repositories?") && url.includes("/Project%20A/")) return Response.json({ value: [{ id: "repo-id", name: "runner-config", defaultBranch: "refs/heads/main" }] });
      if (url.includes("/runs?") && init.method === "POST") return Response.json({ id: 991, state: "running", createdDate: "2026-11-24T12:00:00Z", _links: { web: { href: "https://dev.azure.com/test/run/991" } } });
      if (url.includes("/_apis/pipelines/77?") && init.method !== "POST") return Response.json({ id: 77, name: "LocalMCP Hub Runner", configuration: { type: "yaml", path: "/azure-pipelines.yml", repository: { id: "repo-id" } } });
      if (url.includes("/_apis/pipelines") && !url.includes("pipelinepermissions")) {
        if (init.method === "POST") return Response.json({ id: 77, name: "LocalMCP Hub Runner", url: "https://dev.azure.com/test/pipeline/77" });
        return Response.json({ value: [] });
      }
      if (url.includes("localmcpgo_cache.json")) return Response.json({});
      if (url.includes("/_apis/git/repositories/repo-id/refs")) return Response.json({ value: [{ name: "refs/heads/main", objectId: "old-object" }] });
      if (url.includes("/_apis/git/repositories/repo-id/items")) return Response.json({ message: "Not found" }, { status: 404 });
      if (url.includes("/_apis/git/repositories/repo-id/pushes")) return Response.json({ pushed: true });
      if (url.includes("/_apis/distributedtask/variablegroups") && init.method === "POST") return Response.json({ id: 12, name: "LocalMCP-Hub-azure" });
      if (url.includes("variablegroups?")) return Response.json({ value: [] });
      if (url.includes("pipelinepermissions/variablegroup")) return Response.json({ authorized: true });
      throw new Error("Unexpected Azure test request: " + url);
    }));
    const accountWithoutHubUrl = { ...account, localmcpgo_secrets: { ...account.localmcpgo_secrets, HUB_URLS: "" } };
    const result = await runAzureHubTool("localmcp_hub_start", { project: "Project A", repository: "runner-config", os: "linux", runner_tags: "go,build", duration_seconds: 9000 }, accountWithoutHubUrl, "azure", env());
    expect(result).toMatchObject({ provider: "azure", run_id: 991, runner_id: "az-linux-991", os: "linux", duration_seconds: 3300, state: "running" });
    const yamlPush = calls.find(c => c.url.includes("/_apis/git/repositories/repo-id/pushes"));
    expect(JSON.parse(yamlPush.init.body).commits[0].changes[0].newContent.content).toContain("LOCALMCP_HUB_RUNNER_TEMPLATE: v2");
    expect(JSON.parse(yamlPush.init.body).commits[0].changes[0].newContent.content).toContain("LocalMCP-Hub-azure");
    expect(JSON.parse(yamlPush.init.body).commits[0].changes[0].newContent.content).toContain("$(runner_vm_image)");
    const groupWrite = calls.find(c => c.url.includes("/_apis/distributedtask/variablegroups") && c.init.method === "POST");
    const variables = JSON.parse(groupWrite.init.body).variables;
    expect(variables.MCP_TOKEN).toMatchObject({ value: TOKEN, isSecret: true });
    expect(variables.HUB_URLS).toMatchObject({ value: "https://hub.o258p0515.dpdns.org", isSecret: true });
    const runWrite = calls.find(c => c.url.includes("/runs?") && c.init.method === "POST");
    expect(JSON.parse(runWrite.init.body).variables.runner_os.value).toBe("linux");
    expect(JSON.parse(runWrite.init.body).variables.source_ref.value).toBe("main");
    expect(JSON.parse(runWrite.init.body)).not.toHaveProperty("templateParameters");
    const permissionCall = calls.find(c => c.url.includes("pipelinepermissions/variablegroup"));
    expect(permissionCall.url).toContain("/project-id/_apis/pipelines/pipelinepermissions/variablegroup/12?");
    expect(JSON.stringify(result)).not.toContain(PAT);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    const cacheWrites = calls.filter(c => c.url.includes("localmcpgo_cache.json") && c.init.method === "PUT");
    const persistedCache = JSON.parse(cacheWrites[cacheWrites.length - 1].init.body);
    expect(persistedCache.azure_devops.pipelines["project-id"]).toContainEqual({ id: 77, name: "LocalMCP Hub Runner", folder: undefined, url: "https://dev.azure.com/test/pipeline/77" });
  });

  it("reads bounded log windows without a server-side polling loop", async () => {
    const fp = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("https://dev.azure.com/aerielaaeriel651971\n" + PAT));
    const fingerprint = Array.from(new Uint8Array(fp)).map(v => v.toString(16).padStart(2, "0")).join("");
    const cached = { fingerprint, discovered_at: Date.now(), projects: [{ id: "project-id", name: "Project A" }], repositories: { "project-id": [] }, pipelines: { "project-id": [{ id: 77, name: "LocalMCP Hub Runner" }] } };
    const cachedAccount = { ...account, localmcpgo_cache: { azure_devops: cached } };
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: any) => {
      const url = String(input); calls.push(url);
      if (url.includes("/builds/991/logs/5?")) return new Response("line one\nline two\n", { headers: { "Content-Type": "text/plain" } });
      if (url.includes("/builds/991/logs?")) return Response.json({ value: [{ id: 5, url: "https://dev.azure.com/log/5" }] });
      throw new Error("Unexpected log request: " + url);
    }));
    const list = await runAzureHubTool("localmcp_hub_logs", { project: "Project A", run_id: 991 }, cachedAccount, "azure", env());
    expect(list.logs).toEqual([{ id: 5, url: "https://dev.azure.com/log/5" }]);
    const page = await runAzureHubTool("localmcp_hub_logs", { project: "Project A", run_id: 991, log_id: 5, start_line: 1, end_line: 2 }, cachedAccount, "azure", env());
    expect(page).toMatchObject({ log_id: 5, start_line: 1, lines: ["line one", "line two"] });
    expect(calls.filter(url => url.includes("/logs"))).toHaveLength(2);
  });
  it("joins Azure pipeline status with the live Hub runner registry", async () => {
    const fp = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("https://dev.azure.com/aerielaaeriel651971\n" + PAT));
    const fingerprint = Array.from(new Uint8Array(fp)).map(v => v.toString(16).padStart(2, "0")).join("");
    const cached = { fingerprint, discovered_at: Date.now(), projects: [{ id: "project-id", name: "Project A" }], repositories: { "project-id": [] }, pipelines: { "project-id": [{ id: 77, name: "LocalMCP Hub Runner" }] } };
    const cachedAccount = { ...account, localmcpgo_cache: { azure_devops: cached } };
    vi.stubGlobal("fetch", vi.fn(async (input: any) => {
      const url = String(input);
      if (url.includes("hub.example.test/mcp")) return Response.json({ jsonrpc: "2.0", id: "hub", result: { content: [{ type: "text", text: JSON.stringify({ runners: [{ runner_id: "az-linux-991", status: "online", os: "linux" }] }) }] } });
      if (url.includes("/runs/991?")) return Response.json({ id: 991, state: "inProgress", createdDate: "2026-11-24T12:00:00Z", templateParameters: { os: "linux" } });
      throw new Error("Unexpected status request: " + url);
    }));
    const result = await runAzureHubTool("localmcp_hub_status", { project: "Project A", run_id: 991 }, cachedAccount, "azure", env());
    expect(result).toMatchObject({ run_id: 991, runner_id: "az-linux-991", state: "running", status: "running", runner_online: true, hub_runner: { status: "online" } });
  });

  it("cancels a pipeline run through the verified Build Builds Update API", async () => {
    const fp = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("https://dev.azure.com/aerielaaeriel651971\n" + PAT));
    const fingerprint = Array.from(new Uint8Array(fp)).map(v => v.toString(16).padStart(2, "0")).join("");
    const cached = { fingerprint, discovered_at: Date.now(), projects: [{ id: "project-id", name: "Project A" }], repositories: { "project-id": [] }, pipelines: { "project-id": [{ id: 77, name: "LocalMCP Hub Runner" }] } };
    const cachedAccount = { ...account, localmcpgo_cache: { azure_devops: cached } };
    const calls: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
      const url = String(input); calls.push({ url, init });
      if (url.includes("/runs/991?")) return Response.json({ id: 991, state: "inProgress" });
      if (url.includes("/builds/991/timeline?")) return Response.json({ records: [] });
      if (url.includes("/builds/991") && init.method === "PATCH") return Response.json({ id: 991, status: "cancelling" });
      throw new Error("Unexpected stop request: " + url);
    }));
    const result = await runAzureHubTool("localmcp_hub_stop", { project: "Project A", run_id: 991 }, cachedAccount, "azure", env());
    expect(result).toMatchObject({ run_id: 991, cancel_requested: true });
    const cancel = calls.find(c => c.init.method === "PATCH");
    expect(cancel.url).toContain("/_apis/build/builds/991?");
    expect(JSON.parse(cancel.init.body)).toEqual({ status: "cancelling" });
  });

  it("requires explicit project selection without fanning out API calls across every project", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
      const url = String(input); calls.push(url);
      if (url.includes("unit.firebaseio.com")) return Response.json({ azure: { ...account, localmcpgo_cache: {} } });
      if (url.includes("/_apis/projects")) return Response.json({ value: [{ id: "p1", name: "Project A" }, { id: "p2", name: "Project B" }] });
      if (url.includes("localmcpgo_cache.json")) return Response.json({});
      throw new Error("Unexpected request: " + url);
    }));
    await expect(runAzureHubTool("localmcp_hub_check_secrets", {}, account, "azure", env())).rejects.toThrow(/Choose an Azure DevOps project explicitly/);
    expect(calls.filter(url => url.includes("/_apis/git/repositories") || url.includes("/_apis/pipelines"))).toHaveLength(0);
  });

  it("retries a transient idempotent Azure GET once", async () => {
    let projectCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: any) => {
      const url = String(input);
      if (url.includes("unit.firebaseio.com")) return Response.json({ azure: { ...account, localmcpgo_cache: {} } });
      if (url.includes("/_apis/projects")) {
        projectCalls++;
        if (projectCalls === 1) return Response.json({ message: "temporary upstream failure" }, { status: 503 });
        return Response.json({ value: [{ id: "project-id", name: "Project A" }] });
      }
      if (url.includes("/_apis/git/repositories?")) return Response.json({ value: [{ id: "repo-id", name: "runner-config" }] });
      if (url.includes("/_apis/pipelines")) return Response.json({ value: [] });
      if (url.includes("localmcpgo_cache.json")) return Response.json({});
      throw new Error("Unexpected retry request: " + url);
    }));
    const result = await runAzureHubTool("localmcp_hub_check_secrets", { project: "Project A" }, account, "azure", env());
    expect(result.credential_validated).toBe(true);
    expect(projectCalls).toBe(2);
  });

  it("surfaces Azure rate-limit retry guidance without retrying writes", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: any) => {
      const url = String(input);
      if (url.includes("unit.firebaseio.com")) return Response.json({ azure: { ...account, localmcpgo_cache: {} } });
      if (url.includes("/_apis/projects")) return new Response(JSON.stringify({ message: "rate limit" }), { status: 429, headers: { "Retry-After": "30" } });
      throw new Error("Unexpected rate-limit request: " + url);
    }));
    await expect(runAzureHubTool("localmcp_hub_check_secrets", {}, account, "azure", env())).rejects.toThrow(/HTTP 429.*Retry after 30 seconds/i);
  });

});
  177