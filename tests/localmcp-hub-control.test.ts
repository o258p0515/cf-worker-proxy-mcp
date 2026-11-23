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
    secretTool.mockResolvedValue({ updated: true });
    const result = await runLocalMcpHubControlTool("localmcp_hub_start", { runner_name: "build-01", runner_tags: "linux,go", duration_seconds: 3600 }, account);
    expect(result.dispatched).toBe(true);
    expect(result.runner_name).toBe("build-01");
    expect(secretTool.mock.calls.map(call => call[1].secret_name)).toEqual(["HUB_URLS", "MCP_TOKEN"]);
    const dispatch = calls.find(call => call.url.endsWith("/dispatches"));
    expect(JSON.parse(dispatch?.init.body).inputs).toEqual({ runner_name: "build-01", runner_tags: "linux,go", duration_seconds: "3600" });
    expect(dispatch?.init.method).toBe("POST");
  });

  it("refuses to start Hub runners if Hub configuration is incomplete", async () => {
    await expect(runLocalMcpHubControlTool("localmcp_hub_start", {}, { ...account, localmcpgo_secrets: { MCP_TOKEN: "x" } }))
      .rejects.toThrow(/HUB_URLS/);
    expect(secretTool).not.toHaveBeenCalled();
  });

  it("validates runner lifetime and does not dispatch an invalid request", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(runLocalMcpHubControlTool("localmcp_hub_start", { duration_seconds: 999999 }, account))
      .rejects.toThrow(/duration_seconds/);
  });
});
