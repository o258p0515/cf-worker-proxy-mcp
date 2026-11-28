import { afterEach, describe, expect, it, vi } from "vitest";
import { runLocalMcpHubControlTool } from "../src/mcp/localmcp-hub-control";
import { handleHubHandover } from "../src/mcp/hub-handover";
import {
  appendRoutingTags,
  deriveCustomAzureYamlPath,
  isCustomAzureYamlPath,
  isCustomGitHubWorkflowFilename,
  normalizeAzureYamlPath,
  normalizeGitHubWorkflowFilename,
  utf8ToBase64,
  validateAzureRunnerYaml,
  validateGitHubRunnerYaml
} from "../src/mcp/hub-workflow-utils";
import type { RtdbAccount } from "../src/types";

const VALID_GH_YAML = `name: Custom Postgres Runner
on:
  workflow_dispatch:
    inputs:
      runner_name:
        type: string
      runner_tags:
        type: string
      duration_seconds:
        type: number
      predecessor_id:
        type: string
      generation:
        type: string
      handover_after:
        type: string
      idle_timeout:
        type: string
jobs:
  runner:
    runs-on: ubuntu-latest
    steps:
      - name: Start
        env:
          HUB_URLS: \${{ secrets.HUB_URLS }}
          MCP_TOKEN: \${{ secrets.MCP_TOKEN }}
        run: echo "ok"
`;

const VALID_AZ_YAML = `parameters:
  - name: os
    type: string
    default: linux
  - name: runner_name
    type: string
    default: custom
  - name: runner_tags
    type: string
    default: go,postgres
  - name: duration_seconds
    type: number
    default: 3000
  - name: predecessor_id
    type: string
    default: none
  - name: generation
    type: number
    default: 1
  - name: handover_after
    type: number
    default: 0
  - name: idle_timeout
    type: number
    default: 0
steps:
  - bash: echo "$HUB_URLS $MCP_TOKEN"
`;

const ghAccount: RtdbAccount = {
  username: "o258p0515",
  description: "test gh",
  orgs: ["o258p0515"],
  enabled: true,
  readonly: false,
  token: "ghp_test_token_1234567890",
  localmcpgo_secrets: {
    HUB_URLS: "https://hub.o258p0515.dpdns.org",
    MCP_TOKEN: "0123456789abcdef0123456789abcdef"
  }
};

