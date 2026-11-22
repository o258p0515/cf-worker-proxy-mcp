import { describe, it, expect } from "vitest";
import { getProxyCustomTools } from "../src/mcp/schema-injector";

describe("agent account controls", () => {
  it("exposes account listing and switching without changing official tool schemas", () => {
    const tools = getProxyCustomTools();
    expect(tools.map(tool => tool.name)).toEqual(["list_github_accounts", "select_github_account"]);
    expect(tools.find(tool => tool.name === "select_github_account")?.inputSchema?.required).toEqual(["alias"]);
    expect(getProxyCustomTools(true).map(tool => tool.name)).toEqual(["list_github_accounts", "select_github_account", "refresh_accounts"]);
  });
});