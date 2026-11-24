import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleGitCredential } from "../src/mcp/git-credential";
import worker from "../src/index";
import { clearAccountCaches } from "../src/rtdb/account-store";

function kv() {
  const values = new Map<string, string>();
  return { get: async (key: string) => values.get(key) ?? null, put: async (key: string, value: string) => { values.set(key, value); }, delete: async (key: string) => values.delete(key) } as any;
}
function makeEnv() {
  return {
    MCP_TOKEN: "cache-encryption-key-only",
    RTDB_AUTH_URL: "https://unit.firebaseio.com/github_accounts.json?auth=unit-auth",
    CACHE_KV: kv(), OAUTH_KV: kv()
  } as any;
}
function b64url(value: Uint8Array | string) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
async function signedOIDC() {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1,0,1]), hash: "SHA-256" }, true, ["sign","verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey) as JsonWebKey & { kid?: string };
  jwk.kid = "test-key-" + crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: "https://token.actions.githubusercontent.com", aud: "localmcpcoder-git-credential",
    exp: now + 300, iat: now, repository: "o258p0515/localmcpcoder-go", repository_owner: "o258p0515",
    workflow_ref: "o258p0515/localmcpcoder-go/.github/workflows/git-executor-runner.yml@refs/heads/main",
    ref: "refs/heads/main", event_name: "workflow_dispatch",
    sub: "repo:o258p0515/localmcpcoder-go:ref:refs/heads/main", runner_environment: "github-hosted"
  };
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: jwk.kid }));
  const body = b64url(JSON.stringify(claims));
  const input = head + "." + body;
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(input)));
  return { token: input + "." + b64url(signature), jwk };
}

describe("internal Git credential provider", () => {
  beforeEach(async () => { await clearAccountCaches(makeEnv()); });
  afterEach(() => vi.unstubAllGlobals());

  it("rejects missing identity before accessing RTDB", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const response = await handleGitCredential(new Request("https://proxy.test/internal/runner/git-credential", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account: "personal", operation: "clone" })
    }), makeEnv());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not attach wildcard CORS to the internal credential route", async () => {
    const response = await worker.fetch(new Request("https://proxy.test/internal/runner/git-credential", { method: "OPTIONS", headers: { Origin: "https://attacker.example" } }), makeEnv());
    expect(response.status).toBe(405);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("rejects methods other than POST", async () => {
    const response = await handleGitCredential(new Request("https://proxy.test/internal/runner/git-credential"), makeEnv());
    expect(response.status).toBe(405);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("returns the selected RTDB credential only to a correctly signed Git executor workload", async () => {
    const { token, jwk } = await signedOIDC();
    const original = { personal: { username: "octocat", token: "ghp_test_private", enabled: true, readonly: false } };
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: any) => {
      const url = String(input); calls.push(url);
      if (url.includes("/.well-known/jwks")) return Response.json({ keys: [jwk] });
      if (url.includes("unit.firebaseio.com")) return Response.json(original);
      throw new Error("unexpected URL " + url);
    }));
    const response = await handleGitCredential(new Request("https://proxy.test/internal/runner/git-credential", {
      method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ account: "personal", operation: "clone" })
    }), makeEnv());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ account: "personal", username: "octocat", credential: "ghp_test_private" });
    expect(calls.some(url => url.includes("unit.firebaseio.com"))).toBe(true);
    expect(original.personal.token).toBe("ghp_test_private");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("does not return readonly account credentials for push", async () => {
    const { token, jwk } = await signedOIDC();
    vi.stubGlobal("fetch", vi.fn(async (input: any) => {
      const url = String(input);
      if (url.includes("/.well-known/jwks")) return Response.json({ keys: [jwk] });
      if (url.includes("unit.firebaseio.com")) return Response.json({ personal: { username: "octocat", token: "ghp_readonly", enabled: true, readonly: true } });
      throw new Error("unexpected URL " + url);
    }));
    const response = await handleGitCredential(new Request("https://proxy.test/internal/runner/git-credential", {
      method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ account: "personal", operation: "push" })
    }), makeEnv());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "account_readonly" });
  });
});
