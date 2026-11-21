/**
 * Azure managed identity, for running the exporter as an Azure Container Apps
 * job: tokens from the identity endpoint the platform exposes through
 * IDENTITY_ENDPOINT and IDENTITY_HEADER, and Key Vault secret reads with
 * them. Nothing here runs unless the config or environment asks for it.
 *
 * Requests may go only to the identity endpoint on the local host and to a
 * Key Vault at https://<name>.vault.azure.net. Tokens and secret values are
 * never logged or put in an error message.
 */

export class ManagedIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedIdentityError";
  }
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface AccessToken {
  value: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/** Anything that hands out bearer tokens for a resource, such as https://graph.microsoft.com. */
export interface TokenSource {
  token(resource: string): Promise<AccessToken>;
}

export interface ManagedIdentityOptions {
  endpoint: string;
  header: string;
  /** Client ID of a user-assigned identity. Empty means the system-assigned identity. */
  clientId?: string;
  fetch?: FetchFn;
  /** Attempts for a failed token request (500, 503, 429 or a network error). Default 3. */
  attempts?: number;
}

export const GRAPH_RESOURCE = "https://graph.microsoft.com";
export const KEY_VAULT_RESOURCE = "https://vault.azure.net";
const TOKEN_API_VERSION = "2019-08-01";
const KEY_VAULT_API_VERSION = "7.4";
const TIMEOUT_MS = 30_000;

/** The identity endpoint is a local URL. Anything else is refused, so the identity header can't leave the host. */
export function assertIdentityEndpoint(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ManagedIdentityError("IDENTITY_ENDPOINT is not a URL.");
  }
  const host = parsed.hostname.toLowerCase();
  const local = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "169.254.169.254";
  if (!local || (parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
    throw new ManagedIdentityError(`IDENTITY_ENDPOINT must be a local address; ${host} is not.`);
  }
  return parsed;
}

/** Reads the identity endpoint from the environment Container Apps sets. AZURE_CLIENT_ID picks a user-assigned identity. */
export function managedIdentityFromEnv(env: NodeJS.ProcessEnv = process.env): ManagedIdentityOptions {
  const endpoint = env.IDENTITY_ENDPOINT ?? "";
  const header = env.IDENTITY_HEADER ?? "";
  if (!endpoint || !header) {
    throw new ManagedIdentityError(
      "No managed identity here: IDENTITY_ENDPOINT and IDENTITY_HEADER are not set. They are set inside an Azure Container Apps job or app that has a managed identity."
    );
  }
  return { endpoint, header, ...(env.AZURE_CLIENT_ID ? { clientId: env.AZURE_CLIENT_ID } : {}) };
}

function errorDetail(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const b = body as { error?: unknown; error_description?: unknown; message?: unknown };
  if (b.error && typeof b.error === "object") {
    const e = b.error as { code?: unknown; message?: unknown };
    return [e.code, e.message].filter((x) => typeof x === "string" && x).join(": ");
  }
  return [b.error, b.error_description ?? b.message].filter((x) => typeof x === "string" && x).join(": ").split("\r\n")[0] ?? "";
}

export class ManagedIdentity implements TokenSource {
  private readonly endpoint: URL;
  private readonly cache = new Map<string, AccessToken>();
  private readonly fetchImpl: FetchFn;

  constructor(private readonly options: ManagedIdentityOptions) {
    this.endpoint = assertIdentityEndpoint(options.endpoint);
    if (!options.header) throw new ManagedIdentityError("The managed identity needs IDENTITY_HEADER.");
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  /** A token for the resource, reused until five minutes before it expires. */
  async token(resource: string): Promise<AccessToken> {
    const cached = this.cache.get(resource);
    if (cached && Date.now() < cached.expiresAt - 300_000) return cached;
    const url = new URL(this.endpoint);
    url.searchParams.set("resource", resource);
    url.searchParams.set("api-version", TOKEN_API_VERSION);
    if (this.options.clientId) url.searchParams.set("client_id", this.options.clientId);

    const attempts = this.options.attempts ?? 3;
    let lastError = "";
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(url.toString(), {
          method: "GET",
          headers: { "X-IDENTITY-HEADER": this.options.header, Metadata: "true" },
          redirect: "error",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt < attempts) await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }
      const body = (await response.json().catch(() => ({}))) as { access_token?: string; expires_on?: string | number; expires_in?: string | number };
      if (response.ok && body.access_token) {
        const expiresOn = Number(body.expires_on);
        const expiresAt = Number.isFinite(expiresOn) && expiresOn > 0 ? expiresOn * 1000 : Date.now() + (Number(body.expires_in) || 3600) * 1000;
        const token = { value: body.access_token, expiresAt };
        this.cache.set(resource, token);
        return token;
      }
      lastError = `${response.status} ${errorDetail(body)}`.trim();
      if (![429, 500, 502, 503, 504].includes(response.status)) break;
      if (attempt < attempts) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
    const which = this.options.clientId ? `the user-assigned identity ${this.options.clientId}` : "the system-assigned identity";
    throw new ManagedIdentityError(`The managed identity endpoint gave no token for ${resource} with ${which} (${lastError}).`);
  }
}

/** Checks a Key Vault address and returns its origin, for example https://kv-fusion.vault.azure.net. */
export function keyVaultOrigin(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ManagedIdentityError(`${url} is not a Key Vault URL. Use https://<vault name>.vault.azure.net.`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || !/^[a-z0-9-]{3,24}\.vault\.azure\.net$/i.test(parsed.hostname)) {
    throw new ManagedIdentityError(`${parsed.hostname} is not a Key Vault host. Use https://<vault name>.vault.azure.net.`);
  }
  return `https://${parsed.hostname.toLowerCase()}`;
}

/** Reads the current version of one secret. */
export async function readKeyVaultSecret(vaultUrl: string, name: string, identity: TokenSource, fetchImpl?: FetchFn): Promise<string> {
  const origin = keyVaultOrigin(vaultUrl);
  if (!/^[0-9a-zA-Z-]{1,127}$/.test(name)) throw new ManagedIdentityError(`${name} is not a Key Vault secret name.`);
  const token = await identity.token(KEY_VAULT_RESOURCE);
  const send = fetchImpl ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init));
  const response = await send(`${origin}/secrets/${name}?api-version=${KEY_VAULT_API_VERSION}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token.value}` },
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => ({}))) as { value?: unknown };
  if (response.ok && typeof body.value === "string" && body.value) return body.value;
  const vault = new URL(origin).hostname;
  if (response.status === 403) {
    throw new ManagedIdentityError(`The managed identity may not read secrets in ${vault} (403 ${errorDetail(body)}). Give it the Key Vault Secrets User role on the vault; a new role assignment takes a few minutes to apply.`);
  }
  if (response.status === 404) throw new ManagedIdentityError(`${vault} has no secret named ${name}.`);
  if (response.ok) throw new ManagedIdentityError(`The secret ${name} in ${vault} is empty.`);
  throw new ManagedIdentityError(`Key Vault ${vault} answered ${response.status} for the secret ${name}: ${errorDetail(body)}`);
}

