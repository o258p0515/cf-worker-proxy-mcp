import type { McpTool } from "../types";

// These proxy-only controls are exposed only by the protected API Explorer.
// They are never appended to the public MCP tool catalog.
export function getProxyCustomTools(): McpTool[] {
  return [
    { name: "list_github_accounts", description: "List enabled GitHub account aliases for the API Explorer.", inputSchema: { type: "object", properties: {}, required: [] } },
    { name: "refresh_accounts", description: "Refresh account and upstream tool catalog caches for the API Explorer.", inputSchema: { type: "object", properties: {}, required: [] } }
  ];
}