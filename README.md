# Cloudflare GitHub MCP Proxy

A Cloudflare Worker that transparently proxies the official GitHub Remote MCP endpoint and selects GitHub or Azure DevOps credentials from Firebase Realtime Database for account-scoped tools. Upstream tool names, descriptions, schemas, annotations, resources, prompts, initialization capabilities and results are forwarded without injecting proxy-specific fields into GitHub tool schemas. It supports Streamable HTTP (/mcp), legacy SSE (/sse and /messages), static token authentication, OAuth 2.1 authorization-code + PKCE, dynamic client registration, and encrypted RTDB caching.

## Selecting an account

Agents can call `list_github_accounts` to discover enabled aliases, usernames, organizations, supported providers (`github` and/or `azure`), and read-only status (credentials are never returned), then call `select_github_account` with the chosen alias. Azure-only accounts do not need a dummy GitHub `token`; GitHub upstream tools remain unavailable for those accounts while Proxy and Hub controls remain available. The selection is stored in Durable Object storage for 24 hours and remembered for subsequent calls from that authenticated client; separate OAuth client identities are isolated. Static-token clients share the `admin` identity, so use `X-GitHub-Account` or distinct credentials when static-token clients need separate accounts. The proxy automatically routes repository/organization-scoped calls when exactly one configured account matches the owner, username, or `orgs` metadata. If routing is ambiguous, the error directs the agent to list and select an account. Normal GitHub tool calls without a selected account or a unique owner match are rejected rather than silently falling back to the catalog account. Existing clients can still use `X-GitHub-Account`; the legacy `account` argument is accepted as a routing hint but stripped before forwarding. Official GitHub tool names and schemas remain unchanged; the account-management tools are additive proxy tools.

## Endpoints

- MCP Streamable HTTP: `https://<MCP_DOMAIN>/mcp`
- Swagger-style interactive API Explorer: `https://<MCP_DOMAIN>/api`
- Health and deployed version: `https://<MCP_DOMAIN>/health` and `/version`
- Legacy SSE: `https://<MCP_DOMAIN>/sse`

The API Explorer loads the live MCP tool catalog, shows each tool's input schema, supports individual calls and batch runs, and renders each response with PASS/FAIL/SKIP and duration. Batch mode skips tools with missing required arguments and skips likely mutating tools by default; explicitly enable writes only when you intend to change GitHub resources. Tool calls are real operations against the configured GitHub account, not mocks.

### API Explorer credentials

Configure these GitHub Actions repository secrets:

- `MCP_API_PASSPHRASE`: dedicated passphrase to access the API Explorer RPC endpoint.
- `MCP_OAUTH_CLIENT_ID` and `MCP_OAUTH_CLIENT_SECRET`: OAuth client pair; the API Explorer requires the same configured pair as an additional credential check.

The browser keeps these values in memory only for the current tab and sends them over HTTPS to `/api/rpc`. They are not written to local storage. The passphrase/client pair are never returned by the Worker. If the OAuth client pair is unset, the API Explorer remains inaccessible (MCP itself continues to use its normal authentication).

## Build version

Every CI/deploy build generates a version in Vietnam time (IANA timezone `Asia/Ho_Chi_Minh`) using `v.YY.MMDD.HHmm`, e.g. `v.26.1122.1635`. The deployed version is returned in `GET /version`, `GET /health`, the `X-MCP-Version` response header, and the API Explorer header. Builds made within the same minute share the same formatted version by design.

## GitHub Actions setup

Add repository secrets under **Settings → Secrets and variables → Actions**:

- `CF_API_EMAIL`, `CF_API_KEY`, `CF_DOMAIN`, `MCP_DOMAIN`
- `MCP_TOKEN`, `MCP_API_PASSPHRASE`
- `MCP_OAUTH_CLIENT_ID`, `MCP_OAUTH_CLIENT_SECRET`
- `FIREBASE_SERVICE_ACCOUNT_JSON_B64` or `FIREBASE_SERVICE_ACCOUNT_JSON`
- `RTDB_URL` when using a Service Account, or `RTDB_AUTH_URL` as fallback

Workflows: `.github/workflows/ci.yml` runs typecheck/tests; `.github/workflows/deploy.yml` deploys on pushes to `main` and supports manual dispatch, then runs live MCP smoke tests.

## Architecture

- `src/mcp`: JSON-RPC proxy, dynamic upstream tool discovery, authenticated account selection/routing, and transports.
- `src/api/swagger.ts`: protected interactive API Explorer.
- `src/rtdb`: Firebase Service Account RS256 exchange and encrypted account cache.
- `src/auth`: static token and OAuth 2.1.
- `scripts`: environment validation, version generation, Cloudflare KV preparation, and runtime-secret allowlist.

## Firebase RTDB setup

Create a JSON object at `/github_accounts`. If your Firebase project groups data under an `env` node, `/env/github_accounts` is also supported automatically when the direct node is empty. Example (replace placeholders with real PATs; never commit them):

