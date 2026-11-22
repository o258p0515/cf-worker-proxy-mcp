import { describe, it, expect, vi, afterEach } from "vitest";
import { handleJsonRpcMessage } from "../src/mcp/proxy-core";
import { clearAccountCaches } from "../src/rtdb/account-store";
import { clearUpstreamSessions } from "../src/mcp/upstream-client";

afterEach(() => { vi.unstubAllGlobals(); clearUpstreamSessions(); });
function kv() {
  const values = new Map<string, string>();
  return { get: async (key: string) => values.get(key) ?? null, put: async (key: string, value: string) => { values.set(key, value); }, delete: async (key: string) => { values.delete(key); } } as any;
}
function makeEnv() {
  return { MCP_TOKEN: "test-secret", RTDB_AUTH_URL: "https://unit.firebaseio.com/github_accounts.json?auth=x", CACHE_KV: kv(), OAUTH_KV: kv(), GITHUB_MCP_TOOLSETS: "all" } as any;
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

  it("preserves every upstream tool definition and adds only account controls", async () => {
    const env = makeEnv(); await clearAccountCaches(env);
    vi.stubGlobal("fetch", upstreamFetch());
    const response = await handleJsonRpcMessage({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} } as any, env, { method: "static_token", subject: "test" });
    expect(response.result.tools[0]).toEqual({ name: "get_me", description: "Official description", inputSchema: { type: "object", properties: { include_organization: { type: "boolean" } }, required: [] } });
    expect(response.result.tools.map((tool: any) => tool.name)).toEqual(["get_me", "list_github_accounts", "select_github_account"]);
    expect(response.result.tools[0].inputSchema.properties.account).toBeUndefined();
  });

  it("lists accounts and persists an agent-selected account for subsequent official tools", async () => {
    const env = makeEnv(); await clearAccountCaches(env);
    const calls: any[] = []; vi.stubGlobal("fetch", upstreamFetch(calls));
    const ctx = { method: "static_token", subject: "agent-session" } as any;
    const listed = await handleJsonRpcMessage({ jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "list_github_accounts", arguments: {} } } as any, env, ctx);
    expect(listed.result.content[0].text).toContain("personal");
    expect(listed.result.content[0].text).not.toContain("ghp_personal_token");
    const selected = await handleJsonRpcMessage({ jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "select_github_account", arguments: { alias: "work" } } } as any, env, ctx);
    expect(selected.result.content[0].text).toContain("work");
    await handleJsonRpcMessage({ jsonrpc: "2.0", id: 22, method: "tools/call", params: { name: "get_me", arguments: {} } } as any, env, ctx);
    const call = calls.find(entry => entry.message.method === "tools/call");
    expect(call.init.headers.get("Authorization")).toBe("Bearer ghp_work_token");
  });

  it("uses X-GitHub-Account selection and forwards original tool arguments unchanged", async () => {
    const env = makeEnv(); await clearAccountCaches(env);
    const calls: any[] = []; vi.stubGlobal("fetch", upstreamFetch(calls));
    const response = await handleJsonRpcMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_me", arguments: { include_organization: true } } } as any, env, { method: "static_token", subject: "test", pinnedAccount: "work" });
    expect(response.result.content[0].text).toBe("official response");
    const call = calls.find(entry => entry.message.method === "tools/call");
    expect(call.message.params.arguments).toEqual({ include_organization: true });
    expect(call.init.headers.get("Authorization")).toBe("Bearer ghp_work_token");
    expect(call.init.headers.get("X-MCP-Readonly")).toBe("true");
  });

  it("automatically routes a repository owner to the only matching account", async () => {
    const env = makeEnv(); await clearAccountCaches(env);
    const calls: any[] = []; vi.stubGlobal("fetch", upstreamFetch(calls));
    await handleJsonRpcMessage({ jsonrpc: "2.0", id: 31, method: "tools/call", params: { name: "get_file_contents", arguments: { owner: "work-org", repo: "private-repo", path: "/" } } } as any, env, { method: "static_token", subject: "org-routing" });
    const call = calls.find(entry => entry.message.method === "tools/call");
    expect(call.init.headers.get("Authorization")).toBe("Bearer ghp_work_token");
  });

  it("accepts the legacy account routing argument but strips it before upstream", async () => {
    const env = makeEnv(); await clearAccountCaches(env);
    const calls: any[] = []; vi.stubGlobal("fetch", upstreamFetch(calls));
    await handleJsonRpcMessage({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_me", arguments: { account: "personal", include_organization: false } } } as any, env, { method: "static_token", subject: "test" });
    const call = calls.find(entry => entry.message.method === "tools/call");
    expect(call.message.params.arguments).toEqual({ include_organization: false });
    expect(call.init.headers.get("Authorization")).toBe("Bearer ghp_personal_token");
  });

  it("blocks mutating calls for read-only accounts", async () => {
    const env = makeEnv(); await clearAccountCaches(env);
    const calls: any[] = []; vi.stubGlobal("fetch", upstreamFetch(calls));
    const response = await handleJsonRpcMessage({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "create_repository", arguments: { name: "must-not-create" } } } as any, env, { method: "static_token", subject: "test", pinnedAccount: "work" });
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toContain("read-only");
    expect(calls.some(entry => entry.message.method === "tools/call")).toBe(false);
  });

  it("forwards resources and other MCP methods to the official upstream", async () => {
    const env = makeEnv(); await clearAccountCaches(env);
    const calls: any[] = []; vi.stubGlobal("fetch", upstreamFetch(calls));
    const response = await handleJsonRpcMessage({ jsonrpc: "2.0", id: 6, method: "resources/list", params: {} } as any, env, { method: "static_token", subject: "test" });
    expect(response.result.resources[0].uri).toBe("github://official");
    expect(calls.some(entry => entry.message.method === "resources/list")).toBe(true);
  });
});