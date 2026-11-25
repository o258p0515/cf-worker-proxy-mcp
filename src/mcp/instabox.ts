import type { AuthContext, RtdbAccount } from "../types";
import { callHubTool, HUB_TOOL_PREFIX } from "./hub";

const DEFAULT_BASE_URL = "https://api.instabox.sh";
const DEFAULT_TEMPLATE = "agent-browser";
const DEFAULT_RELEASE_REPO = "o258p0515/localmcpcoder-go";
const DEFAULT_HUB_URL = "https://hub.o258p0515.dpdns.org";
const OPTIONAL_TS_SECRETS = ["TS_TRUST_CREDS", "TS_TAGS", "TS_AUTHKEY"] as const;

type InstaBoxContext = {
  baseUrl: string;
  apiKey: string;
  defaultTemplate: string;
  releaseRepo: string;
  headers: Headers;
};

function secrets(account: RtdbAccount): Record<string, string> {
  return account.localmcpgo_secrets && typeof account.localmcpgo_secrets === "object"
    ? account.localmcpgo_secrets
    : {};
}

function effectiveHubUrls(account: RtdbAccount, env: any) {
  const configured = String(secrets(account).HUB_URLS || "").trim();
  const runtimeDefault = String(env.LOCALMCP_HUB_ORIGIN || "").trim();
  const value = configured || runtimeDefault || DEFAULT_HUB_URL;
  const urls = value.split(",").map((item: string) => item.trim()).filter(Boolean);
  for (const item of urls) {
    const url = new URL(item);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
      throw new Error("HUB_URLS must contain HTTPS Hub base URLs.");
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new Error("HUB_URLS must contain clean base URLs.");
    }
  }
  return {
    value: urls.join(","),
    source: configured ? "RTDB localmcpgo_secrets" : runtimeDefault ? "Proxy LOCALMCP_HUB_ORIGIN" : "built-in default"
  };
}

function context(account: RtdbAccount): InstaBoxContext {
  const values = secrets(account);
  const apiKey = String(values.INSTABOX_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("InstaBox provider requires INSTABOX_API_KEY in RTDB localmcpgo_secrets.");
  }
  const rawBase = String(values.INSTABOX_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  const defaultTemplate = String(values.INSTABOX_DEFAULT_TEMPLATE || DEFAULT_TEMPLATE).trim() || DEFAULT_TEMPLATE;
  const releaseRepo = String(values.RUNNER_RELEASE_REPO || DEFAULT_RELEASE_REPO).trim() || DEFAULT_RELEASE_REPO;
  return {
    baseUrl: rawBase,
    apiKey,
    defaultTemplate,
    releaseRepo,
    headers: new Headers({
      "X-API-Key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json"
    })
  };
}

function safeError(status: number, body: any, endpoint: string) {
  const msg = typeof body?.message === "string"
    ? body.message
    : typeof body?.error === "string"
      ? body.error
      : typeof body === "string"
        ? body
        : "InstaBox API request failed";
  return new Error(
    `InstaBox API ${endpoint} returned HTTP ${status}: ${msg.replace(/ibk_[a-zA-Z0-9]+/g, "[REDACTED]").slice(0, 400)}`
  );
}

async function request(ctx: InstaBoxContext, endpoint: string, init: RequestInit = {}): Promise<any> {
  const url = ctx.baseUrl + endpoint;
  const method = String(init.method || "GET").toUpperCase();
  const extraHeaders = new Headers(init.headers || {});
  if (["POST", "DELETE", "PUT", "PATCH"].includes(method) && !extraHeaders.has("Idempotency-Key")) {
    extraHeaders.set("Idempotency-Key", crypto.randomUUID());
  }
  const response = await fetch(url, {
    ...init,
    headers: new Headers({
      ...Object.fromEntries(ctx.headers),
      ...Object.fromEntries(extraHeaders)
    }),
    signal: init.signal || AbortSignal.timeout(25000)
  });
  if (response.status === 204) return null;
  const raw = await response.text();
  let body: any = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    body = raw;
  }
  if (!response.ok) {
    throw safeError(response.status, body, endpoint);
  }
  return body;
}

