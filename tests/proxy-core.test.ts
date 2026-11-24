import { describe, it, expect, vi, afterEach } from "vitest";
import { handleJsonRpcMessage } from "../src/mcp/proxy-core";
import { clearAccountCaches } from "../src/rtdb/account-store";
import { clearUpstreamSessions } from "../src/mcp/upstream-client";

afterEach(() => { vi.unstubAllGlobals(); clearUpstreamSessions(); });
function kv() {
  const values = new Map<string, string>();
  return { get: async (key: string) => values.get(key) ?? null, put: async (key: string, value: string) => { values.set(key, value); }, delete: async (key: string) => { values.delete(key); } } as any;
}
function durableObjects() {
  const values = new Map<string, { alias: string; expiresAt: number }>();
  return {
    idFromName: (name: string) => name,
    get: (id: string) => ({
      fetch: async (_input: any, init: any = {}) => {
        if (init.method === "PUT") {
          const body = JSON.parse(init.body);
          values.set(id, { alias: body.alias, expiresAt: Date.now() + 86400000 });
          return Response.json({ ok: true });
        }
        const saved = values.get(id);
        return Response.json({ alias: saved && saved.expiresAt > Date.now() ? saved.alias : null });
      }
    })
  } as any;
}
function makeEnv() {
  return { MCP_TOKEN: "test-secret", RTDB_AUTH_URL: "https://unit.firebaseio.com/github_accounts.json?auth=x", CACHE_KV: kv(), OAUTH_KV: kv(), SSE_SESSIONS: durableObjects(), GITHUB_MCP_TOOLSETS: "all" } as any;
}
function accountDb() {
  return {
    personal: { username: "me", token: "ghp_personal_token", orgs: ["personal-org"], enabled: true, is_catalog_source: true },
    work: { username: "work", token: "ghp_work_token", orgs: ["work-org"], enabled: true, readonly: true }
  };
}
function upstreamFetch(calls: any[] = []) {
  return vi.fn(async (input: any, init: any) => {
    const url = String(input);
    if (url.includes("unit.firebaseio.com")) return Response.json(accountDb());
    const message = JSON.parse(init.body);
    calls.push({ url, init, message });
    if (message.method === "initialize") return Response.json({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-03-26", serverInfo: { name: "github-mcp-server", version: "test" }, capabilities: { tools: { listChanged: true } } } });
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (message.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "get_me", description: "Official description", inputSchema: { type: "object", properties: { include_organization: { type: "boolean" } }, required: [] } }] } });
    if (message.method === "tools/call") return Response.json({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "official response" }] } });
    if (message.method === "resources/list") return Response.json({ jsonrpc: "2.0", id: message.id, result: { resources: [{ uri: "github://official", name: "Official resource" }] } });
    return Response.json({ jsonrpc: "2.0", id: message.id, result: {} });
  });
}

