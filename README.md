# Cloudflare GitHub MCP Proxy

A Cloudflare Worker that transparently proxies the official GitHub Remote MCP endpoint and selects a GitHub PAT from Firebase Realtime Database for each request. Upstream tool names, descriptions, schemas, annotations, resources, prompts, initialization capabilities and results are forwarded without injecting proxy-specific fields into GitHub tool schemas. It supports Streamable HTTP (/mcp), legacy SSE (/sse and /messages), static token authentication, OAuth 2.1 authorization-code + PKCE, dynamic client registration, and encrypted RTDB caching.

## Selecting a GitHub account

Agents can call `list_github_accounts` to discover enabled aliases, usernames, organizations, and read-only status (credentials are never returned), then call `select_github_account` with the chosen alias. The selection is remembered for subsequent GitHub MCP calls for that authenticated subject and can be changed at any time. The proxy also automatically routes repository/organization-scoped calls when exactly one configured account matches the owner, username, or `orgs` metadata. If routing is ambiguous, the error directs the agent to list and select an account. Existing clients can still use `X-GitHub-Account`; the legacy `account` argument is accepted as a routing hint but stripped before forwarding. Official GitHub tool names and schemas remain unchanged; the two account-management tools are additive proxy tools.

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
  }
}
```

Recommended RTDB Security Rules: `{ "rules": { ".read": false, ".write": false } }`.

## LocalMCP Go runner controls

The proxy adds account-scoped LocalMCP Go lifecycle tools. Each RTDB GitHub account may contain a localmcpgo_secrets object with secret-name/value pairs. The account cache in CACHE_KV is encrypted with MCP_TOKEN; public account listings never expose these values. localmcp_configure_secrets merges values into RTDB, while localmcp_reset_secrets force-writes all configured values to GitHub Actions Repository Secrets.

localmcp_start checks .github/workflows/example-run.yml, installs the canonical workflow from o258p0515/localmcpcoder-go only if missing, checks which required secret names already exist in GitHub, requires RTDB values only for missing secrets, and writes only those missing repository secrets, avoids duplicate active runs, and dispatches the workflow. The required secret names follow the current LocalMCP Go workflow: CF_API_EMAIL, CF_API_KEY, CF_DOMAIN, MCP_TOKEN, MCP_OAUTH_CLIENT_ID, MCP_OAUTH_CLIENT_SECRET, and MCP_OAUTH_REDIRECT_URIS. TS_TRUST_CREDS and TS_TAGS are optional; TUNNEL_TOKEN is generated by the workflow from Cloudflare.

Additional tools: localmcp_check_secrets, localmcp_check_workflow, localmcp_stop, localmcp_restart, localmcp_status, localmcp_runs, localmcp_logs, and localmcp_connection_check. Full job-log downloads use short-lived signed GitHub URLs; the Worker does not persist them.