const azAccount: RtdbAccount = {
  username: "azuser",
  description: "test az",
  orgs: ["myorg"],
  enabled: true,
  readonly: false,
  token: "",
  localmcpgo_secrets: {
    AZURE_DEVOPS_PAT: "az_pat_secret_1234567890",
    AZURE_DEVOPS_ORG_URL: "https://dev.azure.com/myorg",
    HUB_URLS: "https://hub.o258p0515.dpdns.org",
    MCP_TOKEN: "0123456789abcdef0123456789abcdef"
  }
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("hub-workflow-utils", () => {
  it("normalizes filenames and enforces custom guardrails", () => {
    expect(normalizeGitHubWorkflowFilename(undefined)).toBe("hub-runner.yml");
    expect(normalizeGitHubWorkflowFilename(".github/workflows/hub-runner-pg.yml")).toBe("hub-runner-pg.yml");
    expect(() => normalizeGitHubWorkflowFilename("../deploy.yml")).toThrow();
    expect(isCustomGitHubWorkflowFilename("hub-runner-pg.yml")).toBe(true);
    expect(isCustomGitHubWorkflowFilename("hub-runner.yml")).toBe(false);
    expect(isCustomGitHubWorkflowFilename("deploy.yml")).toBe(false);

    expect(normalizeAzureYamlPath("pipelines/hub-runner-pg.yml")).toBe("/pipelines/hub-runner-pg.yml");
    expect(deriveCustomAzureYamlPath("Postgres App Runner")).toBe("/pipelines/hub-runner-postgres-app-runner.yml");
    expect(isCustomAzureYamlPath("/pipelines/hub-runner-pg.yml")).toBe(true);
    expect(isCustomAzureYamlPath("/azure-pipelines-pg.yml")).toBe(true);
    expect(isCustomAzureYamlPath("/azure-pipelines.yml")).toBe(false);
  });

  it("validates Raw YAML handover contracts for GitHub and Azure", () => {
    expect(validateGitHubRunnerYaml(VALID_GH_YAML).valid).toBe(true);
    const badGh = validateGitHubRunnerYaml("name: broken\non: push\n");
    expect(badGh.valid).toBe(false);
    expect(badGh.errors.some((e) => e.includes("workflow_dispatch"))).toBe(true);
    expect(badGh.errors.some((e) => e.includes("handover_after"))).toBe(true);

    expect(validateAzureRunnerYaml(VALID_AZ_YAML).valid).toBe(true);
    const badAz = validateAzureRunnerYaml("steps:\n  - bash: echo hi\n");
    expect(badAz.valid).toBe(false);
    expect(badAz.errors.some((e) => e.includes("parameters"))).toBe(true);
  });

  it("replaces routing tag prefixes cleanly", () => {
    expect(appendRoutingTags("go,gha,workflow:old.yml", ["workflow:hub-runner-pg.yml"])).toBe("go,gha,workflow:hub-runner-pg.yml");
  });
});

describe("GitHub Actions custom Raw YAML workflows & handover", () => {
  it("lists, reads, upserts, dispatches, and deletes custom GitHub workflows while protecting defaults", async () => {
    let dispatchedPath = "";
    let dispatchedInputs: Record<string, string> = {};
    let putCalled = false;
    let deleteCalled = false;

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method || "GET").toUpperCase();
      if (url.endsWith("/repos/o258p0515/localmcpcoder-go") && method === "GET") {
        return Response.json({ default_branch: "main" });
      }
      if (url.includes("/actions/workflows?per_page=100")) {
        return Response.json({
          workflows: [
            { id: 1, name: "LocalMCP Hub Runner", path: ".github/workflows/hub-runner.yml", state: "active" },
            { id: 2, name: "Custom Postgres", path: ".github/workflows/hub-runner-pg.yml", state: "active" }
          ]
        });
      }
      if (url.includes("/contents/.github/workflows/hub-runner-pg.yml") && method === "GET") {
        if (!putCalled) return Response.json({ message: "Not Found" }, { status: 404 });
        return Response.json({ sha: "abc123", content: utf8ToBase64(VALID_GH_YAML) });
      }
      if (url.includes("/contents/.github/workflows/hub-runner-pg.yml") && method === "PUT") {
        putCalled = true;
        return Response.json({ content: { sha: "abc123" }, commit: { sha: "commit123" } });
      }
      if (url.includes("/contents/.github/workflows/hub-runner-pg.yml") && method === "DELETE") {
        deleteCalled = true;
        return Response.json({ commit: { sha: "del123" } });
      }
      if (url.endsWith("/actions/workflows/hub-runner-pg.yml") && method === "GET") {
        return Response.json({ id: 2, path: ".github/workflows/hub-runner-pg.yml", state: "active" });
      }
      if (url.includes("/actions/secrets") && !url.includes("/public-key") && method === "GET") {
        return Response.json({ secrets: [{ name: "HUB_URLS" }, { name: "MCP_TOKEN" }] });
      }
      if (url.includes("/actions/secrets/public-key")) {
        return Response.json({ key_id: "kid1", key: Buffer.alloc(32, 7).toString("base64") });
      }
      if (url.includes("/actions/secrets/") && method === "PUT") {
        return new Response(null, { status: 204 });
      }
      if (url.endsWith("/actions/workflows/hub-runner-pg.yml/dispatches") && method === "POST") {
        dispatchedPath = url;
        dispatchedInputs = JSON.parse(String(init?.body || "{}")).inputs || {};
        return new Response(null, { status: 204 });
      }
      if (url.includes("/actions/workflows/hub-runner-pg.yml/runs")) {
        return Response.json({
          workflow_runs: [{ id: 999, event: "workflow_dispatch", status: "queued", created_at: new Date().toISOString() }]
        });
      }
      return Response.json({ message: "unexpected " + method + " " + url }, { status: 404 });
    }));

    const listed = await runLocalMcpHubControlTool("localmcp_hub_list_workflows", { provider: "github" }, ghAccount, "", "personal");
    expect((listed as any).workflows).toHaveLength(2);
    expect((listed as any).workflows[1].is_custom_managed).toBe(true);

    // Guardrail: refuse overwriting default hub-runner.yml or deploy.yml
    await expect(
      runLocalMcpHubControlTool("localmcp_hub_upsert_workflow", { provider: "github", workflow: "hub-runner.yml", yaml_content: VALID_GH_YAML }, ghAccount, "", "personal")
    ).rejects.toThrow(/hub-runner-<name>\.yml/);
    await expect(
      runLocalMcpHubControlTool("localmcp_hub_upsert_workflow", { provider: "github", workflow: "deploy.yml", yaml_content: VALID_GH_YAML }, ghAccount, "", "personal")
    ).rejects.toThrow(/hub-runner-<name>\.yml/);

    // Upsert custom workflow
    const created = await runLocalMcpHubControlTool(
      "localmcp_hub_upsert_workflow",
      { provider: "github", workflow: "hub-runner-pg.yml", yaml_content: VALID_GH_YAML },
      ghAccount,
      "",
      "personal"
    );
    expect((created as any).action).toBe("created");
    expect((created as any).handover_compatible).toBe(true);

    // Get custom workflow
    const fetched = await runLocalMcpHubControlTool(
      "localmcp_hub_get_workflow",
      { provider: "github", workflow: "hub-runner-pg.yml" },
      ghAccount,
      "",
      "personal"
    );
    expect((fetched as any).handover_compatible).toBe(true);
    expect((fetched as any).yaml_content).toContain("Custom Postgres Runner");

    // Start custom workflow -> attaches workflow:hub-runner-pg.yml tag
    const started = await runLocalMcpHubControlTool(
      "localmcp_hub_start",
      { provider: "github", workflow: "hub-runner-pg.yml", runner_name: "pg-node", runner_tags: "go,postgres", duration_seconds: 600 },
      ghAccount,
      "",
      "personal"
    );
    expect(dispatchedPath).toContain("/actions/workflows/hub-runner-pg.yml/dispatches");
    expect(dispatchedInputs.runner_tags).toBe("go,postgres,workflow:hub-runner-pg.yml");
    expect((started as any).workflow_file).toBe("hub-runner-pg.yml");

    // Delete custom workflow
    const deleted = await runLocalMcpHubControlTool(
      "localmcp_hub_delete_workflow",
      { provider: "github", workflow: "hub-runner-pg.yml" },
      ghAccount,
      "",
      "personal"
    );
    expect(deleteCalled).toBe(true);
    expect((deleted as any).deleted).toBe(true);
  });

  it("propagates workflow: tag during GitHub handover to dispatch the custom workflow", async () => {
    let dispatchedUrl = "";
    let dispatchedInputs: Record<string, string> = {};

    const env: any = {
      MCP_TOKEN: "0123456789abcdef0123456789abcdef",
      RTDB_AUTH_URL: "https://example.firebaseio.com/accounts.json?auth=test",
      CACHE_KV: { get: vi.fn(async () => null), put: vi.fn(), delete: vi.fn() }
    };

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method || "GET").toUpperCase();
      if (url.includes("firebaseio.com")) return Response.json({ personal: ghAccount });
      if (url.endsWith("/repos/o258p0515/localmcpcoder-go") && method === "GET") return Response.json({ default_branch: "main" });
      if (url.endsWith("/actions/workflows/hub-runner-pg.yml") && method === "GET") return Response.json({ id: 2, path: ".github/workflows/hub-runner-pg.yml", state: "active" });
      if (url.includes("/actions/secrets") && !url.includes("/public-key") && method === "GET") return Response.json({ secrets: [] });
      if (url.includes("/actions/secrets/public-key")) return Response.json({ key_id: "kid1", key: Buffer.alloc(32, 7).toString("base64") });
      if (url.includes("/actions/secrets/") && method === "PUT") return new Response(null, { status: 204 });
      if (url.endsWith("/actions/workflows/hub-runner-pg.yml/dispatches") && method === "POST") {
        dispatchedUrl = url;
        dispatchedInputs = JSON.parse(String(init?.body || "{}")).inputs || {};
        return new Response(null, { status: 204 });
      }
      if (url.includes("/actions/workflows/hub-runner-pg.yml/runs")) return Response.json({ workflow_runs: [] });
      return Response.json({ message: "unexpected " + url }, { status: 404 });
    }));

    const req = new Request("https://github-mcp-proxy/internal/hub/handover", {
      method: "POST",
      headers: { Authorization: "Bearer 0123456789abcdef0123456789abcdef", "Content-Type": "application/json" },
      body: JSON.stringify({
        predecessor_id: "gh-linux-100",
        provider: "github",
        account: "personal",
        os: "linux",
        repo: "o258p0515/localmcpcoder-go",
        tags: ["provider:github", "os:linux", "name:pg-node", "go", "postgres", "workflow:hub-runner-pg.yml"],
        generation: 2,
        duration_seconds: 600,
        handover_after: 300
      })
    });

    const res = await handleHubHandover(req, env);
    expect(res.status).toBe(200);
    expect(dispatchedUrl).toContain("/actions/workflows/hub-runner-pg.yml/dispatches");
    expect(dispatchedInputs.runner_tags).toBe("go,postgres,workflow:hub-runner-pg.yml");
    expect(dispatchedInputs.generation).toBe("2");
  });
});

