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
      if (url.includes("unit.firebaseio.com")) return Response.json({ personal: { ...account, token: account.token } });
      throw new Error("Unexpected request " + url);
    }));
    await expect(runLocalMcpTool("localmcp_start", {}, env, "personal", account))
      .rejects.toThrow(/missing required localmcpgo_secrets/);
    expect(calls.some(url => url.endsWith("/dispatches"))).toBe(false);
  });
});