1	# Cloudflare GitHub MCP Proxy
    2	
    3	A Cloudflare Worker that transparently proxies the official GitHub Remote MCP endpoint and selects a GitHub PAT from Firebase Realtime Database for each request. Upstream tool names, descriptions, schemas, annotations, resources, prompts, initialization capabilities and results are forwarded without injecting proxy-specific fields into GitHub tool schemas. It supports Streamable HTTP (/mcp), legacy SSE (/sse and /messages), static token authentication, OAuth 2.1 authorization-code + PKCE, dynamic client registration, and encrypted RTDB caching.
    4	
    5	## Selecting a GitHub account
    6	
    7	Set the optional `X-GitHub-Account` HTTP header to an enabled alias from Firebase `/github_accounts` (for example, `personal`). If omitted, the configured `is_catalog_source` account is used, or the first enabled account. The legacy `account` argument is accepted as a routing hint for existing clients but is stripped before forwarding and is not added to official GitHub tool schemas. The account directory is exposed only to the protected API Explorer, not added to the official MCP tool catalog.
    8	
    9	## Endpoints
   10	
   11	- MCP Streamable HTTP: `https://<MCP_DOMAIN>/mcp`
   12	- Swagger-style interactive API Explorer: `https://<MCP_DOMAIN>/api`
   13	- Health and deployed version: `https://<MCP_DOMAIN>/health` and `/version`
   14	- Legacy SSE: `https://<MCP_DOMAIN>/sse`
   15	
   16	The API Explorer loads the live MCP tool catalog, shows each tool's input schema, supports individual calls and batch runs, and renders each response with PASS/FAIL/SKIP and duration. Batch mode skips tools with missing required arguments and skips likely mutating tools by default; explicitly enable writes only when you intend to change GitHub resources. Tool calls are real operations against the configured GitHub account, not mocks.
   17	
   18	### API Explorer credentials
   19	
   20	Configure these GitHub Actions repository secrets:
   21	
   22	- `MCP_API_PASSPHRASE`: dedicated passphrase to access the API Explorer RPC endpoint.
   23	- `MCP_OAUTH_CLIENT_ID` and `MCP_OAUTH_CLIENT_SECRET`: OAuth client pair; the API Explorer requires the same configured pair as an additional credential check.
   24	
   25	The browser keeps these values in memory only for the current tab and sends them over HTTPS to `/api/rpc`. They are not written to local storage. The passphrase/client pair are never returned by the Worker. If the OAuth client pair is unset, the API Explorer remains inaccessible (MCP itself continues to use its normal authentication).
   26	
   27	## Build version
   28	
   29	Every CI/deploy build generates a version in Vietnam time (IANA timezone `Asia/Ho_Chi_Minh`) using `v.YY.MMDD.HHmm`, e.g. `v.26.1122.1635`. The deployed version is returned in `GET /version`, `GET /health`, the `X-MCP-Version` response header, and the API Explorer header. Builds made within the same minute share the same formatted version by design.
   30	
   31	## GitHub Actions setup
   32	
   33	Add repository secrets under **Settings → Secrets and variables → Actions**:
   34	
   35	- `CF_API_EMAIL`, `CF_API_KEY`, `CF_DOMAIN`, `MCP_DOMAIN`
   36	- `MCP_TOKEN`, `MCP_API_PASSPHRASE`
   37	- `MCP_OAUTH_CLIENT_ID`, `MCP_OAUTH_CLIENT_SECRET`
   38	- `FIREBASE_SERVICE_ACCOUNT_JSON_B64` or `FIREBASE_SERVICE_ACCOUNT_JSON`
   39	- `RTDB_URL` when using a Service Account, or `RTDB_AUTH_URL` as fallback
   40	
   41	Workflows: `.github/workflows/ci.yml` runs typecheck/tests; `.github/workflows/deploy.yml` performs Cloudflare deployment and live MCP smoke tests. Deployment is manual-only.
   42	
   43	## Architecture
   44	
   45	- `src/mcp`: JSON-RPC proxy, dynamic upstream tool discovery, mandatory account schema injection, and transports.
   46	- `src/api/swagger.ts`: protected interactive API Explorer.
   47	- `src/rtdb`: Firebase Service Account RS256 exchange and encrypted account cache.
   48	- `src/auth`: static token and OAuth 2.1.
   49	- `scripts`: environment validation, version generation, Cloudflare KV preparation, and runtime-secret allowlist.
   50	
   51	## Firebase RTDB setup
   52	
   53	Create a JSON object at `/github_accounts`. If your Firebase project groups data under an `env` node, `/env/github_accounts` is also supported automatically when the direct node is empty. Example (replace placeholders with real PATs; never commit them):
   54	
   55	```json
   56	{
   57	  "personal": {
   58	    "username": "github-user",
   59	    "token": "github_pat_REPLACE_ME",
   60	    "description": "Personal account",
   61	    "orgs": ["github-user"],
   62	    "enabled": true,
   63	    "readonly": false,
   64	    "is_catalog_source": true
   65	  }
   66	}
   67	```
   68	
   69	Recommended RTDB Security Rules: `{ "rules": { ".read": false, ".write": false } }`.
   70