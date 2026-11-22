# Cloudflare GitHub MCP Proxy

A Cloudflare Worker that transparently proxies the official GitHub Remote MCP endpoint and selects a GitHub PAT from Firebase Realtime Database for each request. Upstream tool names, descriptions, schemas, annotations, resources, prompts, initialization capabilities and results are forwarded without injecting proxy-specific fields into GitHub tool schemas. It supports Streamable HTTP (/mcp), legacy SSE (/sse and /messages), static token authentication, OAuth 2.1 authorization-code + PKCE, dynamic client registration, and encrypted RTDB caching.

## Selecting a GitHub account

Set the optional `X-GitHub-Account` HTTP header to an enabled alias from Firebase `/github_accounts` (for example, `personal`). If omitted, the configured `is_catalog_source` account is used, or the first enabled account. The legacy `account` argument is accepted as a routing hint for existing clients but is stripped before forwarding and is not added to official GitHub tool schemas. The account directory is exposed only to the protected API Explorer, not added to the official MCP tool catalog.

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

Workflows: `.github/workflows/ci.yml` runs typecheck/tests; `.github/workflows/deploy.yml` performs Cloudflare deployment and live MCP smoke tests. Deployment is manual-only.

## Architecture

- `src/mcp`: JSON-RPC proxy, dynamic upstream tool discovery, mandatory account schema injection, and transports.
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