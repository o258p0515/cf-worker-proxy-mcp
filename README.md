# Cloudflare GitHub MCP Proxy

A Cloudflare Worker that proxies the official GitHub Remote MCP endpoint and selects a GitHub PAT from Firebase Realtime Database for each tool call. It supports Streamable HTTP (/mcp), legacy SSE (/sse and /messages), static token authentication, OAuth 2.1 authorization-code + PKCE, dynamic client registration, and encrypted RTDB caching.

## Dedicated repository

This repository contains the standalone Cloudflare Worker implementation and its GitHub Actions workflows. It is separated from the Go application repository. The public MCP hostname is configured with the `MCP_DOMAIN` GitHub Actions secret; the deployment workflow derives the MCP URL from that secret.

## GitHub Actions setup

Add the following Actions repository secrets in **Settings → Secrets and variables → Actions** before running the deployment workflow:

- `CF_API_EMAIL`, `CF_API_KEY`, `CF_DOMAIN`
- `MCP_DOMAIN` — hostname only, e.g. `github-mcp-proxy.example.com` (no `https://`, path, port, or trailing dot)
- `MCP_TOKEN`
- `MCP_OAUTH_CLIENT_ID`, `MCP_OAUTH_CLIENT_SECRET` (optional as a pair)
- `FIREBASE_SERVICE_ACCOUNT_JSON_B64` or `FIREBASE_SERVICE_ACCOUNT_JSON`
- `RTDB_URL` when using a Service Account, or `RTDB_AUTH_URL` as fallback

`MCP_DOMAIN` must belong to the active Cloudflare zone selected by `CF_DOMAIN` and already have a proxied A/AAAA/CNAME DNS record. Both the preflight validator and deployment preparation script check these requirements and stop deployment if they are not met.

Workflows included: `.github/workflows/ci.yml` (tests/typecheck) and `.github/workflows/deploy.yml` (Cloudflare deploy + live MCP smoke tests). Deploy is manual-only (**Actions → Deploy GitHub MCP Proxy → Run workflow**).

## Architecture

- src/mcp: JSON-RPC proxy, dynamic upstream tool discovery, mandatory account schema injection, and transports.
- src/rtdb: Firebase Service Account RS256 exchange and encrypted account cache.
- src/auth: static token and OAuth 2.1.
- scripts: environment validation, Cloudflare KV preparation, and strict runtime-secret allowlist.
- This repository contains only the Cloudflare GitHub MCP proxy; the Go MCP application remains in its separate repository.

## Firebase RTDB setup

Create a JSON object at /github_accounts. If your Firebase project groups data under an env node, /env/github_accounts is also supported automatically when the direct node is empty. Example (replace placeholders with real PATs; never commit them):

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
      "work": {
        "username": "work-user",
        "token": "github_pat_REPLACE_ME",
        "description": "Work account",
        "orgs": ["example-org"],
        "enabled": true,
        "readonly": true
      }
    }

Recommended RTDB Security Rules: { "rules": { ".read": false, ".write": false } }

Encode the Firebase Service Account JSON file as one-line Base64:
- Linux: base64 -w 0 service-account.json
- macOS: base64 -i service-account.json | tr -d '\\n'
- Windows PowerShell: [Convert]::ToBase64String([IO.File]::ReadAllBytes("service-account.json"))

## GitHub Repository Secrets

`MCP_DOMAIN` is the only source of truth for the public MCP hostname. The deployment script uses it to create the Worker route and populate `PUBLIC_ORIGIN`. The workflow derives `https://<MCP_DOMAIN>/mcp` and writes the resulting endpoint to the job summary and deployment-status.json. No endpoint is read from or written to `worker-endpoint.txt`.

Runtime Firebase auth priority: `FIREBASE_SERVICE_ACCOUNT_JSON_B64` → `FIREBASE_SERVICE_ACCOUNT_JSON` → fallback `RTDB_AUTH_URL`. When using Service Account, set `RTDB_URL` to the clean URL ending in `/github_accounts.json` (the Worker also checks `/env/github_accounts.json` if the direct node is empty). Otherwise `RTDB_AUTH_URL` must include `?auth=...`.

`MCP_OAUTH_REDIRECT_URIS` and `TS_TRUST_CREDS` are deliberately ignored and never sent to the Worker. OAuth accepts any syntactically valid redirect URI except `javascript:`, `data:`, `vbscript:` schemes and URIs with fragments. No redirect allowlist is required.

## Connect AI clients

The MCP endpoint is `https://<MCP_DOMAIN>/mcp`; legacy SSE endpoint is `https://<MCP_DOMAIN>/sse`.

- ChatGPT Connectors / Claude Web & Desktop (OAuth 2.1): `https://<MCP_DOMAIN>/mcp`. Dynamic Client Registration is available; static clients may use `MCP_OAUTH_CLIENT_ID` and `MCP_OAUTH_CLIENT_SECRET`. Approve by entering MCP_TOKEN on `/authorize`.
- Gemini CLI / Cursor / Windsurf / Grok / custom agents: Streamable HTTP URL `https://<MCP_DOMAIN>/mcp`, with Authorization: Bearer <MCP_TOKEN> or X-API-Key: <MCP_TOKEN>. Optional X-GitHub-Account: <alias> pins an account.
- Legacy clients: `https://<MCP_DOMAIN>/sse` with the same static token or OAuth access token.

Before using GitHub tools, call list_github_accounts and pass the exact alias as the required account argument.
