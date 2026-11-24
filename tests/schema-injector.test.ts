import { describe, it, expect } from "vitest";
import { getProxyCustomTools } from "../src/mcp/schema-injector";

describe("agent account and Actions secret controls", () => {
  it("exposes secret tools without changing official GitHub tool schemas", () => {
    const tools = getProxyCustomTools();
    expect(tools.map(tool => tool.name)).toEqual([
      "list_github_accounts", "select_github_account", "list_github_secrets", "set_github_secret", "delete_github_secret",
      "localmcp_configure_secrets", "localmcp_check_secrets", "localmcp_reset_secrets", "localmcp_check_workflow",
      "localmcp_start", "localmcp_stop", "localmcp_restart", "localmcp_status", "localmcp_runs", "localmcp_logs", "localmcp_connection_check", "localmcp_hub_check_connection", "localmcp_hub_tools", "localmcp_hub_call", "localmcp_hub_check_secrets", "localmcp_hub_start", "localmcp_hub_runs", "localmcp_hub_status", "localmcp_hub_logs", "localmcp_hub_stop"
    ]);
    expect(tools.find(tool => tool.name === "set_github_secret")?.inputSchema?.required).toEqual(["owner", "repo", "secret_name", "value"]);
    expect(getProxyCustomTools(true).map(tool => tool.name)).toContain("refresh_accounts");
    expect(tools.every(tool => !tool.inputSchema?.properties?.account)).toBe(true);
    const dashboardLocalMcp = getProxyCustomTools(true).find(tool => tool.name === "localmcp_start");
    expect(dashboardLocalMcp?.inputSchema?.properties?.account).toBeTruthy();
  });
});