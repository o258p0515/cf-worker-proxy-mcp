import { describe, it, expect } from "vitest";
import { getProxyCustomTools } from "../src/mcp/schema-injector";

describe("agent account and Actions secret controls", () => {
  it("exposes secret tools without changing official GitHub tool schemas", () => {
    const tools = getProxyCustomTools();
    expect(tools.map(tool => tool.name)).toEqual(["list_github_accounts", "select_github_account", "list_github_secrets", "set_github_secret", "delete_github_secret"]);
    expect(tools.find(tool => tool.name === "set_github_secret")?.inputSchema?.required).toEqual(["owner", "repo", "secret_name", "value"]);
    expect(getProxyCustomTools(true).map(tool => tool.name)).toContain("refresh_accounts");
  });
});
