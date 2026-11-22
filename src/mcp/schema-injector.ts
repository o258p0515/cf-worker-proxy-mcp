import type { McpTool } from "../types";

// Agent-facing account controls are additive tools. Official GitHub tool schemas
// remain untouched; account routing is handled by proxy session state.
export function getProxyCustomTools(includeAdmin = false): McpTool[] {
  const tools: McpTool[] = [
    { name: "list_github_accounts", description: "List enabled GitHub accounts available to this MCP connection. Returns aliases, usernames, organizations, and read-only status; never returns credentials. Call this first when choosing which GitHub identity to use.", inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false } },
    { name: "select_github_account", description: "Switch the active GitHub account for this MCP connection. Call list_github_accounts first, then select the exact alias. The selected account is remembered for subsequent official GitHub MCP tools until switched again. This does not change any official GitHub tool schema.", inputSchema: { type: "object", properties: { alias: { type: "string", description: "Exact account alias returned by list_github_accounts" } }, required: ["alias"], additionalProperties: false } }
  ];
  if (includeAdmin) tools.push({ name: "refresh_accounts", description: "Refresh account and upstream tool catalog caches for the protected API Explorer.", inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false } });
  return tools;
}