1	import type { McpTool } from "../types";
    2	
    3	// These proxy-only controls are exposed only by the protected API Explorer.
    4	// They are never appended to the public MCP tool catalog.
    5	export function getProxyCustomTools(): McpTool[] {
    6	  return [
    7	    { name: "list_github_accounts", description: "List enabled GitHub account aliases for the API Explorer.", inputSchema: { type: "object", properties: {}, required: [] } },
    8	    { name: "refresh_accounts", description: "Refresh account and upstream tool catalog caches for the API Explorer.", inputSchema: { type: "object", properties: {}, required: [] } }
    9	  ];
   10	}
   11