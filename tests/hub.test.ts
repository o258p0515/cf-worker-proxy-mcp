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

  it("does not expose Hub tools when no Hub URL is configured", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await getHubTools({ ...account, localmcpgo_secrets: { MCP_TOKEN: "x" } }, ctx)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
