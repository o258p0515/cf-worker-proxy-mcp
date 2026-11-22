import { describe, it, expect } from "vitest";
import type { Env } from "../src/types";
import { handleApiRpc, swaggerPage } from "../src/api/swagger";

const env = {
  MCP_API_PASSPHRASE: "test-passphrase-that-is-long-enough",
  MCP_OAUTH_CLIENT_ID: "test-client-id-123",
  MCP_OAUTH_CLIENT_SECRET: "test-client-secret-that-is-long-enough",
} as Env;

function request(headers: Record<string, string> = {}) {
  return new Request("https://example.test/api/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }),
  });
}

describe("MCP Tool Dashboard", () => {
  it("serves the account-aware dashboard without caching", async () => {
    const response = swaggerPage();
    const body = await response.text();
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toContain("GitHub MCP");
    expect(body).toContain("/api/rpc");
    expect(body).toContain("Tool catalog");
    expect(body).toContain("Checklist dọn dữ liệu thử");
    expect(body).toContain("data-ac");
  });

  it("rejects requests without all three credentials", async () => {
    const response = await handleApiRpc(request(), env);
    expect(response.status).toBe(401);
  });

  it("accepts the configured passphrase and OAuth client pair", async () => {
    const response = await handleApiRpc(request({
      "X-API-Passphrase": env.MCP_API_PASSPHRASE!,
      "X-API-Client-Id": env.MCP_OAUTH_CLIENT_ID!,
      "X-API-Client-Secret": env.MCP_OAUTH_CLIENT_SECRET!,
    }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ jsonrpc: "2.0", id: 1, result: {} });
  });

  it("rejects an incorrect client secret", async () => {
    const response = await handleApiRpc(request({
      "X-API-Passphrase": env.MCP_API_PASSPHRASE!,
      "X-API-Client-Id": env.MCP_OAUTH_CLIENT_ID!,
      "X-API-Client-Secret": "wrong-secret",
    }), env);
    expect(response.status).toBe(401);
  });
});
