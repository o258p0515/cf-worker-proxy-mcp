import type { Env, AuthContext, JsonRpc } from "../types";
import { getAccounts, listPublicAccounts, resolveAccount, clearAccountCaches } from "../rtdb/account-store";
import { callUpstream, clearUpstreamSessions } from "./upstream-client";
import { getProxyCustomTools } from "./schema-injector";
import { runGitHubSecretTool } from "./github-secrets";
import { runLocalMcpTool } from "./localmcp";
import { auditLog } from "../utils/logger";

const DASHBOARD_SUBJECT = "api-explorer";
const WRITE_TOOL = /(?:^|_)(?:write|create|update|delete|push|merge|add|remove|fork|dismiss|submit|request|close|reopen|assign|cancel|rerun|enable|disable|set|put|patch)(?:_|$)/i;
const EXPLICITLY_MUTATING = new Set(["run_secret_scanning", "actions_run_trigger", "set_github_secret", "delete_github_secret", "localmcp_configure_secrets", "localmcp_reset_secrets", "localmcp_check_workflow", "localmcp_start", "localmcp_stop", "localmcp_restart"]);
const SECRET_TOOLS = new Set(["list_github_secrets", "set_github_secret", "delete_github_secret"]);
const LOCALMCP_TOOLS = new Set(["localmcp_configure_secrets", "localmcp_check_secrets", "localmcp_reset_secrets", "localmcp_check_workflow", "localmcp_start", "localmcp_stop", "localmcp_restart", "localmcp_status", "localmcp_runs", "localmcp_logs", "localmcp_connection_check"]);

function result(id: JsonRpc["id"], value: unknown) { return { jsonrpc: "2.0", id, result: value }; }
function error(id: JsonRpc["id"], code: number, message: string) { return { jsonrpc: "2.0", id, error: { code, message } }; }
function textResult(value: unknown, isError = false) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}
function selectionKey(ctx: AuthContext) { return `mcp:selected-account:v1:${ctx.method}:${encodeURIComponent(ctx.subject)}`; }
async function selectedAlias(env: Env, ctx: AuthContext): Promise<string | undefined> {
  if (ctx.pinnedAccount) return ctx.pinnedAccount;
  return (await env.CACHE_KV.get(selectionKey(ctx))) || undefined;
}
async function selectAccount(env: Env, ctx: AuthContext, requested?: string, targetOwner?: string) {
  const accounts = await getAccounts(env);
  const enabled = Object.entries(accounts).filter(([, account]) => account.enabled);
  const pinned = requested || await selectedAlias(env, ctx);
  let alias = pinned || "";
  if (!alias && targetOwner) {
    const matches = enabled.filter(([key, account]) => key.toLowerCase() === targetOwner.toLowerCase() || account.username.toLowerCase() === targetOwner.toLowerCase() || account.orgs.some(org => org.toLowerCase() === targetOwner.toLowerCase()));
    if (matches.length === 1) alias = matches[0]?.[0] || "";
    else if (matches.length > 1) throw new Error(`More than one GitHub account can access owner/org '${targetOwner}'. Call list_github_accounts, then select_github_account with the intended alias.`);
  }
  if (!alias) alias = (enabled.find(([, account]) => account.is_catalog_source) || enabled[0])?.[0] || "";
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
      const { alias, account } = await selectAccount(env, ctx);
      const upstream = await callUpstream(env, account, alias, { ...msg, params: p });
      if (upstream?.error) return upstream;
      const upstreamResult = upstream?.result || {};
      const tools = Array.isArray(upstreamResult.tools) ? upstreamResult.tools : [];
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
        await env.CACHE_KV.put(selectionKey(ctx), alias, { expirationTtl: 86400 });
        return hasId ? result(msg.id, textResult({ selected: alias, username: resolved.account.username, readonly: resolved.account.readonly, message: `GitHub account '${alias}' is now active for this MCP connection.` })) : null;
      }
      const requested = ctx.pinnedAccount || (typeof args.account === "string" ? args.account : undefined);
      delete args.account;
      const targetOwner = [args.owner, args.org, args.organization].find(v => typeof v === "string") as string | undefined;
      const { alias, account } = await selectAccount(env, ctx, requested, targetOwner);
      if (account.readonly && (WRITE_TOOL.test(name) || EXPLICITLY_MUTATING.has(name))) {
        return result(msg.id, textResult(`Account '${alias}' is read-only; this write operation is blocked.`, true));
      }
      const start = Date.now();
      try {
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
    const { alias, account } = await selectAccount(env, ctx);
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
  116