import type { Env, AuthContext, JsonRpc } from "../types";
import { getAccounts, listPublicAccounts, resolveAccount, clearAccountCaches } from "../rtdb/account-store";
import { callUpstream, clearUpstreamSessions } from "./upstream-client";
import { getProxyCustomTools } from "./schema-injector";
import { runGitHubSecretTool } from "./github-secrets";
import { runLocalMcpTool } from "./localmcp";
import { HUB_TOOL_PREFIX, callHubTool, checkHubConnection, getHubTools } from "./hub";
import { runLocalMcpHubControlTool } from "./localmcp-hub-control";
import { auditLog } from "../utils/logger";

const DASHBOARD_SUBJECT = "api-explorer";
const WRITE_TOOL = /(?:^|_)(?:write|create|update|delete|push|merge|add|remove|fork|dismiss|submit|request|close|reopen|assign|cancel|rerun|enable|disable|set|put|patch)(?:_|$)/i;
const EXPLICITLY_MUTATING = new Set(["run_secret_scanning", "actions_run_trigger", "set_github_secret", "delete_github_secret", "localmcp_configure_secrets", "localmcp_reset_secrets", "localmcp_check_workflow", "localmcp_start", "localmcp_stop", "localmcp_restart", "localmcp_hub_start", "localmcp_hub_stop"]);
const SECRET_TOOLS = new Set(["list_github_secrets", "set_github_secret", "delete_github_secret"]);
const LOCALMCP_TOOLS = new Set(["localmcp_configure_secrets", "localmcp_check_secrets", "localmcp_reset_secrets", "localmcp_check_workflow", "localmcp_start", "localmcp_stop", "localmcp_restart", "localmcp_status", "localmcp_runs", "localmcp_logs", "localmcp_connection_check"]);
const LOCALMCP_HUB_CONTROL_TOOLS = new Set(["localmcp_hub_check_secrets", "localmcp_hub_start", "localmcp_hub_runs", "localmcp_hub_status", "localmcp_hub_logs", "localmcp_hub_stop"]);
const LOCALMCP_HUB_FACADE_TOOLS = new Set(["localmcp_hub_tools", "localmcp_hub_call"]);

function result(id: JsonRpc["id"], value: unknown) { return { jsonrpc: "2.0", id, result: value }; }
function error(id: JsonRpc["id"], code: number, message: string) { return { jsonrpc: "2.0", id, error: { code, message } }; }
function textResult(value: unknown, isError = false) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}
function selectionKey(ctx: AuthContext) { return `mcp:selected-account:v2:${ctx.method}:${encodeURIComponent(ctx.subject)}`; }
const SELECTION_CACHE_TTL_MS = 30_000;
const selectionMemory = new Map<string, { alias: string; expiresAt: number }>();
function cacheSelectedAlias(key: string, alias: string) {
  selectionMemory.delete(key);
  selectionMemory.set(key, { alias, expiresAt: Date.now() + SELECTION_CACHE_TTL_MS });
  while (selectionMemory.size > 1000) selectionMemory.delete(selectionMemory.keys().next().value!);
}
function selectionStub(env: Env, ctx: AuthContext) {
  return env.SSE_SESSIONS.get(env.SSE_SESSIONS.idFromName(selectionKey(ctx)));
}
async function saveSelectedAlias(env: Env, ctx: AuthContext, alias: string) {
  const key = selectionKey(ctx);
  const response = await selectionStub(env, ctx).fetch("https://session.internal/_internal/account-selection", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ alias })
  });
  if (!response.ok) throw new Error("Failed to persist GitHub account selection (HTTP " + response.status + ").");
  cacheSelectedAlias(key, alias);
}
async function selectedAlias(env: Env, ctx: AuthContext): Promise<string | undefined> {
  if (ctx.pinnedAccount) return ctx.pinnedAccount;
  const key = selectionKey(ctx);
  const cached = selectionMemory.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.alias;
  if (cached) selectionMemory.delete(key);
  const response = await selectionStub(env, ctx).fetch("https://session.internal/_internal/account-selection");
  if (!response.ok) throw new Error("Failed to read GitHub account selection (HTTP " + response.status + ").");
  const saved = await response.json() as { alias?: unknown };
  if (typeof saved.alias === "string") { cacheSelectedAlias(key, saved.alias); return saved.alias; }
  selectionMemory.delete(key);
  return undefined;
}
async function selectAccount(env: Env, ctx: AuthContext, requested?: string, targetOwner?: string, allowCatalogDefault = false) {
  const accounts = await getAccounts(env);
  const enabled = Object.entries(accounts).filter(([, account]) => account.enabled);
  const pinned = requested || await selectedAlias(env, ctx);
  let alias = pinned || "";
  if (!alias && targetOwner) {
    const matches = enabled.filter(([key, account]) => key.toLowerCase() === targetOwner.toLowerCase() || account.username.toLowerCase() === targetOwner.toLowerCase() || account.orgs.some(org => org.toLowerCase() === targetOwner.toLowerCase()));
    if (matches.length === 1) alias = matches[0]?.[0] || "";
    else if (matches.length > 1) throw new Error(`More than one GitHub account can access owner/org '${targetOwner}'. Call list_github_accounts, then select_github_account with the intended alias.`);
  }
  if (!alias && allowCatalogDefault) alias = (enabled.find(([, account]) => account.is_catalog_source) || enabled[0])?.[0] || "";
  if (!alias) throw new Error("No GitHub account is selected. Call list_github_accounts, then select_github_account with an exact alias. No account fallback is performed.");
  const resolved = await resolveAccount(env, alias);
  if (!resolved.ok) {
    const available = resolved.availableAccounts.map(a => `${a.alias} (${a.username}${a.readonly ? ", read-only" : ""})`).join(", ");
    throw new Error(`Unknown or disabled GitHub account '${alias}'. Available accounts: ${available || "none"}`);
  }
  return { alias, account: resolved.account };
}

