import { afterEach, describe, expect, it, vi } from "vitest";
import { HUB_TOOL_PREFIX, callHubTool, checkHubConnection, getHubTools } from "../src/mcp/hub";

afterEach(() => vi.unstubAllGlobals());

const account = {
  username: "tester", token: "github-token", description: "", orgs: [], enabled: true, readonly: false,
  localmcpgo_secrets: { HUB_URLS: "https://hub.example.com", MCP_TOKEN: "mcp-token-shared-0123456789abcdef" }
} as any;
const ctx = { method: "static_token", subject: "agent-session" } as any;

describe("isolated LocalMCP Hub proxy layer", () => {
  it("loads Hub tools into a separate prefixed namespace using MCP_TOKEN", async () => {
    const fetch = vi.fn(async (_input: any, init: any) => {
      expect(init.headers.Authorization).toBe("Bearer mcp-token-shared-0123456789abcdef");
      const rpc = JSON.parse(init.body);
      expect(rpc.method).toBe("tools/list");
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { tools: [{ name: "bash", description: "Run shell", inputSchema: { type: "object", properties: { command: { type: "string" } } } }] } });
    });
    vi.stubGlobal("fetch", fetch);
    const tools = await getHubTools(account, ctx);
    expect(tools.map(tool => tool.name)).toEqual([HUB_TOOL_PREFIX + "bash"]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("routes only prefixed Hub calls to Hub and strips the namespace prefix", async () => {
    const fetch = vi.fn(async (_input: any, init: any) => {
      expect(init.headers.Authorization).toBe("Bearer mcp-token-shared-0123456789abcdef");
      const rpc = JSON.parse(init.body);
      expect(rpc.method).toBe("tools/call");
      expect(rpc.params).toEqual({ name: "bash", arguments: { command: "pwd" } });
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: "/workspace" }] } });
    });
    vi.stubGlobal("fetch", fetch);
    const result = await callHubTool(HUB_TOOL_PREFIX + "bash", { command: "pwd" }, account, ctx);
    expect(result.content[0].text).toBe("/workspace");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("checks Hub health and authenticated MCP initialization without touching direct runner configuration", async () => {
    const fetch = vi.fn(async (input: any, init?: any) => {
      if (String(input).endsWith("/health")) return Response.json({ status: "ok" });
      expect(init?.headers.Authorization).toBe("Bearer mcp-token-shared-0123456789abcdef");
      return Response.json({ result: { serverInfo: { name: "localmcp-hub" } } });
    });
    vi.stubGlobal("fetch", fetch);
    const result = await checkHubConnection(account);
    expect(result.ready).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("uses the Proxy MCP_TOKEN as a fallback when the shared token is not duplicated in RTDB", async () => {
    const fetch = vi.fn(async (_input: any, init: any) => {
      expect(init.headers.Authorization).toBe("Bearer proxy-shared-token-0123456789");
      const rpc = JSON.parse(init.body);
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { tools: [{ name: "bash", inputSchema: { type: "object", properties: {} } }] } });
    });
    vi.stubGlobal("fetch", fetch);
    const withoutRtdbToken = { ...account, localmcpgo_secrets: { HUB_URLS: "https://hub.example.com" } };
    const tools = await getHubTools(withoutRtdbToken, ctx, "proxy-shared-token-0123456789");
    expect(tools.map(tool => tool.name)).toEqual([HUB_TOOL_PREFIX + "bash"]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uses the Cloudflare service binding for the same-account Hub origin", async () => {
    const serviceFetch = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe("/mcp");
      const rpc = await request.json() as any;
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { tools: [{ name: "bash", inputSchema: { type: "object", properties: {} } }] } });
    });
    const publicFetch = vi.fn();
    vi.stubGlobal("fetch", publicFetch);
    const service = { fetch: serviceFetch } as any;
    const tools = await getHubTools(account, ctx, "", service, "https://hub.example.com");
    expect(tools.map(tool => tool.name)).toEqual([HUB_TOOL_PREFIX + "bash"]);
    expect(serviceFetch).toHaveBeenCalledTimes(1);
    expect(publicFetch).not.toHaveBeenCalled();
  });

  it("returns stable Hub meta-tools when configuration is missing instead of silently hiding the entire Hub catalog", async () => {
    const tools = await getHubTools({ ...account, localmcpgo_secrets: { MCP_TOKEN: "mcp-token-shared-0123456789abcdef" } }, ctx);
    expect(tools.map(tool => tool.name)).toEqual(["hub__list_runners", "hub__select_runner", "hub__get_job_result"]);
  });

  it("keeps the Hub meta-tool catalog visible when no Hub URL is configured", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect((await getHubTools({ ...account, localmcpgo_secrets: { MCP_TOKEN: "x" } }, ctx)).map(tool => tool.name)).toEqual(["hub__list_runners", "hub__select_runner", "hub__get_job_result"]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
