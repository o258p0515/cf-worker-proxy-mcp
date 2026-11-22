import sodium from "libsodium-wrappers";

type SecretAction = "list_github_secrets" | "set_github_secret" | "delete_github_secret";
const API_VERSION = "2022-11-28";

function validateTarget(args: Record<string, unknown>) {
  const owner = typeof args.owner === "string" ? args.owner.trim() : "";
  const repo = typeof args.repo === "string" ? args.repo.trim() : "";
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) {
    throw new Error("A valid repository owner and repository name are required.");
  }
  return { owner, repo };
}
function validateSecretName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Z_][A-Z0-9_]{0,99}$/.test(name)) throw new Error("secret_name must use uppercase letters, digits, and underscores (1-100 characters).");
  return name;
}
function apiHeaders(token: string) {
  return new Headers({
    Authorization: "Bearer " + token,
    Accept: "application/vnd.github+json",
    "User-Agent": "github-mcp-proxy",
    "X-GitHub-Api-Version": API_VERSION,
    "Content-Type": "application/json"
  });
}
async function githubRequest(token: string, path: string, init: RequestInit = {}) {
  const response = await fetch("https://api.github.com" + path, {
    ...init,
    headers: new Headers({ ...Object.fromEntries(apiHeaders(token)), ...Object.fromEntries(new Headers(init.headers || {})) })
  });
  if (response.status === 204) return null;
  const raw = await response.text();
  let body: any = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
  if (!response.ok) {
    const message = typeof body.message === "string" ? body.message : raw.trim().slice(0, 500) || "GitHub API request failed";
    const requestId = response.headers.get("X-GitHub-Request-Id");
    const permissions = response.headers.get("X-Accepted-GitHub-Permissions");
    const details = ["GitHub Actions Secrets API " + path + " returned HTTP " + response.status + ": " + message];
    if (permissions) details.push("required_permissions=" + permissions);
    if (requestId) details.push("request_id=" + requestId);
    throw new Error(details.join("; "));
  }
  return body;
}

export async function runGitHubSecretTool(
  action: SecretAction,
  args: Record<string, unknown>,
  token: string
): Promise<Record<string, unknown>> {
  const { owner, repo } = validateTarget(args);
  const base = "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo) + "/actions/secrets";
  if (action === "list_github_secrets") {
    const data = await githubRequest(token, base + "?per_page=100");
    const secrets = Array.isArray(data?.secrets) ? data.secrets : [];
    return { repository: owner + "/" + repo, total_count: data?.total_count ?? secrets.length, secrets: secrets.map((item: any) => ({ name: item.name, created_at: item.created_at, updated_at: item.updated_at })) };
  }
  const name = validateSecretName(args.secret_name);
  if (action === "delete_github_secret") {
    await githubRequest(token, base + "/" + encodeURIComponent(name), { method: "DELETE" });
    return { repository: owner + "/" + repo, secret_name: name, deleted: true, value_returned: false };
  }
  const value = typeof args.value === "string" ? args.value : "";
  if (!value || value.length > 48000) throw new Error("value must be a non-empty string no longer than 48,000 characters.");
  const key = await githubRequest(token, base + "/public-key");
  if (typeof key?.key !== "string" || typeof key?.key_id !== "string") throw new Error("GitHub did not return a valid Actions public key.");
  await sodium.ready;
  const encrypted = sodium.crypto_box_seal(sodium.from_string(value), sodium.from_base64(key.key, sodium.base64_variants.ORIGINAL));
  const encryptedValue = sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL);
  await githubRequest(token, base + "/" + encodeURIComponent(name), {
    method: "PUT",
    body: JSON.stringify({ encrypted_value: encryptedValue, key_id: key.key_id })
  });
  return { repository: owner + "/" + repo, secret_name: name, updated: true, encrypted: true, value_returned: false };
}