describe("Azure DevOps custom Raw YAML pipelines & handover", () => {
  it("creates, starts without overwriting YAML, and routes handover via pipeline_id", async () => {
    let customYamlPushed = false;
    let defaultYamlTouched = false;
    let authorizedPipelineId = 0;
    let queuedPipelineId = 0;
    let queuedParams: Record<string, unknown> = {};

    const env: any = {
      MCP_TOKEN: "0123456789abcdef0123456789abcdef",
      RTDB_AUTH_URL: "https://example.firebaseio.com/accounts.json?auth=test",
      CACHE_KV: { get: vi.fn(async () => null), put: vi.fn(), delete: vi.fn() }
    };

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method || "GET").toUpperCase();
      if (url.includes("firebaseio.com")) return method === "GET" ? Response.json({ azure1: azAccount }) : Response.json({ ok: true });
      if (url.includes("/_apis/projects")) return Response.json({ value: [{ id: "p1", name: "me", state: "wellFormed" }] });
      if (url.includes("/_apis/git/repositories") && !url.includes("/refs") && !url.includes("/items") && !url.includes("/pushes")) {
        return Response.json({ value: [{ id: "r1", name: "me", defaultBranch: "refs/heads/main" }] });
      }
      if (url.includes("/_apis/pipelines?") || url.endsWith("/_apis/pipelines?api-version=7.1")) {
        if (method === "POST") {
          return Response.json({ id: 55, name: "Postgres Runner", folder: "\\", url: "https://dev.azure.com/myorg/me/_build?definitionId=55" });
        }
        return Response.json({
          value: [
            { id: 40, name: "LocalMCP Hub Runner" },
            ...(customYamlPushed ? [{ id: 55, name: "Postgres Runner" }] : [])
          ]
        });
      }
      if (url.includes("/_apis/pipelines/55/runs") && method === "POST") {
        queuedPipelineId = 55;
        queuedParams = JSON.parse(String(init?.body || "{}")).templateParameters || {};
        return Response.json({ id: 700, name: "20261128.1", state: "inProgress" });
      }
      if (url.includes("/_apis/pipelines/55")) {
        return Response.json({ id: 55, name: "Postgres Runner", configuration: { type: "yaml", path: "/pipelines/hub-runner-postgres-runner.yml", repository: { id: "r1", name: "me" } } });
      }
      if (url.includes("/_apis/pipelines/40")) {
        return Response.json({ id: 40, name: "LocalMCP Hub Runner", configuration: { type: "yaml", path: "/azure-pipelines.yml", repository: { id: "r1", name: "me" } } });
      }
      if (url.includes("/refs?")) return Response.json({ value: [{ name: "refs/heads/main", objectId: "sha1" }] });
      if (url.includes("/items?")) {
        if (url.includes("azure-pipelines.yml")) defaultYamlTouched = true;
        if (customYamlPushed && url.includes("hub-runner-postgres-runner.yml")) {
          return Response.json({ content: VALID_AZ_YAML });
        }
        return Response.json({ message: "Not Found" }, { status: 404 });
      }
      if (url.includes("/pushes") && method === "POST") {
        const body = JSON.parse(String(init?.body || "{}"));
        const pushedPath = body.commits?.[0]?.changes?.[0]?.item?.path;
        if (pushedPath === "/azure-pipelines.yml") defaultYamlTouched = true;
        if (pushedPath === "/pipelines/hub-runner-postgres-runner.yml") customYamlPushed = true;
        return Response.json({ pushId: 1 });
      }
      if (url.includes("/distributedtask/variablegroups") && method === "GET") {
        return Response.json({ value: [{ id: 9, name: "LocalMCP-Hub-azure1" }] });
      }
      if (url.includes("/distributedtask/variablegroups/9") && method === "PUT") {
        return Response.json({ id: 9, name: "LocalMCP-Hub-azure1" });
      }
      if (url.includes("/pipelinepermissions/variablegroup/9") && method === "PATCH") {
        const body = JSON.parse(String(init?.body || "{}"));
        authorizedPipelineId = Number(body.pipelines?.[0]?.id || 0);
        return Response.json({ pipelines: body.pipelines });
      }
      if (url.includes("/_apis/build/builds/700")) {
        return Response.json({ id: 700, buildNumber: "20261128.1", status: "inProgress", templateParameters: queuedParams });
      }
      return Response.json({ message: "unexpected " + method + " " + url }, { status: 404 });
    }));

    const upserted = await runLocalMcpHubControlTool(
      "localmcp_hub_upsert_workflow",
      { provider: "azure", pipeline: "Postgres Runner", yaml_content: VALID_AZ_YAML },
      azAccount,
      "",
      "azure1",
      env
    );
    expect(customYamlPushed).toBe(true);
    expect(authorizedPipelineId).toBe(55);
    expect((upserted as any).pipeline.id).toBe(55);
    expect((upserted as any).yaml_path).toBe("/pipelines/hub-runner-postgres-runner.yml");

    // Start custom pipeline: must NOT touch /azure-pipelines.yml and must attach routing tags
    const started = await runLocalMcpHubControlTool(
      "localmcp_hub_start",
      { provider: "azure", pipeline: "Postgres Runner", runner_name: "az-pg", runner_tags: "go,postgres", duration_seconds: 420, handover_after: 300 },
      azAccount,
      "",
      "azure1",
      env
    );
    expect(defaultYamlTouched).toBe(false);
    expect(queuedPipelineId).toBe(55);
    expect(String(queuedParams.runner_tags)).toContain("pipeline_id:55");
    expect(String(queuedParams.runner_tags)).toContain("project:me");
    expect(String(queuedParams.runner_tags)).toContain("azrepo:me");
    expect((started as any).pipeline.yaml_path).toBe("/pipelines/hub-runner-postgres-runner.yml");

    // Handover from Gen 1 -> Gen 2 routes directly back to pipeline_id 55
    queuedPipelineId = 0;
    const handoverReq = new Request("https://github-mcp-proxy/internal/hub/handover", {
      method: "POST",
      headers: { Authorization: "Bearer 0123456789abcdef0123456789abcdef", "Content-Type": "application/json" },
      body: JSON.stringify({
        predecessor_id: "az-linux-700",
        provider: "azure",
        account: "azure1",
        os: "linux",
        tags: ["provider:azure", "os:linux", "name:az-pg", "go", "postgres", "pipeline_id:55", "project:me", "azrepo:me"],
        generation: 2,
        duration_seconds: 420,
        handover_after: 300
      })
    });
    const handoverRes = await handleHubHandover(handoverReq, env);
    expect(handoverRes.status).toBe(200);
    expect(queuedPipelineId).toBe(55);
    expect(defaultYamlTouched).toBe(false);
  });
});
