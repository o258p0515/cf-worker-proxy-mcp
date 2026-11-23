import { describe, it, expect, vi, afterEach } from "vitest";
import { runLocalMcpTool } from "../src/mcp/localmcp";
import type { RtdbAccount } from "../src/types";

const account: RtdbAccount = {
  username: "octocat", token: "github-test-token", description: "", orgs: [],
  enabled: true, readonly: false, localmcpgo_secrets: {}
};
const env: any = {
  MCP_TOKEN: "unit-test-cache-key",
  RTDB_AUTH_URL: "https://unit.firebaseio.com/github_accounts.json?auth=test-auth",
  CACHE_KV: { get: async () => null, put: async () => {}, delete: async () => {} }
};
const yaml = "name: LocalMCP\non:\n  workflow_dispatch:\njobs:\n  run:\n    runs-on: ubuntu-latest\n";

describe("LocalMCP Go lifecycle tools", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("validates the existing workflow without replacing it", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: any) => {
      const url = String(input);
      if (url.endsWith("/repos/octocat/localmcpcoder-go")) return Response.json({ default_branch: "main" });
      if (url.includes("/contents/.github/workflows/example-run.yml")) {
        return Response.json({ content: btoa(yaml), encoding: "base64" });
      }
      if (url.includes("/actions/workflows/example-run.yml")) return Response.json({ id: 123, state: "active" });
      throw new Error("Unexpected request " + url);
    }));
    const result = await runLocalMcpTool("localmcp_check_workflow", {}, env, "personal", account);
    expect(result).toMatchObject({ path: ".github/workflows/example-run.yml", state: "active", installed: false });
  });

  it("does not dispatch when required RTDB secrets are missing", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: any) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/repos/octocat/localmcpcoder-go")) return Response.json({ default_branch: "main" });
      if (url.includes("/contents/.github/workflows/example-run.yml")) return Response.json({ content: btoa(yaml), encoding: "base64" });
      if (url.includes("/actions/workflows/example-run.yml") && !url.includes("/runs")) return Response.json({ id: 123, state: "active" });
      if (url.includes("/actions/workflows/example-run.yml/runs")) return Response.json({ workflow_runs: [] });
      if (url.includes("/actions/secrets?per_page=100")) return Response.json({ secrets: [] });
      if (url.includes("unit.firebaseio.com")) return Response.json({ personal: { ...account, token: account.token } });
      throw new Error("Unexpected request " + url);
    }));
    await expect(runLocalMcpTool("localmcp_start", {}, env, "personal", account))
      .rejects.toThrow(/absent from GitHub and not configured in RTDB/);
    expect(calls.some(url => url.endsWith("/dispatches"))).toBe(false);
  });

  it("starts when required secrets already exist on GitHub even if RTDB omits one", async () => {
    const required = ["CF_API_EMAIL", "CF_API_KEY", "CF_DOMAIN", "MCP_TOKEN", "MCP_OAUTH_CLIENT_ID", "MCP_OAUTH_CLIENT_SECRET"];
    const calls: string[] = [];
    let runChecks = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
      const url = String(input);
      calls.push((init.method || "GET") + " " + url);
      if (url.includes("unit.firebaseio.com")) return Response.json({ personal: { ...account, token: account.token, localmcpgo_secrets: {} } });
      if (url.endsWith("/repos/octocat/localmcpcoder-go")) return Response.json({ default_branch: "main" });
      if (url.includes("/contents/.github/workflows/example-run.yml")) return Response.json({ content: btoa(yaml), encoding: "base64" });
      if (url.includes("/actions/workflows/example-run.yml") && !url.includes("/runs")) return Response.json({ id: 123, state: "active" });
      if (url.includes("/actions/workflows/example-run.yml/runs")) {
        runChecks++;
        return Response.json({ workflow_runs: runChecks === 1 ? [] : [{ id: 77, event: "workflow_dispatch", created_at: new Date().toISOString(), status: "queued", html_url: "https://github.com/octocat/localmcpcoder-go/actions/runs/77" }] });
      }
      if (url.includes("/actions/secrets?per_page=100")) return Response.json({ secrets: required.map(name => ({ name })) });
      if (url.endsWith("/actions/workflows/example-run.yml/dispatches") && init.method === "POST") return new Response(null, { status: 204 });
      throw new Error("Unexpected request " + url);
    }));
    const result = await runLocalMcpTool("localmcp_start", {}, env, "personal", account);
    expect(result).toMatchObject({ dispatched: true, run: { id: 77 }, secrets: { written_count: 0, missing_on_github_after_sync: [] } });
    expect(calls.some(call => call.startsWith("PUT ") && call.includes("/actions/secrets/"))).toBe(false);
  });


  it("checks LocalMCP Go with JSON-only MCP initialize instead of negotiating SSE", async () => {
    let accept = "";
    vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
      const url = String(input);
      if (url.endsWith("/repos/octocat/localmcpcoder-go")) return Response.json({ default_branch: "main" });
      if (url.endsWith("/health")) return Response.json({ status: "ok" });
      if (url.endsWith("/mcp") && init.method === "POST") {
        accept = new Headers(init.headers).get("Accept") || "";
        return Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26", serverInfo: { name: "localmcpcoder-go", version: "1.0.0" } } });
      }
      throw new Error("Unexpected request " + url);
    }));
    const configured = { ...account, localmcpgo_secrets: { CF_DOMAIN: "mcp.example.test", MCP_TOKEN: "localmcp-test-token" } };
    const result = await runLocalMcpTool("localmcp_connection_check", {}, env, "personal", configured);
    expect(result).toMatchObject({ ready: true, health_status: 200, mcp_http_status: 200, initialized: true });
    expect(accept).toBe("application/json");
  });

});