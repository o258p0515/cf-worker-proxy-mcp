import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import nacl from "tweetnacl";
import worker from "../src/index";
import { handleHubHandover } from "../src/mcp/hub-handover";
import { clearAccountCaches } from "../src/rtdb/account-store";

function kv() {
  const values = new Map<string, string>();
  return {
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string) => { values.set(key, value); },
    delete: async (key: string) => values.delete(key)
  } as any;
}

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    MCP_TOKEN: "test-mcp-token-at-least-32-chars-0123456789",
    HUB_CONTROL_TOKEN: "handover-control-secret-at-least-32-chars",
    RTDB_AUTH_URL: "https://unit.firebaseio.com/github_accounts.json?auth=unit-auth",
    PUBLIC_ORIGIN: "https://proxy.example.com",
    CACHE_KV: kv(),
    OAUTH_KV: kv(),
    ...overrides
  } as any;
}

const controlAuth = "Bearer handover-control-secret-at-least-32-chars";

function mockGitHubDispatchFetch(accountsPayload: Record<string, unknown>) {
  const pair = nacl.box.keyPair();
  const publicKeyB64 = Buffer.from(pair.publicKey).toString("base64");
  const dispatchCalls: Array<{ url: string; body: any }> = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method || "GET").toUpperCase();

    if (url.startsWith("https://unit.firebaseio.com/")) {
      return Response.json(accountsPayload);
    }
    if (url.includes("/actions/secrets/public-key")) {
      return Response.json({ key_id: "key-1", key: publicKeyB64 });
    }
    if (url.includes("/actions/secrets") && method === "GET") {
      return Response.json({ secrets: [{ name: "HUB_URLS" }, { name: "MCP_TOKEN" }] });
    }
    if (url.includes("/actions/secrets/") && method === "PUT") {
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/actions/workflows/hub-runner.yml")) {
      return Response.json({ id: 99, path: ".github/workflows/hub-runner.yml", state: "active" });
    }
    if (url.endsWith("/actions/workflows/hub-runner.yml/dispatches") && method === "POST") {
      dispatchCalls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(null, { status: 204 });
    }
    if (url.includes("/actions/workflows/hub-runner.yml/runs")) {
      return Response.json({
        workflow_runs: [{
          id: 777001,
          event: "workflow_dispatch",
          status: "queued",
          conclusion: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          html_url: "https://github.com/o258p0515/localmcpcoder-go/actions/runs/777001",
          head_branch: "main",
          run_number: 42
        }]
      });
    }
    if (url === "https://api.github.com/repos/o258p0515/localmcpcoder-go") {
      return Response.json({ default_branch: "main" });
    }
    return new Response("unhandled mock url: " + url, { status: 500 });
  });

  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, dispatchCalls };
}

