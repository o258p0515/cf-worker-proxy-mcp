import type { Env, RtdbAccount } from "../types";
import { redactSecrets } from "../utils/logger";

const sessions = new Map<string, string>();
const initialized = new Set<string>();
function safeExcerpt(value: string): string { return redactSecrets(value).slice(0, 1200); }
function isExpiredSession(status: number, body: string, hadSession: boolean): boolean {
  if (!hadSession) return false;
  if (status === 404) return true;
  if (status !== 400) return false;
  return /session (?:not found|expired|does not exist)|unknown session|invalid session/i.test(body);
}

async function request(env: Env, account: RtdbAccount, alias: string, message: any, session?: string): Promise<any> {
  const headers = new Headers({ Authorization: "Bearer " + account.token, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" });
  if (account.readonly) headers.set("X-MCP-Readonly", "true");
  const toolsets = env.GITHUB_MCP_TOOLSETS?.trim() || "all";
  if (toolsets) headers.set("X-MCP-Toolsets", toolsets);
  if (session) headers.set("Mcp-Session-Id", session);
  const response = await fetch(env.GITHUB_MCP_UPSTREAM_URL || "https://api.githubcopilot.com/mcp/", { method: "POST", headers, body: JSON.stringify(message) });
  const sessionId = response.headers.get("Mcp-Session-Id");
  if (sessionId) sessions.set(alias, sessionId);
  const contentType = response.headers.get("Content-Type") || "";
  const raw = await response.text();
  if (!response.ok) {
    if (isExpiredSession(response.status, raw, !!session)) return { error: { code: -32000, message: "Upstream MCP session expired (HTTP " + response.status + "): " + safeExcerpt(raw.trim()) } };
    const details = ["GitHub MCP upstream HTTP " + response.status, "account='" + alias + "'", "method='" + String(message.method || "unknown") + "'"];
    const requestId = response.headers.get("X-GitHub-Request-Id");
    if (requestId) details.push("request_id=" + requestId);
    const permissions = response.headers.get("X-Accepted-GitHub-Permissions");
    if (permissions) details.push("required_permissions=" + permissions);
    const excerpt = safeExcerpt(raw.trim());
    if (excerpt) details.push("body=" + excerpt);
    throw Error(details.join("; "));
  }
  if (contentType.includes("text/event-stream")) {
    const frames = raw.replace(/\r\n/g, "\n").split(/\n\n/).flatMap(frame => {
      const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n");
      if (!data || data === "[DONE]") return [];
      try { return [JSON.parse(data)]; } catch { return []; }
    });
    return frames.find(frame => frame.id === message.id) || frames.at(-1) || {};
  }
  try { return JSON.parse(raw); }
  catch { return { error: { message: "Invalid upstream JSON response: " + safeExcerpt(raw) } }; }
}

async function initialize(env: Env, account: RtdbAccount, alias: string): Promise<void> {
  const response = await request(env, account, alias, { jsonrpc: "2.0", id: "proxy-init", method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "github-mcp-proxy", version: "1.0.0" } } });
  if (response?.error) throw Error("GitHub MCP initialize failed for account '" + alias + "': " + (response.error.message || "unknown error"));
  initialized.add(alias);
  const session = sessions.get(alias);
  if (session) await request(env, account, alias, { jsonrpc: "2.0", method: "notifications/initialized", params: {} }, session);
}

export async function callUpstream(env: Env, account: RtdbAccount, alias: string, message: any): Promise<any> {
  if (message.method === "initialize") {
    sessions.delete(alias);
    initialized.delete(alias);
    const response = await request(env, account, alias, message);
    if (!response?.error) {
      initialized.add(alias);
      const session = sessions.get(alias);
      if (session) await request(env, account, alias, { jsonrpc: "2.0", method: "notifications/initialized", params: {} }, session);
    }
    return response;
  }
  if (!initialized.has(alias)) await initialize(env, account, alias);
  let session = sessions.get(alias);
  let response = await request(env, account, alias, message, session);
  if (response?.error?.code === -32000) {
    sessions.delete(alias);
    initialized.delete(alias);
    await initialize(env, account, alias);
    session = sessions.get(alias);
    response = await request(env, account, alias, message, session);
  }
  return response;
}

export function clearUpstreamSessions() { sessions.clear(); initialized.clear(); }