```json
{
  "personal": {
    "username": "github-user",
    "token": "github_pat_REPLACE_ME",
    "description": "Personal account",
    "orgs": ["github-user"],
    "enabled": true,
    "readonly": false,
    "is_catalog_source": true
  },
  "azure-aerielaaeriel651971": {
    "username": "aerielaaeriel651971",
    "description": "Azure DevOps - aerielaaeriel651971",
    "orgs": ["aerielaaeriel651971"],
    "enabled": true,
    "readonly": false,
    "is_catalog_source": false,
    "localmcpgo_secrets": {
      "AZURE_DEVOPS_PAT": "AZURE_PAT_REPLACE_ME",
      "AZURE_DEVOPS_ORG_URL": "https://dev.azure.com/aerielaaeriel651971",
      "HUB_URLS": "https://hub.o258p0515.dpdns.org"
    }
  }
}
```

Recommended RTDB Security Rules: `{ "rules": { ".read": false, ".write": false } }`.

## LocalMCP Go runner controls

The proxy adds account-scoped LocalMCP Go lifecycle tools. Each RTDB account may contain a `localmcpgo_secrets` object with secret-name/value pairs. Azure-only accounts are valid when both `AZURE_DEVOPS_PAT` and `AZURE_DEVOPS_ORG_URL` are present; a GitHub `token` is not required. The account cache in CACHE_KV is encrypted with MCP_TOKEN; public account listings never expose these values. localmcp_configure_secrets merges values into RTDB, while localmcp_reset_secrets force-writes all configured values to GitHub Actions Repository Secrets.

localmcp_start checks .github/workflows/example-run.yml, installs the canonical workflow from o258p0515/localmcpcoder-go only if missing, checks which required secret names already exist in GitHub, requires RTDB values only for missing secrets, and writes only those missing repository secrets, avoids duplicate active runs, and dispatches the workflow. The required secret names follow the current LocalMCP Go workflow: CF_API_EMAIL, CF_API_KEY, CF_DOMAIN, MCP_TOKEN, MCP_OAUTH_CLIENT_ID, and MCP_OAUTH_CLIENT_SECRET. MCP_OAUTH_REDIRECT_URIS is no longer required. TS_TRUST_CREDS and TS_TAGS are optional; TUNNEL_TOKEN is generated by the workflow from Cloudflare.

Additional tools: localmcp_check_secrets, localmcp_check_workflow, localmcp_stop, localmcp_restart, localmcp_status, localmcp_runs, localmcp_logs, and localmcp_connection_check. Full job-log downloads use short-lived signed GitHub URLs; the Worker does not persist them.

## Separate LocalMCP Hub layer

Hub tools are additive and isolated from the legacy direct-runner lifecycle. The Hub tool catalog is exposed with the `hub__` prefix (for example `hub__list_runners`, `hub__select_runner`, and `hub__bash`) so it cannot shadow official GitHub tools or the legacy `localmcp_*` tools. The Proxy uses the selected RTDB account's `localmcpgo_secrets.HUB_URLS` and `MCP_TOKEN` to contact Hub; the same `MCP_TOKEN` authenticates both the Go MCP handler and the Hub runner WebSocket. No `HUB_SHARED_SECRET` is required.

Hub lifecycle controls are separate: `localmcp_hub_start`, `localmcp_hub_stop`, `localmcp_hub_status`, `localmcp_hub_runs`, `localmcp_hub_logs`, `localmcp_hub_check_secrets`, and `localmcp_hub_check_connection`. Pass `provider: "github"` or `provider: "azure"` when the selected account has both providers; the Proxy never guesses. GitHub starts use the repository's `hub-runner.yml`; Azure starts discover projects, Azure Repos repositories and pipelines, bootstrap `azure-pipelines.yml` when needed, create a project-scoped secret Variable Group for `HUB_URLS` and `MCP_TOKEN`, and queue a unique Linux or Windows hosted runner. Azure source code is cloned from `o258p0515/localmcpcoder-go` at `source_ref` (default `main`). Select `project` and `repository` when the organization has more than one candidate. For the current LocalMCP Hub deployment, set `HUB_URLS` to `https://hub.o258p0515.dpdns.org` (base URL only; do not append `/mcp`). The Proxy runtime `MCP_TOKEN` can be reused if the account-level value is absent. Azure PAT needs organization/project read, Code read/write (to bootstrap the pipeline YAML), Pipeline/Build read and execute, and Library/Variable Groups read/manage permissions. PAT values are never returned or logged. Azure hosted jobs are capped at 55 minutes to stay below the 60-minute hosted-job limit; organization hosted parallelism entitlement is still controlled by Azure DevOps and queued runs are not considered online runners. Logs are fetched in stateless line windows of up to 500 lines; each response returns `nextStartLine` and timeline job/step error metadata. The Go runner exposes a bearer-protected shutdown endpoint only on its loopback listener so Windows hosted runners can drain cleanly. GitHub runner instances use unique workflow-run concurrency groups and do not cancel one another.