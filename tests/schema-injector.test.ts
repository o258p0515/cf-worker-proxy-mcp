1	import { describe, it, expect } from "vitest";
    2	import { getProxyCustomTools } from "../src/mcp/schema-injector";
    3	
    4	describe("proxy-only dashboard controls", () => {
    5	  it("keeps account management controls outside the upstream tool catalog", () => {
    6	    expect(getProxyCustomTools().map(tool => tool.name)).toEqual(["list_github_accounts", "refresh_accounts"]);
    7	    expect(getProxyCustomTools().every(tool => !tool.description?.includes("GitHub MCP"))).toBe(true);
    8	  });
    9	});
   10