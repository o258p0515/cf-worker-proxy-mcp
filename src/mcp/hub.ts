import type { AuthContext, McpTool, RtdbAccount } from "../types";

export const HUB_TOOL_PREFIX = "hub__";
const HUB_META_TOOLS: McpTool[] = [
  { name: "list_runners", description: "List runners connected to LocalMCP Hub, including online status, OS, architecture and tags.", inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false } },
  { name: "select_runner", description: "Pin this MCP session to one online LocalMCP Hub runner.", inputSchema: { type: "object", properties: { runner_id: { type: "string", description: "Runner ID returned by list_runners." } }, required: ["runner_id"], additionalProperties: false } },
  { name: "get_job_result", description: "Retrieve the status and result of an asynchronous tool call executed through LocalMCP Hub.", inputSchema: { type: "object", properties: { runner_id: { type: "string" }, job_id: { type: "string" } }, required: ["runner_id", "job_id"], additionalProperties: false } }
];
function secrets(account: RtdbAccount): Record<string, string> {
  return account.localmcpgo_secrets && typeof account.localmcpgo_secrets === "object" ? account.localmcpgo_secrets : {};
}
function hubUrls(account: RtdbAccount): string[] {
  return [...new Set((secrets(account).HUB_URLS || "").split(",").map(value => value.trim().replace(/\/+$/, "")).filter(Boolean))];
}
function validateHubUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) throw new Error("HUB_URLS must contain HTTPS Hub base URLs (HTTP is allowed only for localhost).");
  if (url.username || url.password || url.search || url.hash) throw new Error("HUB_URLS entries must be clean base URLs without credentials, query strings or fragments.");
  return url.toString().replace(/\/+$/, "");
}
async function sessionId(ctx: AuthContext): Promise<string> {
  const source = new TextEncoder().encode("localmcp-hub:" + ctx.method + ":" + (ctx.sessionId || ctx.subject));
  const digest = await crypto.subtle.digest("SHA-256", source);
  return Array.from(new Uint8Array(digest)).map(value => value.toString(16).padStart(2, "0")).join("").slice(0, 40);
}
const DEFAULT_HUB_URL = "https://hub.o258p0515.dpdns.org";
function hubConfig(account: RtdbAccount, fallbackToken = "", fallbackOrigin = "") {
  const configured = secrets(account);
  const token = configured.MCP_TOKEN || fallbackToken;
  const configuredUrls = hubUrls(account);
  const fallbackUrls = String(fallbackOrigin || DEFAULT_HUB_URL).split(",").map(value => value.trim()).filter(Boolean);
  const urls = (configuredUrls.length ? configuredUrls : fallbackUrls).map(validateHubUrl);
  if (!token) throw new Error("MCP_TOKEN is not available to the Proxy for Hub authentication. Configure it in RTDB localmcpgo_secrets or align the Proxy MCP_TOKEN with the Hub MCP_TOKEN.");
  if (!urls.length) throw new Error("HUB_URLS is missing and no default Hub origin is configured.");
  return { token, urls, url_source: configuredUrls.length ? "RTDB localmcpgo_secrets" : fallbackOrigin ? "Proxy LOCALMCP_HUB_ORIGIN" : "built-in default" };
}
async function hubFetch(base: string, path: string, init: RequestInit, service?: Fetcher, serviceOrigin?: string): Promise<Response> {
  if (service && serviceOrigin && new URL(base).origin === new URL(serviceOrigin).origin) {
    return service.fetch(new Request(base + path, init));
  }
  return fetch(base + path, init);
}
async function requestHub(base: string, token: string, session: string, rpc: Record<string, unknown>, service?: Fetcher, serviceOrigin?: string): Promise<any> {
  const response = await hubFetch(base, "/mcp", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json", "Mcp-Session-Id": session },
    body: JSON.stringify({ jsonrpc: "2.0", ...rpc }),
    signal: AbortSignal.timeout(55_000)
  }, service, serviceOrigin);
  const body = await response.text();
  let parsed: any = {};
  try { parsed = body ? JSON.parse(body) : {}; } catch { throw new Error("Hub " + base + " returned non-JSON HTTP " + response.status + "."); }
  if (!response.ok) throw new Error("Hub " + base + " returned HTTP " + response.status + (body ? ": " + body.slice(0, 500) : ""));
  if (parsed.error) throw new Error(String(parsed.error.message || "Hub MCP request failed"));
  return parsed.result ?? {};
}
export async function getHubTools(account: RtdbAccount, ctx: AuthContext, fallbackToken = "", service?: Fetcher, serviceOrigin?: string): Promise<McpTool[]> {
  let configured: ReturnType<typeof hubConfig>;
  try { configured = hubConfig(account, fallbackToken, serviceOrigin); } catch { return HUB_META_TOOLS.map(tool => ({ ...tool, name: HUB_TOOL_PREFIX + tool.name, description: "LocalMCP Hub: " + tool.description })); }
  const fallback = HUB_META_TOOLS.map(tool => ({ ...tool, name: HUB_TOOL_PREFIX + tool.name, description: "LocalMCP Hub: " + tool.description }));
  const session = await sessionId(ctx);
  for (const base of configured.urls) {
    try {
      const result = await requestHub(base, configured.token, session, { id: "proxy-hub-tools-list", method: "tools/list", params: {} }, service, serviceOrigin);
      const tools = Array.isArray(result.tools) ? result.tools as McpTool[] : [];
      return (tools.length ? tools : HUB_META_TOOLS).map(tool => ({ ...tool, name: HUB_TOOL_PREFIX + tool.name, description: "LocalMCP Hub: " + String(tool.description || tool.name) }));
    } catch { /* Try the next configured Hub URL. */ }
  }
  return fallback;
}
export async function callHubTool(name: string, args: Record<string, unknown>, account: RtdbAccount, ctx: AuthContext, fallbackToken = "", service?: Fetcher, serviceOrigin?: string) {
  const toolName = name.startsWith(HUB_TOOL_PREFIX) ? name.slice(HUB_TOOL_PREFIX.length) : name;
  if (!toolName || !/^[A-Za-z0-9_.-]{1,128}$/.test(toolName)) throw new Error("Invalid LocalMCP Hub tool name.");
  const { token, urls } = hubConfig(account, fallbackToken, serviceOrigin);
  const session = await sessionId(ctx);
  const failures: string[] = [];
  for (const base of urls) {
    try { return await requestHub(base, token, session, { id: "proxy-hub-call-" + crypto.randomUUID(), method: "tools/call", params: { name: toolName, arguments: args } }, service, serviceOrigin); }
    catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
  }
  throw new Error("Unable to reach any configured LocalMCP Hub. " + failures.join(" | "));
}
export async function checkHubConnection(account: RtdbAccount, fallbackToken = "", service?: Fetcher, serviceOrigin?: string) {
  let configured: ReturnType<typeof hubConfig>;
  try { configured = hubConfig(account, fallbackToken, serviceOrigin); } catch (error) { return { ready: false, reason: error instanceof Error ? error.message : String(error) }; }
  const checks: Array<Record<string, unknown>> = [];
  for (const base of configured.urls) {
    try {
      const health = await hubFetch(base, "/health", { signal: AbortSignal.timeout(10_000) }, service, serviceOrigin);
      const healthBody: any = await health.json().catch(() => ({}));
      if (!health.ok || healthBody.status !== "ok") { checks.push({ hub: base, ready: false, health_status: health.status, health_body: healthBody }); continue; }
      const initialized = await requestHub(base, configured.token, "proxy-health-check", { id: "proxy-hub-initialize", method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "github-mcp-proxy", version: "1" } } }, service, serviceOrigin);
      checks.push({ hub: base, ready: !!initialized.serverInfo, health_status: health.status, server_info: initialized.serverInfo ?? null });
    } catch (error) { checks.push({ hub: base, ready: false, reason: error instanceof Error ? error.message : String(error) }); }
  }
  return { ready: checks.some(item => item.ready === true), hubs: checks };
}
