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
  it("preserves upstream tool definition and adds proxy controls", async () => {
    const env = makeEnv(); await clearAccountCaches(env); vi.stubGlobal("fetch", upstreamFetch());
    const response = await handleJsonRpcMessage({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} } as any, env, { method: "static_token", subject: "test" });
    expect(response.result.tools[0].name).toBe("get_me");
    expect(response.result.tools.map((tool: any) => tool.name)).toContain("set_github_secret");
    expect(response.result.tools[0].inputSchema.properties.account).toBeUndefined();
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
  it("blocks mutations for read-only accounts", async () => {
    const env = makeEnv(); await clearAccountCaches(env); const calls: any[] = []; vi.stubGlobal("fetch", upstreamFetch(calls));
    const response = await handleJsonRpcMessage({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "set_github_secret", arguments: { owner: "o", repo: "r", secret_name: "X", value: "v" } } } as any, env, { method: "static_token", subject: "test", pinnedAccount: "work" });
    expect(response.result.isError).toBe(true); expect(response.result.content[0].text).toContain("read-only");
    expect(calls.some(entry => entry.message.method === "tools/call")).toBe(false);
  });
});
