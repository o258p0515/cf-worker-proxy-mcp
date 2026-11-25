import { afterEach, describe, expect, it, vi } from "vitest";
import { runLocalMcpHubControlTool } from "../src/mcp/localmcp-hub-control";

const secretTool = vi.hoisted(() => vi.fn());
vi.mock("../src/mcp/github-secrets", () => ({ runGitHubSecretTool: secretTool }));
afterEach(() => { vi.unstubAllGlobals(); secretTool.mockReset(); });

const account = {
  username: "o258p0515", token: "github-token", description: "", orgs: [], enabled: true, readonly: false,
  localmcpgo_secrets: { HUB_URLS: "https://hub.example.com", MCP_TOKEN: "shared-token-0123456789abcdef" }
} as any;

describe("separate LocalMCP Hub lifecycle controls", () => {
  it("syncs only Hub credentials and dispatches hub-runner.yml with runner-specific inputs", async () => {
    const calls: Array<{ url: string; init?: any }> = [];
    const fetch = vi.fn(async (input: any, init?: any) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/actions/workflows/hub-runner.yml")) return Response.json({ id: 123, path: ".github/workflows/hub-runner.yml", state: "active" });
      if (url.includes("/actions/workflows/hub-runner.yml/runs")) return Response.json({ workflow_runs: [] });
      if (url === "https://api.github.com/repos/o258p0515/localmcpcoder-go") return Response.json({ default_branch: "main" });
      if (url.endsWith("/dispatches")) return new Response(null, { status: 204 });
      throw new Error("Unexpected request " + url);
    });
    vi.stubGlobal("fetch", fetch);
    secretTool.mockImplementation(async (name: string) => name === "list_github_secrets" ? { secrets: [{ name: "MCP_TOKEN" }] } : { updated: true });
    const result = await runLocalMcpHubControlTool("localmcp_hub_start", { runner_name: "build-01", runner_tags: "linux,go", duration_seconds: 3600 }, account, "", "personal");
    expect(result.dispatched).toBe(true);
    expect(result.runner_name).toBe("build-01");
    expect(secretTool.mock.calls.filter(call => call[0] === "set_github_secret").map(call => call[1].secret_name)).toEqual(["HUB_URLS", "MCP_TOKEN"]);
    expect(secretTool.mock.calls.filter(call => call[0] === "set_github_secret").map(call => call[1].value)).toEqual(["https://hub.example.com", "shared-token-0123456789abcdef"]);
    const dispatch = calls.find(call => call.url.endsWith("/dispatches"));
    expect(JSON.parse(dispatch?.init.body).inputs).toEqual({ runner_name: "build-01", runner_tags: "linux,go", duration_seconds: "3600", runner_os: "linux", account_alias: "personal" });
    expect(dispatch?.init.method).toBe("POST");
  });

  it("reuses the existing Proxy MCP_TOKEN when RTDB keeps only HUB_URLS", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: any) => {
      const url = String(input);
      if (url.endsWith("/actions/workflows/hub-runner.yml")) return Response.json({ id: 123, path: ".github/workflows/hub-runner.yml", state: "active" });
      if (url.includes("/actions/workflows/hub-runner.yml/runs")) return Response.json({ workflow_runs: [] });
      if (url === "https://api.github.com/repos/o258p0515/localmcpcoder-go") return Response.json({ default_branch: "main" });
      if (url.endsWith("/dispatches")) return new Response(null, { status: 204 });
      throw new Error("Unexpected request " + url);
    }));
    secretTool.mockImplementation(async (name: string) => name === "list_github_secrets" ? { secrets: [] } : { updated: true });
    await runLocalMcpHubControlTool("localmcp_hub_start", { runner_name: "fallback-token" }, { ...account, localmcpgo_secrets: { HUB_URLS: "https://hub.example.com" } }, "proxy-runtime-token-0123456789");
    const writes = secretTool.mock.calls.filter(call => call[0] === "set_github_secret");
    expect(writes.map(call => call[1].secret_name)).toEqual(["HUB_URLS", "MCP_TOKEN"]);
    expect(writes[1]?.[1]?.value).toBe("proxy-runtime-token-0123456789");
  });

  it("uses the built-in Hub URL when RTDB and Proxy environment omit HUB_URLS", async () => {
    const calls: Array<{ url: string; init?: any }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: any, init?: any) => {
      const url = String(input); calls.push({ url, init });
      if (url.endsWith("/actions/workflows/hub-runner.yml")) return Response.json({ id: 123, path: ".github/workflows/hub-runner.yml", state: "active" });
      if (url.includes("/actions/workflows/hub-runner.yml/runs")) return Response.json({ workflow_runs: [] });
      if (url === "https://api.github.com/repos/o258p0515/localmcpcoder-go") return Response.json({ default_branch: "main" });
      if (url.endsWith("/dispatches")) return new Response(null, { status: 204 });
      throw new Error("Unexpected request " + url);
    }));
    secretTool.mockImplementation(async (name: string) => name === "list_github_secrets" ? { secrets: [] } : { updated: true });
    await runLocalMcpHubControlTool("localmcp_hub_start", {}, { ...account, localmcpgo_secrets: { MCP_TOKEN: "shared-token-0123456789abcdef" } }, "", "personal");
    const writes = secretTool.mock.calls.filter(call => call[0] === "set_github_secret");
    expect(writes[0]?.[1]?.secret_name).toBe("HUB_URLS");
    expect(writes[0]?.[1]?.value).toBe("https://hub.o258p0515.dpdns.org");
  });

  it("validates runner lifetime and does not dispatch an invalid request", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(runLocalMcpHubControlTool("localmcp_hub_start", { duration_seconds: 999999 }, account))
      .rejects.toThrow(/duration_seconds/);
  });
  it("requires explicit provider selection when an account has both GitHub and Azure credentials", async () => {
    const both = { ...account, localmcpgo_secrets: { ...account.localmcpgo_secrets, AZURE_DEVOPS_PAT: "unit-secret-azure-123456", AZURE_DEVOPS_ORG_URL: "https://dev.azure.com/example" } };
    await expect(runLocalMcpHubControlTool("localmcp_hub_check_secrets", {}, both as any)).rejects.toThrow(/multiple providers.*provider='github'.*provider='azure'/i);
  });

  it("requires explicit provider selection when GitHub and Azure are in separate RTDB accounts, and routes Azure to the Azure account", async () => {
    const azureAccount = {
      username: "aerielaaeriel651971", token: "", description: "", orgs: [], enabled: true, readonly: false,
      localmcpgo_secrets: { AZURE_DEVOPS_PAT: "unit-secret-azure-123456", AZURE_DEVOPS_ORG_URL: "https://dev.azure.com/aerielaaeriel651971", HUB_URLS: "https://hub.example.com", MCP_TOKEN: "shared-token-0123456789abcdef" },
      localmcpgo_cache: {
        azure_devops: {
          fingerprint: "unused", discovered_at: 0, projects: [], repositories: {}, pipelines: {}
        }
      }
    } as any;
    const allAccounts = { personal: account, "azure-aerielaaeriel651971": azureAccount };
    await expect(runLocalMcpHubControlTool("localmcp_hub_start", {}, account, "", "personal", {}, undefined, allAccounts))
      .rejects.toThrow(/multiple providers.*provider='github'.*provider='azure'/i);

    const env = {
      RTDB_AUTH_URL: "https://unit.firebaseio.com/github_accounts.json?auth=unit-secret",
      MCP_TOKEN: "shared-token-0123456789abcdef",
      CACHE_KV: { get: async () => null, put: async () => {}, delete: async () => {} }
    };
    vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
      const url = String(input);
      if (url.includes("unit.firebaseio.com")) {
        if (init.method === "PUT") return Response.json({});
        return Response.json({ personal: account, "azure-aerielaaeriel651971": azureAccount });
      }
      if (url.includes("/_apis/projects")) return Response.json({ value: [{ id: "p1", name: "Project A" }] });
      if (url.includes("/_apis/git/repositories")) return Response.json({ value: [{ id: "r1", name: "runner-config", defaultBranch: "refs/heads/main" }] });
      if (url.includes("/_apis/pipelines")) return Response.json({ value: [] });
      throw new Error("Unexpected URL " + url);
    }));
    const res = await runLocalMcpHubControlTool("localmcp_hub_check_secrets", { provider: "azure", project: "Project A" }, account, "", "personal", env, undefined, allAccounts);
    expect(res).toMatchObject({ provider: "azure", account: "azure-aerielaaeriel651971", selected_project: "Project A" });
  });

  it("runs the single configured provider regardless of what provider argument is passed", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: any) => {
      const url = String(input);
      if (url.includes("/actions/workflows/hub-runner.yml/runs")) return Response.json({ workflow_runs: [] });
      throw new Error("Unexpected URL " + url);
    }));
    const res = await runLocalMcpHubControlTool("localmcp_hub_runs", { provider: "azure" }, account, "", "personal", {}, undefined, { personal: account });
    expect(res).toMatchObject({ provider: "github", repository: "o258p0515/localmcpcoder-go" });
  });

  it("syncs optional Tailscale secrets on GitHub Hub start when configured in RTDB", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: any) => {
      const url = String(input);
      if (url.endsWith("/actions/workflows/hub-runner.yml")) return Response.json({ id: 123, path: ".github/workflows/hub-runner.yml", state: "active" });
      if (url.includes("/actions/workflows/hub-runner.yml/runs")) return Response.json({ workflow_runs: [] });
      if (url === "https://api.github.com/repos/o258p0515/localmcpcoder-go") return Response.json({ default_branch: "main" });
      if (url.endsWith("/dispatches")) return new Response(null, { status: 204 });
      throw new Error("Unexpected request " + url);
    }));
    secretTool.mockImplementation(async (name: string) => name === "list_github_secrets" ? { secrets: [] } : { updated: true });
    const withTs = { ...account, localmcpgo_secrets: { ...account.localmcpgo_secrets, TS_TRUST_CREDS: "tskey-client-id-secret", TS_TAGS: "tag:localmcpcoder" } };
    await runLocalMcpHubControlTool("localmcp_hub_start", { runner_name: "ts-gh" }, withTs, "", "personal");
    const writes = secretTool.mock.calls.filter(call => call[0] === "set_github_secret");
    expect(writes.map(call => call[1].secret_name)).toEqual(["HUB_URLS", "MCP_TOKEN", "TS_TRUST_CREDS", "TS_TAGS"]);
  });

});
