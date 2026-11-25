import { afterEach, describe, expect, it, vi } from "vitest";
import { runLocalMcpHubControlTool } from "../src/mcp/localmcp-hub-control";
import { listPublicAccounts, getAccounts, clearAccountCaches } from "../src/rtdb/account-store";

afterEach(() => {
  vi.unstubAllGlobals();
});

const baseAccount = {
  username: "o258p0515",
  token: "ghp_test_token",
  description: "",
  orgs: ["o258p0515"],
  enabled: true,
  readonly: false,
  localmcpgo_secrets: {
    HUB_URLS: "https://hub.example.com",
    MCP_TOKEN: "shared-token-0123456789abcdef",
    INSTABOX_API_KEY: "ibk_testsecret123456",
    UPSTASH_BOX_API_KEY: "upstash_secret_123456"
  }
} as any;

describe("InstaBox & Upstash Box Hub providers", () => {
  it("exposes instabox and upstashbox in listPublicAccounts when keys exist in RTDB", async () => {
    const kvValues = new Map<string, string>();
    const env = {
      MCP_TOKEN: "unit-secret",
      RTDB_AUTH_URL: "https://unit.firebaseio.com/github_accounts.json?auth=x",
      CACHE_KV: {
        get: async (k: string) => kvValues.get(k) ?? null,
        put: async (k: string, v: string) => { kvValues.set(k, v); },
        delete: async (k: string) => { kvValues.delete(k); }
      }
    } as any;
    await clearAccountCaches(env);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ personal: baseAccount })));
    await getAccounts(env);
    const list = await listPublicAccounts(env);
    expect(list[0]?.providers).toEqual(["github", "azure"].includes("instabox") ? [] : ["github", "instabox", "upstashbox"]);
    expect(JSON.stringify(list)).not.toContain("ibk_testsecret123456");
    expect(JSON.stringify(list)).not.toContain("upstash_secret_123456");
  });

  it("creates, polls operation, and bootstraps an InstaBox machine", async () => {
    const calls: Array<{ url: string; method: string; headers: Headers; body?: any }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
      const url = String(input);
      const method = String(init.method || "GET");
      const headers = new Headers(init.headers || {});
      calls.push({ url, method, headers, body: init.body ? JSON.parse(init.body) : undefined });

      if (url === "https://api.instabox.sh/v1/machines" && method === "POST") {
        return Response.json({ id: "op_123", state: "running" });
      }
      if (url.startsWith("https://api.instabox.sh/v1/operations/op_123")) {
        return Response.json({
          id: "op_123",
          state: "succeeded",
          machine: { id: "m_01234567234567234567234567", name: "ib-test-1", state: "running" }
        });
      }
      if (url === "https://api.instabox.sh/v1/machines/m_01234567234567234567234567/exec" && method === "POST") {
        return Response.json({ exitCode: 0, stdout: "STARTED_PID=999\n", stderr: "" });
      }
      if (url === "https://hub.example.com/mcp" && method === "POST") {
        const rpc = JSON.parse(init.body);
        if (rpc.method === "initialize") {
          return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-03-26" } }, { headers: { "mcp-session-id": "sess-1" } });
        }
        return Response.json({
          jsonrpc: "2.0",
          id: rpc.id,
          result: { runners: [{ runner_id: "ib-m_01234567234567234567234567", status: "online" }] }
        });
      }
      throw new Error("Unexpected URL: " + method + " " + url);
    }));

    const res = await runLocalMcpHubControlTool(
      "localmcp_hub_start",
      { provider: "instabox", runner_name: "ib-test-1", duration_seconds: 1800 },
      baseAccount,
      "",
      "personal",
      {}
    );

    expect(res).toMatchObject({
      provider: "instabox",
      machine_id: "m_01234567234567234567234567",
      runner_id: "ib-m_01234567234567234567234567",
      runner_name: "ib-test-1",
      bootstrap_exit_code: 0,
      runner_online: true
    });
    const createCall = calls.find(c => c.url.endsWith("/v1/machines") && c.method === "POST")!;
    expect(createCall.headers.get("X-API-Key")).toBe("ibk_testsecret123456");
    expect(createCall.headers.get("Idempotency-Key")).toBeTruthy();
  });

  it("automatically resumes cached InstaBox machine from RTDB when reuse_cached is omitted", async () => {
    const accountWithCache = {
      ...baseAccount,
      localmcpgo_runners: {
        instabox: { id: "m_cached00000000000000000001", runner_id: "ib-m_cached00000000000000000001", name: "ib-persisted" }
      }
    };
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
      const url = String(input);
      const method = String(init.method || "GET");
      calls.push({ url, method });

      if (url === "https://api.instabox.sh/v1/machines/m_cached00000000000000000001" && method === "GET") {
        return Response.json({ id: "m_cached00000000000000000001", name: "ib-persisted", state: "stopped", template: { id: "agent-browser" } });
      }
      if (url === "https://api.instabox.sh/v1/machines/m_cached00000000000000000001/start" && method === "POST") {
        return Response.json({ id: "op_start_cached", state: "running" });
      }
      if (url.startsWith("https://api.instabox.sh/v1/operations/op_start_cached")) {
        return Response.json({
          id: "op_start_cached",
          state: "succeeded",
          machine: { id: "m_cached00000000000000000001", name: "ib-persisted", state: "running", template: { id: "agent-browser" } }
        });
      }
      if (url === "https://api.instabox.sh/v1/machines/m_cached00000000000000000001/exec" && method === "POST") {
        return Response.json({ exitCode: 0, stdout: "STARTED_PID=321\n", stderr: "" });
      }
      if (url === "https://hub.example.com/mcp" && method === "POST") {
        const rpc = JSON.parse(init.body);
        if (rpc.method === "initialize") {
          return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-03-26" } }, { headers: { "mcp-session-id": "sess-cached" } });
        }
        return Response.json({
          jsonrpc: "2.0",
          id: rpc.id,
          result: { runners: [{ runner_id: "ib-m_cached00000000000000000001", status: "online" }] }
        });
      }
      throw new Error("Unexpected URL: " + method + " " + url);
    }));

    const res = await runLocalMcpHubControlTool(
      "localmcp_hub_start",
      { provider: "instabox" },
      accountWithCache,
      "",
      "personal",
      {}
    );

    expect(res).toMatchObject({
      provider: "instabox",
      machine_id: "m_cached00000000000000000001",
      runner_id: "ib-m_cached00000000000000000001",
      resumed: true,
      cache_source: "rtdb_cache",
      runner_online: true
    });
    expect(calls.some(c => c.url === "https://api.instabox.sh/v1/machines" && c.method === "POST")).toBe(false);
  });

  it("creates, polls readiness, and bootstraps an Upstash Box sandbox", async () => {
    const calls: Array<{ url: string; method: string; headers: Headers; body?: any }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
      const url = String(input);
      const method = String(init.method || "GET");
      const headers = new Headers(init.headers || {});
      calls.push({ url, method, headers, body: init.body ? JSON.parse(init.body) : undefined });

      if (url === "https://us-east-1.box.upstash.com/v2/box" && method === "POST") {
        return Response.json({ id: "box_abc123", name: "ub-test-1", status: "creating" });
      }
      if (url === "https://us-east-1.box.upstash.com/v2/box/box_abc123" && method === "GET") {
        return Response.json({ id: "box_abc123", name: "ub-test-1", status: "idle", runtime: "golang", size: "small" });
      }
      if (url === "https://us-east-1.box.upstash.com/v2/box/box_abc123/exec" && method === "POST") {
        return Response.json({ output: "STARTED_PID=888\n", error: "" });
      }
      if (url === "https://hub.example.com/mcp" && method === "POST") {
        const rpc = JSON.parse(init.body);
        if (rpc.method === "initialize") {
          return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-03-26" } }, { headers: { "mcp-session-id": "sess-2" } });
        }
        return Response.json({
          jsonrpc: "2.0",
          id: rpc.id,
          result: { runners: [{ runner_id: "ub-box_abc123", status: "online" }] }
        });
      }
      throw new Error("Unexpected URL: " + method + " " + url);
    }));

    const res = await runLocalMcpHubControlTool(
      "localmcp_hub_start",
      { provider: "upstashbox", runner_name: "ub-test-1", runtime: "golang", size: "small" },
      baseAccount,
      "",
      "personal",
      {}
    );

    expect(res).toMatchObject({
      provider: "upstashbox",
      box_id: "box_abc123",
      runner_id: "ub-box_abc123",
      runner_name: "ub-test-1",
      runtime: "golang",
      size: "small",
      tailscale_skipped: true,
      runner_online: true
    });
    const execCall = calls.find(c => c.url.endsWith("/exec"))!;
    expect(execCall.headers.get("Authorization")).toBe("Bearer upstash_secret_123456");
    expect(execCall.body.command[0]).toBe("sh");
    expect(execCall.body.command[1]).toBe("-c");
  });
});
