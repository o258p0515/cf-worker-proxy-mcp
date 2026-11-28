const endpoint = String(process.env.TARGET_DOMAIN || process.env.PREVIEW_DOMAIN || "").replace(/\/$/, "") + "/mcp";
const token = String(process.env.MCP_TOKEN || "");
const ghAlias = "personal";
const azAlias = "azure-aerielaaeriel651971";
const azProject = "me";
const azRepo = "me";

if (!endpoint.startsWith("https://") || token.length < 16) {
  throw new Error("TARGET_DOMAIN/PREVIEW_DOMAIN or MCP_TOKEN is not configured.");
}

let rpcId = 0;
async function call(name, args = {}) {
  const response = await fetch(endpoint, {
    method: "POST",
    signal: AbortSignal.timeout(30000),
    headers: { "X-API-Key": token, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } })
  });
  const raw = await response.text();
  let message;
  try { message = raw ? JSON.parse(raw) : {}; } catch { throw new Error(name + " returned non-JSON HTTP " + response.status); }
  const text = message.result?.content?.find((item) => item.type === "text")?.text;
  if (!response.ok || message.error || message.result?.isError) {
    throw new Error(name + " failed (HTTP " + response.status + "): " + String(text || message.error?.message || raw).slice(0, 1200));
  }
  if (typeof text === "string") {
    try { return JSON.parse(text); } catch { return text; }
  }
  return message.result;
}