export async function handleJsonRpcMessage(msg: JsonRpc, env: Env, ctx: AuthContext): Promise<any | null> {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return error(msg?.id ?? null, -32600, "Invalid JSON-RPC request");
  const p = msg.params || {};
  const hasId = Object.prototype.hasOwnProperty.call(msg, "id");
  const dashboard = ctx.subject === DASHBOARD_SUBJECT;
  try {
    if (msg.method === "ping") return hasId ? result(msg.id, {}) : null;
    if (msg.method === "tools/call" && dashboard) {
      const name = String(p.name || "");
      if (name === "list_github_accounts") return hasId ? result(msg.id, textResult(await listPublicAccounts(env))) : null;
      if (name === "refresh_accounts") {
        await clearAccountCaches(env); clearUpstreamSessions();
        return hasId ? result(msg.id, textResult({ message: "Account and upstream tool catalog caches refreshed", accounts: await listPublicAccounts(env) })) : null;
      }
    }
    if (msg.method === "tools/list") {
      const { alias, account } = await selectAccount(env, ctx, undefined, undefined, true);
      const upstream = account.token ? await callUpstream(env, account, alias, { ...msg, params: p }) : null;
      if (upstream?.error) return upstream;
      const upstreamResult = upstream?.result || {};
      const tools = Array.isArray(upstreamResult.tools) ? upstreamResult.tools : [];
      // Hub is exposed through a stable Proxy facade only. The tool catalog must
      // never change when runners connect/disconnect or when a session selects a runner.
      // Runner-specific tool schemas are discoverable through localmcp_hub_tools and
      // invoked through localmcp_hub_call with an optional runner_id.
      return result(msg.id, { ...upstreamResult, tools: [...tools, ...getProxyCustomTools(dashboard)] });
    }
    if (msg.method === "tools/call") {
      const name = String(p.name || "");
      const args = { ...(p.arguments || {}) };
      if (name === "list_github_accounts") return hasId ? result(msg.id, textResult(await listPublicAccounts(env))) : null;
      if (name === "select_github_account") {
        const alias = typeof args.alias === "string" ? args.alias.trim() : "";
        const resolved = await resolveAccount(env, alias);
        if (!resolved.ok) throw new Error(`Unknown or disabled GitHub account '${alias}'. Available accounts: ${resolved.availableAccounts.map(a => `${a.alias} (${a.username}${a.readonly ? ", read-only" : ""})`).join(", ") || "none"}`);
        await saveSelectedAlias(env, ctx, alias);
        const providers = [...(resolved.account.token ? ["github"] : []), ...(resolved.account.localmcpgo_secrets?.AZURE_DEVOPS_PAT && resolved.account.localmcpgo_secrets?.AZURE_DEVOPS_ORG_URL ? ["azure"] : [])];
        return hasId ? result(msg.id, textResult({ selected: alias, username: resolved.account.username, readonly: resolved.account.readonly, providers, message: `Account '${alias}' is now active for this MCP connection.` })) : null;
      }
      const requested = ctx.pinnedAccount || (typeof args.account === "string" ? args.account : undefined);
      delete args.account;
      const targetOwner = [args.owner, args.org, args.organization].find(v => typeof v === "string") as string | undefined;
      const { alias, account } = await selectAccount(env, ctx, requested, targetOwner);
      if (account.readonly && (WRITE_TOOL.test(name) || EXPLICITLY_MUTATING.has(name))) {
        return result(msg.id, textResult(`Account '${alias}' is read-only; this write operation is blocked.`, true));
      }
      if (LOCALMCP_HUB_CONTROL_TOOLS.has(name)) {
        const allAccounts = ctx.pinnedAccount ? { [alias]: account } : await getAccounts(env);
        const hubControl = await runLocalMcpHubControlTool(name, args, account, env.MCP_TOKEN, alias, env, ctx, allAccounts);
        return hasId ? result(msg.id, textResult(hubControl)) : null;
      }
      if (name === "localmcp_hub_check_connection") {
        const hubStatus = await checkHubConnection(account, env.MCP_TOKEN, env.LOCALMCP_HUB, env.LOCALMCP_HUB_ORIGIN);
        return hasId ? result(msg.id, textResult(hubStatus, !hubStatus.ready)) : null;
      }
      if (name === "localmcp_hub_tools") {
        const catalog = await getHubTools(account, ctx, env.MCP_TOKEN, env.LOCALMCP_HUB, env.LOCALMCP_HUB_ORIGIN);
        return hasId ? result(msg.id, textResult({ tools: catalog, invocation: "Call localmcp_hub_call with tool_name (without hub__ prefix), arguments, and optional runner_id." })) : null;
      }
      if (name === "localmcp_hub_call") {
        const toolName = typeof args.tool_name === "string" ? args.tool_name.trim() : "";
        if (!toolName) throw new Error("tool_name is required; call localmcp_hub_tools to inspect the Hub catalog.");
        const callArgs = args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments) ? { ...(args.arguments as Record<string, unknown>) } : {};
        if (typeof args.runner_id === "string" && args.runner_id.trim()) callArgs.runner_id = args.runner_id.trim();
        if (account.readonly && !["list_runners", "get_job_result"].includes(toolName)) return result(msg.id, textResult("Account is read-only; this LocalMCP Hub tool execution is blocked.", true));
        const hubResult = await callHubTool(HUB_TOOL_PREFIX + toolName, callArgs, account, ctx, env.MCP_TOKEN, env.LOCALMCP_HUB, env.LOCALMCP_HUB_ORIGIN);
        return hasId ? result(msg.id, textResult(hubResult)) : null;
      }
      if (name.startsWith(HUB_TOOL_PREFIX)) {
        if (account.readonly && name !== HUB_TOOL_PREFIX + "list_runners" && name !== HUB_TOOL_PREFIX + "get_job_result") {
          return result(msg.id, textResult("Account is read-only; LocalMCP Hub tool execution is blocked.", true));
        }
        const hubResult = await callHubTool(name, args, account, ctx, env.MCP_TOKEN, env.LOCALMCP_HUB, env.LOCALMCP_HUB_ORIGIN);
        return result(msg.id, hubResult);
      }
      const start = Date.now();
      try {
        if (!account.token && (SECRET_TOOLS.has(name) || LOCALMCP_TOOLS.has(name) || !name.startsWith(HUB_TOOL_PREFIX))) {
          throw new Error("The selected account has no GitHub token. This account is Azure DevOps-only; use localmcp_hub_* tools with provider='azure'.");
        }
        if (SECRET_TOOLS.has(name)) {
          const secretResult = await runGitHubSecretTool(name as any, args, account.token);
          auditLog({ event: "tool_call", tool: name, account: alias, authMethod: ctx.method, durationMs: Date.now() - start, status: "ok" });
          return result(msg.id, textResult(secretResult));
        }
        if (LOCALMCP_TOOLS.has(name)) {
          const localResult = await runLocalMcpTool(name, args, env, alias, account);
          auditLog({ event: "tool_call", tool: name, account: alias, authMethod: ctx.method, durationMs: Date.now() - start, status: "ok" });
          return result(msg.id, textResult(localResult));
        }
        const upstream = await callUpstream(env, account, alias, { ...msg, params: { ...p, name, arguments: args } });
        auditLog({ event: "tool_call", tool: name, account: alias, authMethod: ctx.method, durationMs: Date.now() - start, status: upstream?.result?.isError || upstream?.error ? "error" : "ok" });
        return upstream;
      } catch (e) {
        auditLog({ event: "tool_call", tool: name, account: alias, authMethod: ctx.method, durationMs: Date.now() - start, status: "error" });
        throw e;
      }
    }
    const { alias, account } = await selectAccount(env, ctx, undefined, undefined, true);
    if (!account.token) {
      if (msg.method === "initialize") return hasId ? result(msg.id, { protocolVersion: String(p.protocolVersion || "2025-03-26"), capabilities: { tools: { listChanged: true } }, serverInfo: { name: "cf-worker-proxy-mcp", version: "azure-account" } }) : null;
      if (msg.method.startsWith("notifications/")) return null;
      if (msg.method === "resources/list") return hasId ? result(msg.id, { resources: [] }) : null;
      throw new Error("The selected account has no GitHub token. This account is Azure DevOps-only; GitHub upstream operations are unavailable.");
    }
    const upstream = await callUpstream(env, account, alias, msg);
    return hasId ? upstream : null;
  } catch (e) {
    return hasId ? error(msg.id ?? null, -32000, e instanceof Error ? e.message : "Internal error") : null;
  }
}
export async function handleJsonRpcBatch(msgs: JsonRpc[], env: Env, ctx: AuthContext) {
  const out = await Promise.all(msgs.map(m => handleJsonRpcMessage(m, env, ctx)));
  return out.filter(Boolean);
}