async function waitOperation(ctx: InstaBoxContext, opId: string, maxAttempts = 15): Promise<any> {
  for (let i = 0; i < maxAttempts; i++) {
    const op = await request(ctx, `/v1/operations/${encodeURIComponent(opId)}?wait=10s`);
    if (op?.state === "succeeded") return op;
    if (op?.state === "failed") {
      throw new Error(`InstaBox operation ${opId} failed: ${JSON.stringify(op.error || op).slice(0, 300)}`);
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for InstaBox operation ${opId} to succeed.`);
}

async function resolveMachineId(ctx: InstaBoxContext, args: Record<string, unknown>): Promise<string> {
  const direct = [args.machine_id, args.box_id, args.id, args.runner_id].find(
    v => typeof v === "string" && v.trim()
  ) as string | undefined;
  if (direct) {
    const trimmed = direct.trim();
    if (/^m_[a-z2-7]{26}$/.test(trimmed)) return trimmed;
    const listRes = await request(ctx, "/v1/machines");
    const machines = Array.isArray(listRes?.machines) ? listRes.machines : [];
    const found = machines.find(
      (m: any) => m.id === trimmed || m.name === trimmed || `ib-${m.id}` === trimmed
    );
    if (found?.id) return String(found.id);
    return trimmed;
  }
  const listRes = await request(ctx, "/v1/machines");
  const machines = Array.isArray(listRes?.machines) ? listRes.machines : [];
  if (!machines.length) throw new Error("No InstaBox machines found; pass machine_id or start a machine first.");
  return String(machines[0].id);
}

function buildBootstrapCommand(
  releaseRepo: string,
  hubUrls: string,
  mcpToken: string,
  runnerId: string,
  runnerTags: string,
  durationSeconds: number,
  optionalTs: Record<string, string>
): string {
  const b64Config = btoa(
    JSON.stringify({
      hubUrls,
      mcpToken,
      runnerId,
      runnerTags,
      durationSeconds,
      releaseRepo,
      tsTrustCreds: optionalTs.TS_TRUST_CREDS || "",
      tsTags: optionalTs.TS_TAGS || "",
      tsAuthkey: optionalTs.TS_AUTHKEY || ""
    })
  );
  return `nohup sh -c '
set -e
CFG_JSON=$(printf "%s" "${b64Config}" | base64 -d)
eval "$(python3 -c 'import sys,json,shlex; d=json.loads(sys.stdin.read()); print("\\n".join(f"{k}={shlex.quote(str(v))}" for k,v in d.items()))' <<< "$CFG_JSON" 2>/dev/null || node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); for(const [k,v] of Object.entries(d)) console.log(k+"="+JSON.stringify(String(v)))' <<< "$CFG_JSON")"
mkdir -p /tmp/lmcp /tmp/mcp-root && cd /tmp/lmcp
ARCH=$(uname -m | sed "s/x86_64/amd64/;s/aarch64/arm64/")
if [ ! -x ./mcp ]; then
  curl -fsSL "https://github.com/${releaseRepo}/releases/latest/download/mcp-linux-\${ARCH}" -o mcp
  chmod +x mcp
fi
export MCP_TOKEN="$mcpToken"
export HUB_URLS="$hubUrls"
[ -n "$tsTrustCreds" ] && export TS_TRUST_CREDS="$tsTrustCreds"
[ -n "$tsTags" ] && export TS_TAGS="$tsTags"
[ -n "$tsAuthkey" ] && export TS_AUTHKEY="$tsAuthkey"
if command -v timeout >/dev/null 2>&1; then
  exec timeout --signal=TERM --kill-after=15s "\${durationSeconds}s" ./mcp --root /tmp/mcp-root --tunnel hub --hub-urls "$hubUrls" --runner-id "$runnerId" --runner-tags "$runnerTags"
else
  exec ./mcp --root /tmp/mcp-root --tunnel hub --hub-urls "$hubUrls" --runner-id "$runnerId" --runner-tags "$runnerTags"
fi
' > /tmp/localmcp.log 2>&1 &
sleep 1
echo "STARTED_PID=$!"`;
}

async function findHubRunner(account: RtdbAccount, env: any, authContext: AuthContext, runnerId: string) {
  try {
    const hub = await callHubTool(
      HUB_TOOL_PREFIX + "list_runners",
      {},
      account,
      authContext,
      String(secrets(account).MCP_TOKEN || env.MCP_TOKEN || ""),
      env.LOCALMCP_HUB,
      env.LOCALMCP_HUB_ORIGIN
    );
    let parsed: any = hub;
    if (Array.isArray(hub?.content)) {
      const text = hub.content.find((item: any) => item.type === "text")?.text;
      if (typeof text === "string") {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = {};
        }
      }
    }
    const runners = Array.isArray(parsed?.runners) ? parsed.runners : Array.isArray(parsed) ? parsed : [];
    const runner = runners.find((item: any) => item.runner_id === runnerId) || null;
    return {
      online: !!runner && String(runner.status || "").toLowerCase() === "online",
      runner,
      error: undefined as string | undefined
    };
  } catch (error) {
    return {
      online: null as boolean | null,
      runner: null,
      error: error instanceof Error ? error.message : "Hub status unavailable"
    };
  }
}

export async function runInstaBoxHubTool(
  name: string,
  args: Record<string, unknown>,
  account: RtdbAccount,
  alias: string,
  env: any,
  authContext: AuthContext = { method: "static_token", subject: "instabox-hub-control" }
) {
  const ctx = context(account);
  const accountSecrets = secrets(account);

  if (name === "localmcp_hub_check_secrets") {
    const [me, templatesRes] = await Promise.all([
      request(ctx, "/v1/me"),
      request(ctx, "/v1/templates").catch(() => ({ templates: [] }))
    ]);
    const hubUrlConfig = effectiveHubUrls(account, env);
    const hubToken = String(accountSecrets.MCP_TOKEN || env.MCP_TOKEN || "").trim();
    const optionalConfigured = OPTIONAL_TS_SECRETS.filter(k => !!String(accountSecrets[k] || "").trim());
    const templates = Array.isArray(templatesRes?.templates)
      ? templatesRes.templates.filter((t: any) => t.creatable !== false).map((t: any) => t.id)
      : [];
    return {
      provider: "instabox",
      account: alias,
      user: { name: me?.name, email: me?.email, orgId: me?.orgId, activated: me?.activated },
      default_template: ctx.defaultTemplate,
      available_templates: templates,
      credential_validated: true,
      hub_credentials_ready: !!hubUrlConfig.value && hubToken.length >= 16,
      hub_urls_source: hubUrlConfig.source,
      token_source: accountSecrets.MCP_TOKEN ? "RTDB localmcpgo_secrets" : hubToken ? "Proxy runtime MCP_TOKEN" : null,
      optional_configured_names: optionalConfigured,
      values_returned: false
    };
  }

  if (name === "localmcp_hub_start") {
    const hubUrlConfig = effectiveHubUrls(account, env);
    const token = String(accountSecrets.MCP_TOKEN || env.MCP_TOKEN || "").trim();
    if (!hubUrlConfig.value || token.length < 16) {
      throw new Error("InstaBox runner requires an effective Hub URL and MCP_TOKEN in RTDB or Proxy runtime.");
    }
    const runnerName = typeof args.runner_name === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(args.runner_name.trim())
      ? args.runner_name.trim()
      : "instabox";
    const runnerTags = typeof args.runner_tags === "string" && /^[A-Za-z0-9_:.,-]{1,300}$/.test(args.runner_tags.trim())
      ? args.runner_tags.trim()
      : "instabox,linux,go";
    const templateId = typeof args.template === "string" && args.template.trim()
      ? args.template.trim()
      : ctx.defaultTemplate;
    const requestedDuration = Number(args.duration_seconds ?? 3600);
    if (!Number.isInteger(requestedDuration) || requestedDuration < 60 || requestedDuration > 86400) {
      throw new Error("duration_seconds must be an integer between 60 and 86400.");
    }

    const createPayload: Record<string, unknown> = { templateId, name: runnerName };
    const op = await request(ctx, "/v1/machines", {
      method: "POST",
      body: JSON.stringify(createPayload)
    });
    const completed = op?.id ? await waitOperation(ctx, String(op.id)) : op;
    const machine = completed?.machine || op?.machine || {};
    const machineId = String(machine.id || "");
    if (!machineId) {
      throw new Error("InstaBox machine creation succeeded without returning a machine id.");
    }

    const runnerId = `ib-${machineId}`;
    const fullTags = [
      "provider:instabox",
      "os:linux",
      `account:${alias}`,
      `machine:${machineId}`,
      `name:${runnerName}`,
      ...runnerTags.split(",")
    ];
    const optionalTs: Record<string, string> = {};
    for (const k of OPTIONAL_TS_SECRETS) {
      const v = String(accountSecrets[k] || "").trim();
      if (v) optionalTs[k] = v;
    }

    const cmd = buildBootstrapCommand(
      ctx.releaseRepo,
      hubUrlConfig.value,
      token,
      runnerId,
      fullTags.join(","),
      requestedDuration,
      optionalTs
    );
    const execRes = await request(ctx, `/v1/machines/${encodeURIComponent(machineId)}/exec`, {
      method: "POST",
      body: JSON.stringify({ cmd })
    });
    const hubState = await findHubRunner(account, env, authContext, runnerId);
    return {
      provider: "instabox",
      account: alias,
      machine_id: machineId,
      runner_id: runnerId,
      runner_name: runnerName,
      template: templateId,
      os: "linux",
      state: machine.state || "running",
      runner_tags: fullTags,
      duration_seconds: requestedDuration,
      bootstrap_exit_code: execRes?.exitCode ?? 0,
      bootstrap_stdout: String(execRes?.stdout || "").trim(),
      runner_online: hubState.online,
      hub_runner: hubState.runner
    };
  }

  if (name === "localmcp_hub_runs") {
    const res = await request(ctx, "/v1/machines");
    const machines = Array.isArray(res?.machines) ? res.machines : [];
    return {
      provider: "instabox",
      account: alias,
      runs: machines.map((m: any) => ({
        machine_id: m.id,
        runner_id: `ib-${m.id}`,
        name: m.name,
        state: m.state,
        desired_state: m.desiredState,
        template: m.template?.id,
        created_at: m.createdAt
      }))
    };
  }

  const machineId = await resolveMachineId(ctx, args);
  const runnerId = `ib-${machineId}`;

  if (name === "localmcp_hub_status") {
    const [machine, hubState, psRes] = await Promise.all([
      request(ctx, `/v1/machines/${encodeURIComponent(machineId)}`),
      findHubRunner(account, env, authContext, runnerId),
      request(ctx, `/v1/machines/${encodeURIComponent(machineId)}/exec`, {
        method: "POST",
        body: JSON.stringify({ cmd: "ps aux | grep '[m]cp' || true" })
      }).catch(() => null)
    ]);
    return {
      provider: "instabox",
      account: alias,
      machine_id: machineId,
      runner_id: runnerId,
      name: machine?.name,
      state: machine?.state,
      desired_state: machine?.desiredState,
      template: machine?.template?.id,
      runner_online: hubState.online,
      hub_runner: hubState.runner,
      process: String(psRes?.stdout || "").trim()
    };
  }

  if (name === "localmcp_hub_logs") {
    const linesCount = Math.min(500, Math.max(10, Number(args.end_line || 200)));
    const execRes = await request(ctx, `/v1/machines/${encodeURIComponent(machineId)}/exec`, {
      method: "POST",
      body: JSON.stringify({ cmd: `tail -n ${linesCount} /tmp/localmcp.log 2>/dev/null || echo "(no log yet)"` })
    });
    const text = String(execRes?.stdout || "");
    return {
      provider: "instabox",
      account: alias,
      machine_id: machineId,
      runner_id: runnerId,
      lines: text ? text.replace(/\r?\n$/, "").split(/\r?\n/) : [],
      exit_code: execRes?.exitCode ?? 0
    };
  }

  if (name === "localmcp_hub_stop") {
    const machine = await request(ctx, `/v1/machines/${encodeURIComponent(machineId)}`);
    const confirmName = String(machine?.name || machineId);
    const deleteMode = args.delete !== false;
    if (deleteMode) {
      const op = await request(ctx, `/v1/machines/${encodeURIComponent(machineId)}`, {
        method: "DELETE",
        headers: { "X-Confirm-Delete": confirmName }
      });
      if (op?.id) await waitOperation(ctx, String(op.id)).catch(() => null);
      return {
        provider: "instabox",
        account: alias,
        machine_id: machineId,
        runner_id: runnerId,
        deleted: true
      };
    }
    const op = await request(ctx, `/v1/machines/${encodeURIComponent(machineId)}/stop`, {
      method: "POST",
      body: JSON.stringify({})
    });
    if (op?.id) await waitOperation(ctx, String(op.id)).catch(() => null);
    return {
      provider: "instabox",
      account: alias,
      machine_id: machineId,
      runner_id: runnerId,
      stopped: true
    };
  }

  throw new Error("Unsupported InstaBox Hub operation: " + name);
}
