export const DEFAULT_GITHUB_WORKFLOW = "hub-runner.yml";
export const DEFAULT_AZURE_PIPELINE_NAME = "LocalMCP Hub Runner";
export const DEFAULT_AZURE_YAML_PATH = "/azure-pipelines.yml";
export const MAX_WORKFLOW_YAML_BYTES = 128 * 1024;

export const REQUIRED_HANDOVER_PARAMS = [
  "runner_name",
  "runner_tags",
  "duration_seconds",
  "predecessor_id",
  "generation",
  "handover_after",
  "idle_timeout"
] as const;

export function normalizeGitHubWorkflowFilename(raw: unknown): string {
  if (raw === undefined || raw === null) return DEFAULT_GITHUB_WORKFLOW;
  const trimmed = String(raw).trim();
  if (!trimmed) return DEFAULT_GITHUB_WORKFLOW;
  const stripped = trimmed.replace(/^\/?\.github\/workflows\//i, "");
  if (
    stripped.includes("..") ||
    stripped.includes("/") ||
    stripped.includes("\\") ||
    !/^[A-Za-z0-9._-]{1,100}\.ya?ml$/i.test(stripped)
  ) {
    throw new Error(
      "workflow must be a simple YAML filename under .github/workflows/ (e.g. 'hub-runner-postgres.yml')."
    );
  }
  return stripped;
}

export function isCustomGitHubWorkflowFilename(filename: string): boolean {
  return /^hub-runner-[A-Za-z0-9._-]{1,80}\.ya?ml$/i.test(filename);
}

export function normalizeAzureYamlPath(raw: unknown): string {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) throw new Error("yaml_path is required.");
  const withSlash = trimmed.startsWith("/") ? trimmed : "/" + trimmed;
  if (
    withSlash.includes("..") ||
    withSlash.includes("//") ||
    withSlash.includes("\\") ||
    !/^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.ya?ml$/i.test(withSlash)
  ) {
    throw new Error(
      "yaml_path must be a safe repository path ending in .yml or .yaml (e.g. '/pipelines/hub-runner-postgres.yml')."
    );
  }
  return withSlash;
}

export function isCustomAzureYamlPath(yamlPath: string): boolean {
  return /^\/(?:pipelines\/hub-runner-[A-Za-z0-9._-]{1,80}|azure-pipelines-[A-Za-z0-9._-]{1,80})\.ya?ml$/i.test(
    yamlPath
  );
}

export function deriveCustomAzureYamlPath(pipelineName: string): string {
  const slug = String(pipelineName || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  if (!slug) {
    throw new Error("pipeline name must contain at least one letter or digit to derive a YAML path.");
  }
  return `/pipelines/hub-runner-${slug}.yml`;
}

export function validateGitHubRunnerYaml(yaml: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (typeof yaml !== "string" || !yaml.trim()) {
    return { valid: false, errors: ["yaml_content must be a non-empty string."] };
  }
  const bytes = new TextEncoder().encode(yaml).length;
  if (bytes > MAX_WORKFLOW_YAML_BYTES) {
    errors.push(`yaml_content exceeds maximum size of ${MAX_WORKFLOW_YAML_BYTES} bytes.`);
  }
  if (!/\bworkflow_dispatch\s*:/m.test(yaml)) {
    errors.push("Missing 'workflow_dispatch:' trigger.");
  }
  for (const param of REQUIRED_HANDOVER_PARAMS) {
    if (!new RegExp(`\\b${param}\\s*:`).test(yaml)) {
      errors.push(`Missing required handover input '${param}'.`);
    }
  }
  if (!/\bHUB_URLS\b/.test(yaml)) {
    errors.push("Missing 'HUB_URLS' reference for LocalMCP Hub connection.");
  }
  if (!/\bMCP_TOKEN\b/.test(yaml)) {
    errors.push("Missing 'MCP_TOKEN' reference for LocalMCP Hub authentication.");
  }
  return { valid: errors.length === 0, errors };
}

export function validateAzureRunnerYaml(yaml: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (typeof yaml !== "string" || !yaml.trim()) {
    return { valid: false, errors: ["yaml_content must be a non-empty string."] };
  }
  const bytes = new TextEncoder().encode(yaml).length;
  if (bytes > MAX_WORKFLOW_YAML_BYTES) {
    errors.push(`yaml_content exceeds maximum size of ${MAX_WORKFLOW_YAML_BYTES} bytes.`);
  }
  if (!/^\s*parameters\s*:/m.test(yaml)) {
    errors.push("Missing 'parameters:' section for runtime pipeline inputs.");
  }
  for (const param of REQUIRED_HANDOVER_PARAMS) {
    if (!new RegExp(`name\\s*:\\s*['"]?${param}['"]?\\b`).test(yaml)) {
      errors.push(`Missing required handover parameter '${param}'.`);
    }
  }
  if (!/\bHUB_URLS\b/.test(yaml)) {
    errors.push("Missing 'HUB_URLS' reference for LocalMCP Hub connection.");
  }
  if (!/\bMCP_TOKEN\b/.test(yaml)) {
    errors.push("Missing 'MCP_TOKEN' reference for LocalMCP Hub authentication.");
  }
  return { valid: errors.length === 0, errors };
}

export function appendRoutingTags(runnerTags: string, extraTags: string[]): string {
  const existing = String(runnerTags || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const prefixesToReplace = new Set(
    extraTags
      .map((t) => {
        const idx = t.indexOf(":");
        return idx > 0 ? t.slice(0, idx + 1) : "";
      })
      .filter(Boolean)
  );
  const kept = existing.filter((tag) => {
    for (const prefix of prefixesToReplace) {
      if (tag.startsWith(prefix)) return false;
    }
    return true;
  });
  const safeExtras = extraTags.filter((t) => /^[A-Za-z0-9_.:-]+$/.test(t));
  return [...new Set([...kept, ...safeExtras])].join(",");
}

export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

export function base64ToUtf8(b64: string): string {
  const clean = String(b64 || "").replace(/\s/g, "");
  const binary = atob(clean);
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