async function expectFailure(label, fn) {
  let failed = false;
  try {
    await fn();
  } catch (err) {
    failed = true;
    console.log(`[PASS guardrail] ${label}: ${err instanceof Error ? err.message.slice(0, 140) : String(err)}`);
  }
  if (!failed) throw new Error(`Expected guardrail failure for: ${label}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function testGitHubCustomWorkflow() {
  console.log("\n=== 1. GitHub Actions Custom Raw YAML E2E ===");
  await call("select_github_account", { alias: ghAlias });

  const listed = await call("localmcp_hub_list_workflows", { provider: "github" });
  const defaultWf = (listed.workflows || []).find((w) => w.filename === "hub-runner.yml");
  if (!defaultWf) throw new Error("Default hub-runner.yml not found in GitHub list_workflows");
  console.log(`[PASS] list_workflows (github): found ${listed.workflows.length} workflows including default hub-runner.yml`);

  const got = await call("localmcp_hub_get_workflow", { provider: "github", workflow: "hub-runner.yml" });
  if (!got.handover_compatible || typeof got.yaml_content !== "string") {
    throw new Error("Default hub-runner.yml failed handover compatibility: " + JSON.stringify(got.validation_errors));
  }
  console.log(`[PASS] get_workflow (github): read default hub-runner.yml (${got.yaml_content.length} bytes, handover_compatible=true)`);

  await expectFailure("block overwriting default hub-runner.yml", () =>
    call("localmcp_hub_upsert_workflow", { provider: "github", workflow: "hub-runner.yml", yaml_content: got.yaml_content })
  );
  await expectFailure("block invalid Raw YAML without handover inputs", () =>
    call("localmcp_hub_upsert_workflow", { provider: "github", workflow: "hub-runner-bad-e2e.yml", yaml_content: "name: bad\non: push\n" })
  );

  const customName = `hub-runner-e2e-${Date.now().toString(36)}.yml`;
  const customYaml = got.yaml_content.replace(
    /^name:\s*.*$/m,
    `name: Custom E2E Runner (${customName})`
  );
  let runId = 0;
  try {
    const upserted = await call("localmcp_hub_upsert_workflow", {
      provider: "github",
      workflow: customName,
      yaml_content: customYaml,
      commit_message: `test(e2e): create ${customName}`
    });
    if (upserted.action !== "created" || !upserted.handover_compatible) {
      throw new Error("Unexpected upsert result: " + JSON.stringify(upserted));
    }
    console.log(`[PASS] upsert_workflow (github): created ${customName}`);

    // Wait briefly for GitHub Actions to index the newly committed workflow file
    await sleep(5000);

    const started = await call("localmcp_hub_start", {
      provider: "github",
      workflow: customName,
      runner_name: "e2e-custom-gh",
      runner_tags: "go,e2e,custom",
      duration_seconds: 180,
      handover_after: -1
    });
    if (!started.dispatched || started.workflow_file !== customName) {
      throw new Error("Custom GitHub workflow dispatch failed: " + JSON.stringify(started));
    }
    if (!Array.isArray(started.runner_tags) || !started.runner_tags.includes(`workflow:${customName}`)) {
      throw new Error("Missing workflow routing tag in runner_tags: " + JSON.stringify(started.runner_tags));
    }
    runId = Number(started.run?.id || 0);
    console.log(`[PASS] localmcp_hub_start (github custom): dispatched ${customName} (run_id=${runId}, tags include workflow:${customName})`);
  } finally {
    if (runId > 0) {
      try {
        await call("localmcp_hub_stop", { provider: "github", workflow: customName, run_id: runId });
        console.log(`[CLEANUP] cancelled GitHub run_id=${runId}`);
      } catch (e) {
        console.log(`[CLEANUP warn] stop GitHub run_id=${runId}: ${e.message}`);
      }
    }
    try {
      const del = await call("localmcp_hub_delete_workflow", {
        provider: "github",
        workflow: customName,
        commit_message: `test(e2e): cleanup ${customName}`
      });
      console.log(`[CLEANUP] deleted GitHub ${customName}: ${JSON.stringify(del.deleted)}`);
    } catch (e) {
      console.log(`[CLEANUP warn] delete GitHub ${customName}: ${e.message}`);
    }
  }
}

async function testAzureCustomWorkflow() {
  console.log("\n=== 2. Azure DevOps Custom Raw YAML E2E ===");
  await call("select_github_account", { alias: azAlias });

  const listed = await call("localmcp_hub_list_workflows", { provider: "azure", project: azProject });
  const defaultPipe = (listed.pipelines || []).find((p) => p.is_default);
  if (!defaultPipe) throw new Error("Default Azure pipeline not found in list_workflows");
  console.log(`[PASS] list_workflows (azure): found ${listed.pipelines.length} pipelines including ${defaultPipe.name} (id=${defaultPipe.id})`);

  const got = await call("localmcp_hub_get_workflow", { provider: "azure", project: azProject, repository: azRepo });
  if (!got.handover_compatible || typeof got.yaml_content !== "string") {
    throw new Error("Default Azure pipeline YAML failed validation: " + JSON.stringify(got.validation_errors));
  }
  console.log(`[PASS] get_workflow (azure): read ${got.yaml_path} (${got.yaml_content.length} bytes, handover_compatible=true)`);

  await expectFailure("block overwriting default LocalMCP Hub Runner", () =>
    call("localmcp_hub_upsert_workflow", {
      provider: "azure",
      project: azProject,
      repository: azRepo,
      pipeline: "LocalMCP Hub Runner",
      yaml_content: got.yaml_content
    })
  );

  const suffix = Date.now().toString(36);
  const customPipeline = `Custom E2E Runner ${suffix}`;
  const customYamlPath = `/pipelines/hub-runner-e2e-${suffix}.yml`;
  const customYaml = `# Custom E2E Azure Pipeline ${suffix}\n` + got.yaml_content.replace(/^# LOCALMCP_HUB_RUNNER_TEMPLATE:.*\n?/, "");
  let pipelineId = 0;
  let runId = 0;
  try {
    const upserted = await call("localmcp_hub_upsert_workflow", {
      provider: "azure",
      project: azProject,
      repository: azRepo,
      pipeline: customPipeline,
      yaml_path: customYamlPath,
      yaml_content: customYaml,
      commit_message: `test(e2e): create ${customYamlPath}`
    });
    pipelineId = Number(upserted.pipeline?.id || 0);
    if (!pipelineId || upserted.yaml_path !== customYamlPath || !upserted.variable_group?.authorized) {
      throw new Error("Unexpected Azure upsert result: " + JSON.stringify(upserted));
    }
    console.log(`[PASS] upsert_workflow (azure): created pipeline '${customPipeline}' (id=${pipelineId}) + ${customYamlPath} + authorized Variable Group`);

    const started = await call("localmcp_hub_start", {
      provider: "azure",
      project: azProject,
      repository: azRepo,
      pipeline_id: pipelineId,
      os: "linux",
      runner_name: "e2e-custom-az",
      runner_tags: "go,e2e,custom",
      duration_seconds: 180,
      handover_after: -1
    });
    runId = Number(started.run_id || 0);
    if (!runId || started.pipeline?.id !== pipelineId || started.pipeline?.yaml_path !== customYamlPath) {
      throw new Error("Unexpected Azure custom start result: " + JSON.stringify(started));
    }
    if (!Array.isArray(started.runner_tags) || !started.runner_tags.includes(`pipeline_id:${pipelineId}`)) {
      throw new Error("Missing pipeline_id routing tag in Azure runner_tags: " + JSON.stringify(started.runner_tags));
    }
    console.log(`[PASS] localmcp_hub_start (azure custom): queued run_id=${runId} on pipeline_id=${pipelineId} (${customYamlPath})`);
  } finally {
    if (runId > 0) {
      try {
        await call("localmcp_hub_stop", { provider: "azure", project: azProject, pipeline_id: pipelineId, run_id: runId });
        console.log(`[CLEANUP] cancelled Azure run_id=${runId}`);
      } catch (e) {
        console.log(`[CLEANUP warn] stop Azure run_id=${runId}: ${e.message}`);
      }
    }
    if (pipelineId > 0) {
      try {
        const del = await call("localmcp_hub_delete_workflow", {
          provider: "azure",
          project: azProject,
          repository: azRepo,
          pipeline_id: pipelineId,
          delete_file: true
        });
        console.log(`[CLEANUP] deleted Azure pipeline_id=${pipelineId} & YAML: ${JSON.stringify({ pipeline_deleted: del.pipeline_deleted, file_deleted: del.file_deleted })}`);
      } catch (e) {
        console.log(`[CLEANUP warn] delete Azure pipeline_id=${pipelineId}: ${e.message}`);
      }
    }
  }
}

await testGitHubCustomWorkflow();
await testAzureCustomWorkflow();
console.log("\n=== ALL CUSTOM RAW YAML E2E CHECKS PASSED ===");
