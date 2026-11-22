1	import { describe, it, expect, vi, afterEach } from "vitest";
    2	import { handleJsonRpcMessage } from "../src/mcp/proxy-core";
    3	import { clearAccountCaches } from "../src/rtdb/account-store";
    4	import { clearUpstreamSessions } from "../src/mcp/upstream-client";
    5	
    6	afterEach(() => { vi.unstubAllGlobals(); clearUpstreamSessions(); });
    7	function kv() {
    8	  const values = new Map<string, string>();
    9	  return { get: async (key: string) => values.get(key) ?? null, put: async (key: string, value: string) => { values.set(key, value); }, delete: async (key: string) => { values.delete(key); } } as any;
   10	}
   11	function makeEnv() {
   12	  return { MCP_TOKEN: "test-secret", RTDB_AUTH_URL: "https://unit.firebaseio.com/github_accounts.json?auth=x", CACHE_KV: kv(), OAUTH_KV: kv(), GITHUB_MCP_TOOLSETS: "all" } as any;
   13	}
   14	function accountDb() {
   15	  return {
   16	    personal: { username: "me", token: "ghp_personal_token", enabled: true, is_catalog_source: true },
   17	    work: { username: "work", token: "ghp_work_token", enabled: true, readonly: true }
   18	  };
   19	}
   20	function upstreamFetch(calls: any[] = []) {
   21	  return vi.fn(async (input: any, init: any) => {
   22	    const url = String(input);
   23	    if (url.includes("unit.firebaseio.com")) return Response.json(accountDb());
   24	    const message = JSON.parse(init.body);
   25	    calls.push({ url, init, message });
   26	    if (message.method === "initialize") return Response.json({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-03-26", serverInfo: { name: "github-mcp-server", version: "test" }, capabilities: { tools: { listChanged: true } } } });
   27	    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
   28	    if (message.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "get_me", description: "Official description", inputSchema: { type: "object", properties: { include_organization: { type: "boolean" } }, required: [] } }] } });
   29	    if (message.method === "tools/call") return Response.json({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "official response" }] } });
   30	    if (message.method === "resources/list") return Response.json({ jsonrpc: "2.0", id: message.id, result: { resources: [{ uri: "github://official", name: "Official resource" }] } });
   31	    return Response.json({ jsonrpc: "2.0", id: message.id, result: {} });
   32	  });
   33	}
   34	
   35	describe("official GitHub MCP parity", () => {
   36	  it("forwards upstream initialize response unchanged", async () => {
   37	    const env = makeEnv(); await clearAccountCaches(env);
   38	    const fetch = upstreamFetch(); vi.stubGlobal("fetch", fetch);
   39	    const response = await handleJsonRpcMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } } as any, env, { method: "static_token", subject: "test" });
   40	    expect(response.result.serverInfo.name).toBe("github-mcp-server");
   41	    expect(response.result.capabilities).toEqual({ tools: { listChanged: true } });
   42	  });
   43	
   44	  it("returns the exact upstream tool definitions without proxy account fields or custom tools", async () => {
   45	    const env = makeEnv(); await clearAccountCaches(env);
   46	    vi.stubGlobal("fetch", upstreamFetch());
   47	    const response = await handleJsonRpcMessage({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} } as any, env, { method: "static_token", subject: "test" });
   48	    expect(response.result.tools).toEqual([{ name: "get_me", description: "Official description", inputSchema: { type: "object", properties: { include_organization: { type: "boolean" } }, required: [] } }]);
   49	    expect(response.result.tools.some((tool: any) => tool.name === "list_github_accounts")).toBe(false);
   50	    expect(response.result.tools[0].inputSchema.properties.account).toBeUndefined();
   51	  });
   52	
   53	  it("uses X-GitHub-Account selection and forwards original tool arguments unchanged", async () => {
   54	    const env = makeEnv(); await clearAccountCaches(env);
   55	    const calls: any[] = []; vi.stubGlobal("fetch", upstreamFetch(calls));
   56	    const response = await handleJsonRpcMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_me", arguments: { include_organization: true } } } as any, env, { method: "static_token", subject: "test", pinnedAccount: "work" });
   57	    expect(response.result.content[0].text).toBe("official response");
   58	    const call = calls.find(entry => entry.message.method === "tools/call");
   59	    expect(call.message.params.arguments).toEqual({ include_organization: true });
   60	    expect(call.init.headers.get("Authorization")).toBe("Bearer ghp_work_token");
   61	    expect(call.init.headers.get("X-MCP-Readonly")).toBe("true");
   62	  });
   63	
   64	  it("accepts the legacy account routing argument but strips it before upstream", async () => {
   65	    const env = makeEnv(); await clearAccountCaches(env);
   66	    const calls: any[] = []; vi.stubGlobal("fetch", upstreamFetch(calls));
   67	    await handleJsonRpcMessage({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_me", arguments: { account: "personal", include_organization: false } } } as any, env, { method: "static_token", subject: "test" });
   68	    const call = calls.find(entry => entry.message.method === "tools/call");
   69	    expect(call.message.params.arguments).toEqual({ include_organization: false });
   70	    expect(call.init.headers.get("Authorization")).toBe("Bearer ghp_personal_token");
   71	  });
   72	
   73	  it("blocks mutating calls for read-only accounts", async () => {
   74	    const env = makeEnv(); await clearAccountCaches(env);
   75	    const calls: any[] = []; vi.stubGlobal("fetch", upstreamFetch(calls));
   76	    const response = await handleJsonRpcMessage({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "create_repository", arguments: { name: "must-not-create" } } } as any, env, { method: "static_token", subject: "test", pinnedAccount: "work" });
   77	    expect(response.result.isError).toBe(true);
   78	    expect(response.result.content[0].text).toContain("read-only");
   79	    expect(calls.some(entry => entry.message.method === "tools/call")).toBe(false);
   80	  });
   81	
   82	  it("forwards resources and other MCP methods to the official upstream", async () => {
   83	    const env = makeEnv(); await clearAccountCaches(env);
   84	    const calls: any[] = []; vi.stubGlobal("fetch", upstreamFetch(calls));
   85	    const response = await handleJsonRpcMessage({ jsonrpc: "2.0", id: 6, method: "resources/list", params: {} } as any, env, { method: "static_token", subject: "test" });
   86	    expect(response.result.resources[0].uri).toBe("github://official");
   87	    expect(calls.some(entry => entry.message.method === "resources/list")).toBe(true);
   88	  });
   89	});
   90