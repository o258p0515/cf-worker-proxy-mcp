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
    MCP_TOKEN: "cache-encryption-key-only", GIT_EXECUTOR_TOKEN: "executor-secret-that-is-at-least-32-bytes-long",
    RTDB_AUTH_URL: "https://unit.firebaseio.com/github_accounts.json?auth=unit-auth",
    CACHE_KV: kv(), OAUTH_KV: kv()
  } as any;
}
const auth = "Bearer executor-secret-that-is-at-least-32-bytes-long";
describe("internal Git credential provider", () => {
  beforeEach(async () => { await clearAccountCaches(makeEnv()); });
  afterEach(() => vi.unstubAllGlobals());
  it("rejects missing or incorrect executor token before accessing RTDB", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    for (const authorization of [undefined, "Bearer wrong"]) {
      const headers = new Headers({ "Content-Type": "application/json" });
      if (authorization) headers.set("Authorization", authorization);
      const response = await handleGitCredential(new Request("https://proxy.test/internal/runner/git-credential", {
        method: "POST", headers, body: JSON.stringify({ account: "personal", operation: "clone", repository: "https://github.com/octocat/Hello-World.git" })
      }), makeEnv());
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("fails closed when the Worker executor secret is not configured", async () => {
    const env = makeEnv(); delete env.GIT_EXECUTOR_TOKEN;
    const response = await handleGitCredential(new Request("https://proxy.test/internal/runner/git-credential", { method: "POST", headers: { Authorization: auth } }), env);
    expect(response.status).toBe(503);
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
  it("returns the selected RTDB credential only to the dedicated Git executor token", async () => {
    const original = { personal: { username: "octocat", token: "ghp_test_private", enabled: true, readonly: false, git_repositories: ["octocat/Hello-World"] } };
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: any) => {
      const url = String(input); calls.push(url);
      if (url.includes("unit.firebaseio.com")) return Response.json(original);
      throw new Error("unexpected URL " + url);
    }));
    const response = await handleGitCredential(new Request("https://proxy.test/internal/runner/git-credential", {
      method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ account: "personal", operation: "clone", repository: "https://github.com/octocat/Hello-World.git", actor: "ci-user", workflow_run_id: "12345" })
    }), makeEnv());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ account: "personal", username: "octocat", credential: "ghp_test_private" });
    expect(calls.some(url => url.includes("unit.firebaseio.com"))).toBe(true);
    expect(original.personal.token).toBe("ghp_test_private");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("denies repositories outside the account's exact RTDB allowlist", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: any) => {
      if (String(input).includes("unit.firebaseio.com")) return Response.json({ personal: { username: "octocat", token: "ghp_do_not_return", enabled: true, readonly: false, git_repositories: ["octocat/Hello-World"] } });
      throw new Error("unexpected URL " + input);
    }));
    const response = await handleGitCredential(new Request("https://proxy.test/internal/runner/git-credential", {
      method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ account: "personal", operation: "fetch", repository: "https://github.com/octocat/Other-Repo.git" })
    }), makeEnv());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "repository_not_allowlisted" });
  });
  it("requires a valid GitHub HTTPS repository and emits redacted audit metadata", async () => {
    const logs: string[] = [];
    const log = vi.spyOn(console, "info").mockImplementation((value: any) => logs.push(String(value)));
    vi.stubGlobal("fetch", vi.fn(async (input: any) => {
      if (String(input).includes("unit.firebaseio.com")) return Response.json({ personal: { username: "octocat", token: "ghp_secret_must_not_log", enabled: true, readonly: false, git_repositories: ["octocat/Hello-World"] } });
      throw new Error("unexpected URL " + input);
    }));
    const response = await handleGitCredential(new Request("https://proxy.test/internal/runner/git-credential", {
      method: "POST", headers: { Authorization: auth, "Content-Type": "application/json", "cf-ray": "test-ray" },
      body: JSON.stringify({ account: "personal", operation: "clone", repository: "https://github.com/octocat/Hello-World.git", actor: "ci-user", workflow_run_id: "987654" })
    }), makeEnv());
    expect(response.status).toBe(200);
    expect(logs.join("\\n")).toContain("ci-user");
    expect(logs.join("\\n")).toContain("987654");
    expect(logs.join("\\n")).toContain("octocat/hello-world");
    expect(logs.join("\\n")).not.toContain("ghp_secret_must_not_log");
    log.mockRestore();
  });
  it("rejects malformed repository targets before looking up account credentials", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const response = await handleGitCredential(new Request("https://proxy.test/internal/runner/git-credential", {
      method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ account: "personal", operation: "clone", repository: "https://evil.example/octocat/Hello-World" })
    }), makeEnv());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_repository" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not return readonly account credentials for push", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: any) => {
      if (String(input).includes("unit.firebaseio.com")) return Response.json({ personal: { username: "octocat", token: "ghp_readonly", enabled: true, readonly: true, git_repositories: ["octocat/Hello-World"] } });
      throw new Error("unexpected URL " + input);
    }));
    const response = await handleGitCredential(new Request("https://proxy.test/internal/runner/git-credential", {
      method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ account: "personal", operation: "push", repository: "https://github.com/octocat/Hello-World.git" })
    }), makeEnv());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "account_readonly" });
  });
  it("does not issue an empty Git credential for an Azure-only account", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: any) => {
      if (String(input).includes("unit.firebaseio.com")) return Response.json({ azure: { username: "azure", enabled: true, localmcpgo_secrets: { AZURE_DEVOPS_PAT: "azure-pat", AZURE_DEVOPS_ORG_URL: "https://dev.azure.com/example" }, git_repositories: ["azure/repo"] } });
      throw new Error("unexpected URL " + input);
    }));
    const response = await handleGitCredential(new Request("https://proxy.test/internal/runner/git-credential", {
      method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ account: "azure", operation: "clone", repository: "https://github.com/azure/repo.git" })
    }), makeEnv());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "github_credential_not_configured" });
  });

});
