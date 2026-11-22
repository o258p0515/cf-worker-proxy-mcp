1	import type { Env, RtdbAccount } from "../types";
    2	import { redactSecrets } from "../utils/logger";
    3	
    4	const sessions = new Map<string, string>();
    5	const initialized = new Set<string>();
    6	function safeExcerpt(value: string): string { return redactSecrets(value).slice(0, 1200); }
    7	function isExpiredSession(status: number, body: string, hadSession: boolean): boolean {
    8	  if (!hadSession) return false;
    9	  if (status === 404) return true;
   10	  if (status !== 400) return false;
   11	  return /session (?:not found|expired|does not exist)|unknown session|invalid session/i.test(body);
   12	}
   13	
   14	async function request(env: Env, account: RtdbAccount, alias: string, message: any, session?: string): Promise<any> {
   15	  const headers = new Headers({ Authorization: "Bearer " + account.token, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" });
   16	  if (account.readonly) headers.set("X-MCP-Readonly", "true");
   17	  const toolsets = env.GITHUB_MCP_TOOLSETS?.trim() || "all";
   18	  if (toolsets) headers.set("X-MCP-Toolsets", toolsets);
   19	  if (session) headers.set("Mcp-Session-Id", session);
   20	  const response = await fetch(env.GITHUB_MCP_UPSTREAM_URL || "https://api.githubcopilot.com/mcp/", { method: "POST", headers, body: JSON.stringify(message) });
   21	  const sessionId = response.headers.get("Mcp-Session-Id");
   22	  if (sessionId) sessions.set(alias, sessionId);
   23	  const contentType = response.headers.get("Content-Type") || "";
   24	  const raw = await response.text();
   25	  if (!response.ok) {
   26	    if (isExpiredSession(response.status, raw, !!session)) return { error: { code: -32000, message: "Upstream MCP session expired (HTTP " + response.status + "): " + safeExcerpt(raw.trim()) } };
   27	    const details = ["GitHub MCP upstream HTTP " + response.status, "account='" + alias + "'", "method='" + String(message.method || "unknown") + "'"];
   28	    const requestId = response.headers.get("X-GitHub-Request-Id");
   29	    if (requestId) details.push("request_id=" + requestId);
   30	    const permissions = response.headers.get("X-Accepted-GitHub-Permissions");
   31	    if (permissions) details.push("required_permissions=" + permissions);
   32	    const excerpt = safeExcerpt(raw.trim());
   33	    if (excerpt) details.push("body=" + excerpt);
   34	    throw Error(details.join("; "));
   35	  }
   36	  if (contentType.includes("text/event-stream")) {
   37	    const frames = raw.replace(/\r\n/g, "\n").split(/\n\n/).flatMap(frame => {
   38	      const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n");
   39	      if (!data || data === "[DONE]") return [];
   40	      try { return [JSON.parse(data)]; } catch { return []; }
   41	    });
   42	    return frames.find(frame => frame.id === message.id) || frames.at(-1) || {};
   43	  }
   44	  try { return JSON.parse(raw); }
   45	  catch { return { error: { message: "Invalid upstream JSON response: " + safeExcerpt(raw) } }; }
   46	}
   47	
   48	async function initialize(env: Env, account: RtdbAccount, alias: string): Promise<void> {
   49	  const response = await request(env, account, alias, { jsonrpc: "2.0", id: "proxy-init", method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "github-mcp-proxy", version: "1.0.0" } } });
   50	  if (response?.error) throw Error("GitHub MCP initialize failed for account '" + alias + "': " + (response.error.message || "unknown error"));
   51	  initialized.add(alias);
   52	  const session = sessions.get(alias);
   53	  if (session) await request(env, account, alias, { jsonrpc: "2.0", method: "notifications/initialized", params: {} }, session);
   54	}
   55	
   56	export async function callUpstream(env: Env, account: RtdbAccount, alias: string, message: any): Promise<any> {
   57	  if (message.method === "initialize") {
   58	    sessions.delete(alias);
   59	    initialized.delete(alias);
   60	    const response = await request(env, account, alias, message);
   61	    if (!response?.error) {
   62	      initialized.add(alias);
   63	      const session = sessions.get(alias);
   64	      if (session) await request(env, account, alias, { jsonrpc: "2.0", method: "notifications/initialized", params: {} }, session);
   65	    }
   66	    return response;
   67	  }
   68	  if (!initialized.has(alias)) await initialize(env, account, alias);
   69	  let session = sessions.get(alias);
   70	  let response = await request(env, account, alias, message, session);
   71	  if (response?.error?.code === -32000) {
   72	    sessions.delete(alias);
   73	    initialized.delete(alias);
   74	    await initialize(env, account, alias);
   75	    session = sessions.get(alias);
   76	    response = await request(env, account, alias, message, session);
   77	  }
   78	  return response;
   79	}
   80	
   81	export function clearUpstreamSessions() { sessions.clear(); initialized.clear(); }
   82