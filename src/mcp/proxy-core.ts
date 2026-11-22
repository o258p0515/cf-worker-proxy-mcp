1	import type { Env, AuthContext, JsonRpc } from "../types";
    2	import { getAccounts, listPublicAccounts, resolveAccount, clearAccountCaches } from "../rtdb/account-store";
    3	import { callUpstream, clearUpstreamSessions } from "./upstream-client";
    4	import { getProxyCustomTools } from "./schema-injector";
    5	import { auditLog } from "../utils/logger";
    6	
    7	const DASHBOARD_SUBJECT = "api-explorer";
    8	const WRITE_TOOL = /(?:^|_)(?:write|create|update|delete|push|merge|add|remove|fork|dismiss|submit|request|close|reopen|assign|cancel|rerun|enable|disable|set|put|patch)(?:_|$)/i;
    9	const EXPLICITLY_MUTATING = new Set(["run_secret_scanning", "actions_run_trigger"]);
   10	
   11	function result(id: JsonRpc["id"], value: unknown) { return { jsonrpc: "2.0", id, result: value }; }
   12	function error(id: JsonRpc["id"], code: number, message: string) { return { jsonrpc: "2.0", id, error: { code, message } }; }
   13	function textResult(value: unknown, isError = false) {
   14	  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
   15	}
   16	
   17	async function selectAccount(env: Env, ctx: AuthContext, requested?: string) {
   18	  const accounts = await getAccounts(env);
   19	  const enabled = Object.entries(accounts).filter(([, account]) => account.enabled);
   20	  const preferred = enabled.find(([, account]) => account.is_catalog_source) || enabled[0];
   21	  const alias = requested || ctx.pinnedAccount || preferred?.[0] || "";
   22	  const resolved = await resolveAccount(env, alias);
   23	  if (!resolved.ok) {
   24	    const available = resolved.availableAccounts.map(a => `${a.alias} (${a.username}${a.readonly ? ", read-only" : ""})`).join(", ");
   25	    throw new Error(`Unknown or disabled GitHub account '${alias}'. Available accounts: ${available || "none"}`);
   26	  }
   27	  return { alias, account: resolved.account };
   28	}
   29	
   30	export async function handleJsonRpcMessage(msg: JsonRpc, env: Env, ctx: AuthContext): Promise<any | null> {
   31	  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return error(msg?.id ?? null, -32600, "Invalid JSON-RPC request");
   32	  const p = msg.params || {};
   33	  const hasId = Object.prototype.hasOwnProperty.call(msg, "id");
   34	  const dashboard = ctx.subject === DASHBOARD_SUBJECT;
   35	
   36	  try {
   37	    if (msg.method === "ping") return hasId ? result(msg.id, {}) : null;
   38	
   39	    if (msg.method === "tools/call" && dashboard) {
   40	      const name = String(p.name || "");
   41	      if (name === "list_github_accounts") return hasId ? result(msg.id, textResult(await listPublicAccounts(env))) : null;
   42	      if (name === "refresh_accounts") {
   43	        await clearAccountCaches(env);
   44	        clearUpstreamSessions();
   45	        return hasId ? result(msg.id, textResult({ message: "Account and upstream tool catalog caches refreshed", accounts: await listPublicAccounts(env) })) : null;
   46	      }
   47	    }
   48	
   49	    if (msg.method === "tools/list") {
   50	      const { alias, account } = await selectAccount(env, ctx);
   51	      // Do not cache the official catalog: tool availability and schemas are
   52	      // account/toolset dependent, and clients expect the current upstream list.
   53	      const upstream = await callUpstream(env, account, alias, { ...msg, params: p });
   54	      if (upstream?.error) return upstream;
   55	      const upstreamResult = upstream?.result || {};
   56	      const tools = Array.isArray(upstreamResult.tools) ? upstreamResult.tools : [];
   57	      return result(msg.id, { ...upstreamResult, tools: dashboard ? [...tools, ...getProxyCustomTools()] : tools });
   58	    }
   59	
   60	    if (msg.method === "tools/call") {
   61	      const name = String(p.name || "");
   62	      const args = { ...(p.arguments || {}) };
   63	      // account is a proxy routing extension only. It is intentionally absent from
   64	      // upstream tool schemas; clients should normally select accounts via X-GitHub-Account.
   65	      const requested = ctx.pinnedAccount || (typeof args.account === "string" ? args.account : undefined);
   66	      delete args.account;
   67	      const { alias, account } = await selectAccount(env, ctx, requested);
   68	      if (account.readonly && (WRITE_TOOL.test(name) || EXPLICITLY_MUTATING.has(name))) {
   69	        return result(msg.id, textResult(`Account '${alias}' is read-only; this write operation is blocked.`, true));
   70	      }
   71	      const start = Date.now();
   72	      try {
   73	        const upstream = await callUpstream(env, account, alias, { ...msg, params: { ...p, name, arguments: args } });
   74	        auditLog({ event: "tool_call", tool: name, account: alias, authMethod: ctx.method, durationMs: Date.now() - start, status: upstream?.result?.isError || upstream?.error ? "error" : "ok" });
   75	        return upstream;
   76	      } catch (e) {
   77	        auditLog({ event: "tool_call", tool: name, account: alias, authMethod: ctx.method, durationMs: Date.now() - start, status: "error" });
   78	        throw e;
   79	      }
   80	    }
   81	
   82	    // Forward initialize, ping, resources, prompts, completions and future MCP
   83	    // methods to the official server instead of maintaining a partial imitation.
   84	    const { alias, account } = await selectAccount(env, ctx);
   85	    const upstream = await callUpstream(env, account, alias, msg);
   86	    return hasId ? upstream : null;
   87	  } catch (e) {
   88	    return hasId ? error(msg.id ?? null, -32000, e instanceof Error ? e.message : "Internal error") : null;
   89	  }
   90	}
   91	
   92	export async function handleJsonRpcBatch(msgs: JsonRpc[], env: Env, ctx: AuthContext) {
   93	  const out = await Promise.all(msgs.map(m => handleJsonRpcMessage(m, env, ctx)));
   94	  return out.filter(Boolean);
   95	}
   96