import type { AuthContext, RtdbAccount } from "../types";
import { callHubTool, HUB_TOOL_PREFIX } from "./hub";

const DEFAULT_BASE_URL = "https://us-east-1.box.upstash.com";
const DEFAULT_RUNTIME = "golang";
const DEFAULT_SIZE = "small";
const DEFAULT_RELEASE_REPO = "o258p0515/localmcpcoder-go";
const DEFAULT_HUB_URL = "https://hub.o258p0515.dpdns.org";
const OPTIONAL_TS_SECRETS = ["TS_TRUST_CREDS", "TS_TAGS", "TS_AUTHKEY"] as const;

type UpstashBoxContext = {
  baseUrl: string;
  apiKey: string;
  defaultRuntime: string;
  defaultSize: string;
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

function context(account: RtdbAccount): UpstashBoxContext {
  const values = secrets(account);
  const apiKey = String(values.UPSTASH_BOX_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("Upstash Box provider requires UPSTASH_BOX_API_KEY in RTDB localmcpgo_secrets.");
  }
  const rawBase = String(values.UPSTASH_BOX_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  const defaultRuntime = String(values.UPSTASH_BOX_DEFAULT_RUNTIME || DEFAULT_RUNTIME).trim() || DEFAULT_RUNTIME;
  const defaultSize = String(values.UPSTASH_BOX_DEFAULT_SIZE || DEFAULT_SIZE).trim() || DEFAULT_SIZE;
  const releaseRepo = String(values.RUNNER_RELEASE_REPO || DEFAULT_RELEASE_REPO).trim() || DEFAULT_RELEASE_REPO;
  return {
    baseUrl: rawBase,
    apiKey,
    defaultRuntime,
    defaultSize,
    releaseRepo,
    headers: new Headers({
      Authorization: `Bearer ${apiKey}`,
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
        : "Upstash Box API request failed";
  return new Error(
    `Upstash Box API ${endpoint} returned HTTP ${status}: ${msg.replace(/Bearer\s+\S+/ig, "[REDACTED]").slice(0, 400)}`
  );
}

async function request(ctx: UpstashBoxContext, endpoint: string, init: RequestInit = {}): Promise<any> {
  const url = ctx.baseUrl + endpoint;
  const response = await fetch(url, {
    ...init,
    headers: new Headers({
      ...Object.fromEntries(ctx.headers),
      ...Object.fromEntries(new Headers(init.headers || {}))
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

async function waitBoxReady(ctx: UpstashBoxContext, boxId: string, maxAttempts = 30): Promise<any> {
  for (let i = 0; i < maxAttempts; i++) {
    const info = await request(ctx, `/v2/box/${encodeURIComponent(boxId)}`);
    const status = String(info?.status || "").toLowerCase();
    if (status === "idle" || status === "running") return info;
    if (status === "failed" || status === "error" || status === "deleted") {
      throw new Error(`Upstash Box ${boxId} entered terminal status '${status}'.`);
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  throw new Error(`Timed out waiting for Upstash Box ${boxId} to become ready.`);
}

async function resolveBoxId(ctx: UpstashBoxContext, args: Record<string, unknown>): Promise<string> {
  const direct = [args.box_id, args.machine_id, args.id, args.runner_id].find(
    v => typeof v === "string" && v.trim()
  ) as string | undefined;
  if (direct) {
    const trimmed = direct.trim();
    const stripped = trimmed.startsWith("ub-") ? trimmed.slice(3) : trimmed;
    const boxes = await request(ctx, "/v2/box");
    const list = Array.isArray(boxes) ? boxes : Array.isArray(boxes?.boxes) ? boxes.boxes : [];
    const found = list.find((b: any) => b.id === stripped || b.id === trimmed || b.name === trimmed);
    if (found?.id) return String(found.id);
    return stripped;
  }
  const boxes = await request(ctx, "/v2/box");
  const list = Array.isArray(boxes) ? boxes : Array.isArray(boxes?.boxes) ? boxes.boxes : [];
  if (!list.length) throw new Error("No Upstash boxes found; pass box_id or start a box first.");
  return String(list[0].id);
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

export async function runUpstashBoxHubTool(
  name: string,
  args: Record<string, unknown>,
  account: RtdbAccount,
  alias: string,
  env: any,
  authContext: AuthContext = { method: "static_token", subject: "upstashbox-hub-control" }
) {
  const ctx = context(account);
  const accountSecrets = secrets(account);

  if (name === "localmcp_hub_check_secrets") {
    const boxes = await request(ctx, "/v2/box");
    const list = Array.isArray(boxes) ? boxes : Array.isArray(boxes?.boxes) ? boxes.boxes : [];
    const hubUrlConfig = effectiveHubUrls(account, env);
    const hubToken = String(accountSecrets.MCP_TOKEN || env.MCP_TOKEN || "").trim();
    const optionalConfigured = OPTIONAL_TS_SECRETS.filter(k => !!String(accountSecrets[k] || "").trim());
    return {
      provider: "upstashbox",
      account: alias,
      base_url: ctx.baseUrl,
      default_runtime: ctx.defaultRuntime,
      default_size: ctx.defaultSize,
      existing_boxes_count: list.length,
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
      throw new Error("Upstash Box runner requires an effective Hub URL and MCP_TOKEN in RTDB or Proxy runtime.");
    }
    const runnerName = typeof args.runner_name === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(args.runner_name.trim())
      ? args.runner_name.trim()
      : `upstash-${Date.now()}`;
    const runnerTags = typeof args.runner_tags === "string" && /^[A-Za-z0-9_:.,-]{1,300}$/.test(args.runner_tags.trim())
      ? args.runner_tags.trim()
      : "upstashbox,linux,go";
    const runtime = typeof args.runtime === "string" && args.runtime.trim()
      ? args.runtime.trim()
      : typeof args.template === "string" && args.template.trim()
        ? args.template.trim()
        : ctx.defaultRuntime;
    const size = typeof args.size === "string" && ["small", "medium", "large"].includes(args.size.trim())
      ? args.size.trim()
      : ctx.defaultSize;
    const requestedDuration = Number(args.duration_seconds ?? 3600);
    if (!Number.isInteger(requestedDuration) || requestedDuration < 60 || requestedDuration > 86400) {
      throw new Error("duration_seconds must be an integer between 60 and 86400.");
    }

    const created = await request(ctx, "/v2/box", {
      method: "POST",
      body: JSON.stringify({ name: runnerName, runtime, size })
    });
    const boxId = String(created?.id || "");
    if (!boxId) {
      throw new Error("Upstash Box creation succeeded without returning a box id.");
    }
    const readyBox = await waitBoxReady(ctx, boxId);
    const runnerId = `ub-${boxId}`;
    const fullTags = [
      "provider:upstashbox",
      "os:linux",
      `account:${alias}`,
      `box:${boxId}`,
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
    const execRes = await request(ctx, `/v2/box/${encodeURIComponent(boxId)}/exec`, {
      method: "POST",
      body: JSON.stringify({ command: ["sh", "-c", cmd] })
    });
    const hubState = await findHubRunner(account, env, authContext, runnerId);
    return {
      provider: "upstashbox",
      account: alias,
      box_id: boxId,
      runner_id: runnerId,
      runner_name: runnerName,
      runtime: readyBox?.runtime || runtime,
      size: readyBox?.size || size,
      os: "linux",
      status: readyBox?.status || "running",
      runner_tags: fullTags,
      duration_seconds: requestedDuration,
      bootstrap_output: String(execRes?.output || "").trim(),
      bootstrap_error: String(execRes?.error || "").trim(),
      runner_online: hubState.online,
      hub_runner: hubState.runner
    };
  }

  if (name === "localmcp_hub_runs") {
    const boxes = await request(ctx, "/v2/box");
    const list = Array.isArray(boxes) ? boxes : Array.isArray(boxes?.boxes) ? boxes.boxes : [];
    return {
      provider: "upstashbox",
      account: alias,
      runs: list.map((b: any) => ({
        box_id: b.id,
        runner_id: `ub-${b.id}`,
        name: b.name,
        status: b.status,
        runtime: b.runtime,
        size: b.size,
        created_at: b.created_at
      }))
    };
  }

  const boxId = await resolveBoxId(ctx, args);
  const runnerId = `ub-${boxId}`;

  if (name === "localmcp_hub_status") {
    const [info, hubState, psRes] = await Promise.all([
      request(ctx, `/v2/box/${encodeURIComponent(boxId)}`),
      findHubRunner(account, env, authContext, runnerId),
      request(ctx, `/v2/box/${encodeURIComponent(boxId)}/exec`, {
        method: "POST",
        body: JSON.stringify({ command: ["sh", "-c", "ps aux | grep '[m]cp' || true"] })
      }).catch(() => null)
    ]);
    return {
      provider: "upstashbox",
      account: alias,
      box_id: boxId,
      runner_id: runnerId,
      name: info?.name,
      status: info?.status,
      runtime: info?.runtime,
      size: info?.size,
      runner_online: hubState.online,
      hub_runner: hubState.runner,
      process: String(psRes?.output || "").trim()
    };
  }

  if (name === "localmcp_hub_logs") {
    const linesCount = Math.min(500, Math.max(10, Number(args.end_line || 200)));
    const fileRes = await request(ctx, `/v2/box/${encodeURIComponent(boxId)}/files/read?path=${encodeURIComponent("/tmp/localmcp.log")}`)
      .catch(() => null);
    let rawText = typeof fileRes?.content === "string" ? fileRes.content : "";
    if (!rawText) {
      const execRes = await request(ctx, `/v2/box/${encodeURIComponent(boxId)}/exec`, {
        method: "POST",
        body: JSON.stringify({ command: ["sh", "-c", `tail -n ${linesCount} /tmp/localmcp.log 2>/dev/null || echo "(no log yet)"`] })
      });
      rawText = String(execRes?.output || "");
    }
    const allLines = rawText ? rawText.replace(/\r?\n$/, "").split(/\r?\n/) : [];
    return {
      provider: "upstashbox",
      account: alias,
      box_id: boxId,
      runner_id: runnerId,
      lines: allLines.slice(-linesCount),
      total_lines: allLines.length
    };
  }

  if (name === "localmcp_hub_stop") {
    const pauseOnly = args.pause === true || args.delete === false;
    if (pauseOnly) {
      await request(ctx, `/v2/box/${encodeURIComponent(boxId)}/pause`, { method: "POST" });
      return {
        provider: "upstashbox",
        account: alias,
        box_id: boxId,
        runner_id: runnerId,
        paused: true
      };
    }
    await request(ctx, `/v2/box/${encodeURIComponent(boxId)}`, { method: "DELETE" });
    return {
      provider: "upstashbox",
      account: alias,
      box_id: boxId,
      runner_id: runnerId,
      deleted: true
    };
  }

  throw new Error("Unsupported Upstash Box Hub operation: " + name);
}
