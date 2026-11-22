import { describe, it, expect } from "vitest";
import { getProxyCustomTools } from "../src/mcp/schema-injector";

describe("proxy-only dashboard controls", () => {
  it("keeps account management controls outside the upstream tool catalog", () => {
    expect(getProxyCustomTools().map(tool => tool.name)).toEqual(["list_github_accounts", "refresh_accounts"]);
    expect(getProxyCustomTools().every(tool => !tool.description?.includes("GitHub MCP"))).toBe(true);
  });
});