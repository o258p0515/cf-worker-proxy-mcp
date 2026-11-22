import type { McpTool } from "../types";

const repoFields = {
  owner: { type: "string", description: "Repository owner" },
  repo: { type: "string", description: "Repository name" },
};
const secretTargetRequired = ["owner", "repo"];
export function getProxyCustomTools(includeAdmin = false): McpTool[] {
  const tools: McpTool[] = [
    { name: "list_github_accounts", description: "List enabled GitHub accounts available to this MCP connection. Returns aliases, usernames, organizations, and read-only status; never returns credentials. Call this first when choosing which GitHub identity to use.", inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false } },
    { name: "select_github_account", description: "Switch the active GitHub account for this MCP connection. Call list_github_accounts first, then select the exact alias. The selected account is remembered for subsequent GitHub MCP calls until switched again.", inputSchema: { type: "object", properties: { alias: { type: "string", description: "Exact account alias returned by list_github_accounts" } }, required: ["alias"], additionalProperties: false } },
    { name: "list_github_secrets", description: "List names and timestamps of GitHub Actions repository secrets. GitHub never returns stored secret values. Requires repository Actions read permission.", inputSchema: { type: "object", properties: repoFields, required: secretTargetRequired, additionalProperties: false } },
    { name: "set_github_secret", description: "Create or update a GitHub Actions repository secret. The value is encrypted with the repository's GitHub public key before transmission and is never returned or logged. Requires repository Actions secrets write/admin permission. Call list_github_accounts first and select the intended account.", inputSchema: { type: "object", properties: { ...repoFields, secret_name: { type: "string", description: "Secret name (uppercase letters, digits, underscores)" }, value: { type: "string", description: "Plaintext value to store as a GitHub Actions secret; do not use for non-secret configuration" } }, required: [...secretTargetRequired, "secret_name", "value"], additionalProperties: false } },
    { name: "delete_github_secret", description: "Delete a GitHub Actions repository secret by name. This is irreversible. Requires repository Actions secrets write/admin permission.", inputSchema: { type: "object", properties: { ...repoFields, secret_name: { type: "string", description: "Secret name to delete" } }, required: [...secretTargetRequired, "secret_name"], additionalProperties: false } }
  ];
  if (includeAdmin) tools.push({ name: "refresh_accounts", description: "Refresh account and upstream tool catalog caches for the protected API Explorer.", inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false } });
  return tools;
}
