export interface Env {
  MCP_TOKEN: string;
  OAUTH_CLIENT_ID?: string;
  OAUTH_CLIENT_SECRET?: string;
  RTDB_AUTH_URL?: string;
  FIREBASE_SERVICE_ACCOUNT_JSON?: string;
  GITHUB_ACCOUNTS?: string;
  LOCALMCP_HUB_ORIGIN?: string;
  CACHE_KV: KVNamespace;
  SSE_SESSIONS: DurableObjectNamespace;
  LOCALMCP_HUB?: DurableObjectNamespace;
}

export type CachedSandboxRunner = {
  id: string;
  runner_id: string;
  name?: string;
  template?: string;
  runtime?: string;
  size?: string;
  updated_at?: string;
};

export type RtdbAccount = {
  username: string;
  token: string;
  description: string;
  orgs: string[];
  enabled: boolean;
  readonly: boolean;
  localmcpgo_secrets?: Record<string, string>;
  localmcpgo_runners?: {
    instabox?: CachedSandboxRunner;
    upstashbox?: CachedSandboxRunner;
  };
  allowed_repositories?: string[];
  git_credentials?: {
    enabled?: boolean;
    allowed_repositories?: string[];
  };
};

export type PublicAccount = {
  alias: string;
  username: string;
  description: string;
  orgs: string[];
  readonly: boolean;
  providers: string[];
};

export type AuthContext = {
  method: "static_token" | "oauth";
  subject: string;
  sessionId?: string;
  pinnedAccount?: string;
  gitExecutor?: boolean;
};

export type McpTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};
