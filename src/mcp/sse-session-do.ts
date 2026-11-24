import type { Env, AuthContext, JsonRpc } from "../types";
import { handleJsonRpcMessage } from "./proxy-core";

export class SseSessionDO {
  private state: DurableObjectState;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private env: Env;
  private auth: AuthContext | null = null;
  private lastActivityAt = 0;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  private closeStream() {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
    const writer = this.writer;
    this.writer = null;
    if (writer) writer.close().catch(() => { });
  }

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private async handleAccountSelection(req: Request): Promise<Response> {
    if (req.method === "GET") {
      const saved = await this.state.storage.get<{ alias: string; expiresAt: number }>("account-selection");
      if (!saved || saved.expiresAt <= Date.now()) {
        if (saved) await this.state.storage.delete("account-selection");
        return Response.json({ alias: null });
      }
      return Response.json({ alias: saved.alias });
    }
    if (req.method === "PUT") {
      let body: any;
      try { body = await req.json(); } catch { return Response.json({ error: "Invalid JSON body" }, { status: 400 }); }
      const alias = typeof body?.alias === "string" ? body.alias.trim() : "";
      if (!alias) return Response.json({ error: "alias is required" }, { status: 400 });
      await this.state.storage.put("account-selection", { alias, expiresAt: Date.now() + 86400000 });
      return Response.json({ ok: true });
    }
    if (req.method === "DELETE") {
      await this.state.storage.delete("account-selection");
      return Response.json({ ok: true });
    }
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, PUT, DELETE" } });
  }

  async fetch(req: Request): Promise<Response> {
    const u = new URL(req.url);
    if (u.pathname === "/_internal/account-selection") return this.handleAccountSelection(req);

    const method = req.headers.get("X-Proxy-Auth-Method");
    if (method === "oauth" || method === "static_token") {
      this.auth = {
        method,
        subject: req.headers.get("X-Proxy-Subject") || "proxy",
        pinnedAccount: req.headers.get("X-GitHub-Account") || undefined
      };
    }
    if (req.method === "GET" && u.pathname.endsWith("/sse")) {
      this.closeStream();
      const stream = new TransformStream<Uint8Array, Uint8Array>();
      this.writer = stream.writable.getWriter();
      this.lastActivityAt = Date.now();
      const sessionId = u.searchParams.get("sessionId") || "";
      this.writer.write(new TextEncoder().encode("event: endpoint\ndata: /messages?sessionId=" + encodeURIComponent(sessionId) + "\n\n")).catch(() => this.closeStream());
      const writer = this.writer;
      const idleTimeoutMs = 20 * 60 * 1000;
      this.keepaliveTimer = setInterval(() => {
        if (Date.now() - this.lastActivityAt >= idleTimeoutMs) {
          this.closeStream();
          return;
        }
        writer.write(new TextEncoder().encode(": keepalive\n\n")).catch(() => this.closeStream());
      }, 25000);
      req.signal.addEventListener("abort", () => this.closeStream(), { once: true });
      return new Response(stream.readable, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" } });
    }
    if (req.method === "POST" && u.pathname.endsWith("/messages")) {
      if (!this.writer) return Response.json({ error: "SSE session not found or closed. Reconnect to /sse." }, { status: 404 });
      this.lastActivityAt = Date.now();
      const msg = await req.json() as JsonRpc;
      const response = await handleJsonRpcMessage(msg, this.env, this.auth || { method: "static_token", subject: "sse" });
      if (response) await this.writer.write(new TextEncoder().encode("event: message\ndata: " + JSON.stringify(response) + "\n\n"));
      return new Response(null, { status: 202 });
    }
    return new Response("Not Found", { status: 404 });
  }

  setAuth(auth: AuthContext) { this.auth = auth; }
}