export const SOPHOS_CLIENT_ID_SECRET = "sophos-client-id";
export const SOPHOS_CLIENT_SECRET_SECRET = "sophos-client-secret";

/**
 * The Sophos credential: SOPHOS_CLIENT_ID and SOPHOS_CLIENT_SECRET from the
 * environment, with SOPHOS_KEY_VAULT_URL set filling in whichever is missing
 * from the Key Vault secrets sophos-client-id and sophos-client-secret, read
 * with the host's managed identity.
 */
export async function resolveSophosCredentials(
  env: NodeJS.ProcessEnv = process.env,
  deps: { identity?: TokenSource; fetch?: FetchFn } = {}
): Promise<{ clientId: string; clientSecret: string; source: "environment" | "key vault" }> {
  let clientId = env.SOPHOS_CLIENT_ID ?? "";
  let clientSecret = env.SOPHOS_CLIENT_SECRET ?? "";
  const vault = env.SOPHOS_KEY_VAULT_URL ?? "";
  if (!vault || (clientId && clientSecret)) return { clientId, clientSecret, source: "environment" };
  keyVaultOrigin(vault);
  const identity = deps.identity ?? new ManagedIdentity(managedIdentityFromEnv(env));
  if (!clientId) clientId = await readKeyVaultSecret(vault, SOPHOS_CLIENT_ID_SECRET, identity, deps.fetch);
  if (!clientSecret) clientSecret = await readKeyVaultSecret(vault, SOPHOS_CLIENT_SECRET_SECRET, identity, deps.fetch);
  return { clientId, clientSecret, source: "key vault" };
}