describe("internal Hub handover bridge", () => {
  beforeEach(async () => {
    await clearAccountCaches(makeEnv());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects unauthorized requests and omits wildcard CORS on OPTIONS", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const optRes = await worker.fetch(new Request("https://proxy.example.com/internal/hub/handover", {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example" }
    }), makeEnv());
    expect(optRes.status).toBe(405);
    expect(optRes.headers.get("Access-Control-Allow-Origin")).toBeNull();

    for (const header of [undefined, "Bearer wrong-token"]) {
      const headers = new Headers({ "Content-Type": "application/json" });
      if (header) headers.set("Authorization", header);
      const res = await handleHubHandover(new Request("https://proxy.example.com/internal/hub/handover", {
        method: "POST",
        headers,
        body: JSON.stringify({ predecessor_id: "gha-1", generation: 2 })
      }), makeEnv());
      expect(res.status).toBe(401);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("validates payload fields before touching RTDB", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const badId = await handleHubHandover(new Request("https://proxy.example.com/internal/hub/handover", {
      method: "POST",
      headers: { Authorization: controlAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ predecessor_id: "", generation: 2 })
    }), makeEnv());
    expect(badId.status).toBe(400);

    const badGen = await handleHubHandover(new Request("https://proxy.example.com/internal/hub/handover", {
      method: "POST",
      headers: { Authorization: controlAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ predecessor_id: "gha-1", generation: 1 })
    }), makeEnv());
    expect(badGen.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips spawning replacement for persistent providers (instabox/upstashbox)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    for (const provider of ["instabox", "upstashbox"]) {
      const res = await handleHubHandover(new Request("https://proxy.example.com/internal/hub/handover", {
        method: "POST",
        headers: { Authorization: controlAuth, "Content-Type": "application/json" },
        body: JSON.stringify({ predecessor_id: "sb-1", provider, generation: 2 })
      }), makeEnv());
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ skipped: true, reason: "persistent_provider_uses_resume", provider });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("dispatches GitHub Actions Gen 2 preserving pair tags and normalizing runner_name", async () => {
    const { dispatchCalls } = mockGitHubDispatchFetch({
      personal: {
        username: "o258p0515",
        token: "ghp_test_token_1234567890",
        description: "Personal",
        orgs: ["o258p0515"],
        enabled: true,
        readonly: false,
        localmcpgo_secrets: {
          HUB_URLS: "https://hub.o258p0515.dpdns.org",
          MCP_TOKEN: "test-mcp-token-at-least-32-chars-0123456789"
        }
      }
    });

    const res = await worker.fetch(new Request("https://proxy.example.com/internal/hub/handover", {
      method: "POST",
      headers: { Authorization: controlAuth, "Content-Type": "application/json" },
      body: JSON.stringify({
        predecessor_id: "build-01-g2-45910724598",
        provider: "github",
        account: "personal",
        os: "linux",
        repo: "o258p0515/localmcpcoder-go",
        tags: ["provider:github", "os:linux", "account:personal", "name:build-01-g2", "pair:team-1", "agent", "go"],
        generation: 3,
        duration_seconds: 3600
      })
    }), makeEnv());

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toMatchObject({
      dispatched: true,
      predecessor_id: "build-01-g2-45910724598",
      generation: 3,
      target_provider: "github",
      target_account: "personal"
    });
    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0]!.body.inputs).toMatchObject({
      runner_name: "build-01-g3",
      runner_os: "linux",
      account_alias: "personal",
      predecessor_id: "build-01-g2-45910724598",
      generation: "3",
      duration_seconds: "3600"
    });
    expect(dispatchCalls[0]!.body.inputs.runner_tags).toContain("pair:team-1");
    expect(dispatchCalls[0]!.body.inputs.runner_tags).toContain("agent");
    expect(dispatchCalls[0]!.body.inputs.runner_tags).not.toContain("provider:github");
  });

  it("falls back from Azure DevOps to GitHub Actions when no writable Azure account is available", async () => {
    const { dispatchCalls } = mockGitHubDispatchFetch({
      "azure-acc": {
        username: "azureuser",
        token: "",
        description: "Azure readonly",
        orgs: ["azureuser"],
        enabled: true,
        readonly: true,
        localmcpgo_secrets: {
          AZURE_DEVOPS_PAT: "azpat-secret",
          AZURE_DEVOPS_ORG_URL: "https://dev.azure.com/azureuser"
        }
      },
      personal: {
        username: "o258p0515",
        token: "ghp_test_token_1234567890",
        description: "Personal",
        orgs: ["o258p0515"],
        enabled: true,
        readonly: false,
        localmcpgo_secrets: {
          HUB_URLS: "https://hub.o258p0515.dpdns.org",
          MCP_TOKEN: "test-mcp-token-at-least-32-chars-0123456789"
        }
      }
    });

    const res = await handleHubHandover(new Request("https://proxy.example.com/internal/hub/handover", {
      method: "POST",
      headers: { Authorization: controlAuth, "Content-Type": "application/json" },
      body: JSON.stringify({
        predecessor_id: "az-win-1001",
        provider: "azure",
        account: "azure-acc",
        os: "windows",
        tags: ["provider:azure", "os:windows", "agent", "pair:his-win"],
        generation: 2
      })
    }), makeEnv());

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toMatchObject({
      dispatched: true,
      target_provider: "github",
      target_account: "personal",
      fallback_from: "azure"
    });
    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0]!.body.inputs).toMatchObject({
      runner_os: "windows",
      predecessor_id: "az-win-1001",
      generation: "2"
    });
    expect(dispatchCalls[0]!.body.inputs.runner_tags).toContain("pair:his-win");
  });
});