describe("official GitHub MCP parity", () => {
  it("forwards upstream initialize response unchanged", async () => {
    const env = makeEnv(); await clearAccountCaches(env);
    const fetch = upstreamFetch(); vi.stubGlobal("fetch", fetch);
    const response = await handleJsonRpcMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } } as any, env, { method: "static_token", subject: "test" });
    expect(response.result.serverInfo.name).toBe("github-mcp-server");
    expect(response.result.capabilities).toEqual({ tools: { listChanged: true } });
  });
  it("preserves upstream tool definition and adds proxy controls", async () => {
    const env = makeEnv(); await clearAccountCaches(env); vi.stubGlobal("fetch", upstreamFetch());
    const response = await handleJsonRpcMessage({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} } as any, env, { method: "static_token", subject: "test" });
    expect(response.result.tools[0].name).toBe("get_me");
    expect(response.result.tools.map((tool: any) => tool.name)).toContain("set_github_secret");
    expect(response.result.tools[0].inputSchema.properties.account).toBeUndefined();
  });
  it("exposes a stable Hub call facade without adding runner-specific Hub tools to tools/list", async () => {
    const env = makeEnv(); await clearAccountCaches(env);
    vi.stubGlobal("fetch", upstreamFetch());
    const response = await handleJsonRpcMessage({ jsonrpc: "2.0", id: 19, method: "tools/list", params: {} } as any, env, { method: "static_token", subject: "stable-hub-catalog" });
    const names = response.result.tools.map((tool: any) => tool.name);
    expect(names).toContain("localmcp_hub_tools");
    expect(names).toContain("localmcp_hub_call");
    expect(names).not.toContain("hub__bash");
    expect(names).not.toContain("hub__list_runners");
  });
  it("lists accounts and persists an agent-selected account", async () => {
    const env = makeEnv(); await clearAccountCaches(env); const calls: any[] = []; vi.stubGlobal("fetch", upstreamFetch(calls));
    const ctx = { method: "static_token", subject: "agent-session" } as any;
    const listed = await handleJsonRpcMessage({ jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "list_github_accounts", arguments: {} } } as any, env, ctx);
    expect(listed.result.content[0].text).toContain("personal"); expect(listed.result.content[0].text).not.toContain("ghp_personal_token");
    const selected = await handleJsonRpcMessage({ jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "select_github_account", arguments: { alias: "work" } } } as any, env, ctx);
    expect(selected.result.content[0].text).toContain("work");
    await handleJsonRpcMessage({ jsonrpc: "2.0", id: 22, method: "tools/call", params: { name: "get_me", arguments: {} } } as any, env, ctx);
    expect(calls.find(entry => entry.message.method === "tools/call").init.headers.get("Authorization")).toBe("Bearer ghp_work_token");
  });
  it("isolates selected accounts by authenticated OAuth client", async () => {
    const env = makeEnv(); await clearAccountCaches(env); const calls: any[] = []; vi.stubGlobal("fetch", upstreamFetch(calls));
    const personal = { method: "oauth", subject: "oauth-client-personal" } as any;
    const work = { method: "oauth", subject: "oauth-client-work" } as any;
    await handleJsonRpcMessage({ jsonrpc: "2.0", id: 30, method: "tools/call", params: { name: "select_github_account", arguments: { alias: "personal" } } } as any, env, personal);
    await handleJsonRpcMessage({ jsonrpc: "2.0", id: 31, method: "tools/call", params: { name: "select_github_account", arguments: { alias: "work" } } } as any, env, work);
    await handleJsonRpcMessage({ jsonrpc: "2.0", id: 32, method: "tools/call", params: { name: "get_me", arguments: {} } } as any, env, personal);
    await handleJsonRpcMessage({ jsonrpc: "2.0", id: 33, method: "tools/call", params: { name: "get_me", arguments: {} } } as any, env, work);
    const authorizations = calls.filter(entry => entry.message.method === "tools/call").map(entry => entry.init.headers.get("Authorization"));
    expect(authorizations).toEqual(["Bearer ghp_personal_token", "Bearer ghp_work_token"]);
  });
  it("does not silently use the catalog account for a GitHub tool call without selection", async () => {
    const env = makeEnv(); await clearAccountCaches(env); const calls: any[] = []; vi.stubGlobal("fetch", upstreamFetch(calls));
    const response = await handleJsonRpcMessage({ jsonrpc: "2.0", id: 34, method: "tools/call", params: { name: "get_me", arguments: {} } } as any, env, { method: "oauth", subject: "unselected-client" });
    expect(response.error.message).toContain("No GitHub account is selected");
    expect(calls.some(entry => entry.message.method === "tools/call")).toBe(false);
  });
  it("blocks mutations for read-only accounts", async () => {
    const env = makeEnv(); await clearAccountCaches(env); const calls: any[] = []; vi.stubGlobal("fetch", upstreamFetch(calls));
    const response = await handleJsonRpcMessage({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "set_github_secret", arguments: { owner: "o", repo: "r", secret_name: "X", value: "v" } } } as any, env, { method: "static_token", subject: "test", pinnedAccount: "work" });
    expect(response.result.isError).toBe(true); expect(response.result.content[0].text).toContain("read-only");
    expect(calls.some(entry => entry.message.method === "tools/call")).toBe(false);
  });
  it("serves Proxy controls for an Azure-only account without calling GitHub upstream", async () => {
    const env = makeEnv(); await clearAccountCaches(env);
    const calls: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
      const url = String(input);
      if (url.includes("unit.firebaseio.com")) return Response.json({
        "azure-aerielaaeriel651971": { username: "aerielaaeriel651971", enabled: true, orgs: ["aerielaaeriel651971"], localmcpgo_secrets: { AZURE_DEVOPS_PAT: "unit-secret-azure-abcdef1234567890", AZURE_DEVOPS_ORG_URL: "https://dev.azure.com/aerielaaeriel651971", HUB_URLS: "https://hub.example.com", MCP_TOKEN: "unit-hub-secret-0123456789" } }
      });
      if (url.includes("/localmcpgo_cache.json")) return Response.json({});
      calls.push({ url, init });
      return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
    }));
    const ctx = { method: "static_token", subject: "azure-only-agent" } as any;
    const initialized = await handleJsonRpcMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } } as any, env, ctx);
    expect(initialized.result.serverInfo.name).toBe("cf-worker-proxy-mcp");
    const listed = await handleJsonRpcMessage({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} } as any, env, ctx);
    expect(listed.result.tools.map((tool: any) => tool.name)).toContain("localmcp_hub_logs");
    expect(calls.filter(call => call.url.includes("githubcopilot") || call.url.includes("api.github.com"))).toHaveLength(0);
    const selected = await handleJsonRpcMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "select_github_account", arguments: { alias: "azure-aerielaaeriel651971" } } } as any, env, ctx);
    expect(selected.result.content[0].text).toContain('"azure"');
  });

  it("routes an Azure-only account through the Hub control adapter without GitHub credentials", async () => {
    const env = makeEnv(); await clearAccountCaches(env);
    const calls: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
      const url = String(input); calls.push({ url, init });
      if (url.includes("unit.firebaseio.com")) {
        if (init.method === "PUT") return Response.json({});
        return Response.json({ azure: { username: "azure", enabled: true, readonly: false, orgs: ["example"], localmcpgo_secrets: { AZURE_DEVOPS_PAT: "unit-secret-azure-abcdef1234567890", AZURE_DEVOPS_ORG_URL: "https://dev.azure.com/example", HUB_URLS: "https://hub.example.test", MCP_TOKEN: "unit-hub-secret-0123456789" } } });
      }
      if (url.includes("/_apis/projects")) return Response.json({ value: [{ id: "p1", name: "Project" }] });
      if (url.includes("/_apis/git/repositories")) return Response.json({ value: [{ id: "r1", name: "runner-config", defaultBranch: "refs/heads/main" }] });
      if (url.includes("/_apis/pipelines")) return Response.json({ value: [] });
      throw new Error("Unexpected URL " + url);
    }));
    const response = await handleJsonRpcMessage({ jsonrpc: "2.0", id: 31, method: "tools/call", params: { name: "localmcp_hub_check_secrets", arguments: { provider: "azure", project: "Project" } } } as any, env, { method: "static_token", subject: "azure-agent", pinnedAccount: "azure" } as any);
    const value = JSON.parse(response.result.content[0].text);
    expect(value).toMatchObject({ provider: "azure", account: "azure", credential_validated: true, hub_credentials_ready: true, selected_project: "Project" });
    expect(JSON.stringify(value)).not.toContain("unit-secret-azure-abcdef1234567890");
    expect(calls.some(call => call.url.includes("api.github.com"))).toBe(false);
  });

});
