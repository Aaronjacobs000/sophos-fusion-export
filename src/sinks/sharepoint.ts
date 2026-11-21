/**
 * The SharePoint or OneDrive sink: uploads the table files and _schema.json
 * from the folder sink to a document library through Microsoft Graph, for
 * hosts that can't sync the library (a headless server, a container, a Mac
 * that doesn't sync that tenant).
 *
 * Auth is an Entra app registration with the client credentials flow, or,
 * in an Azure Container Apps job, the job's managed identity. The least
 * privilege setup is Sites.Selected with write on the one site, granted by an
 * admin; README has the steps. Only files whose content changed since the
 * last upload are sent.
 *
 * Requests may go only to the Entra token endpoint, Microsoft Graph, and the
 * SharePoint upload session URLs Graph hands back, over https, plus the local
 * managed identity endpoint when that is the sign-in.
 */

import { createHash } from "node:crypto";
import { GRAPH_RESOURCE, ManagedIdentity, managedIdentityFromEnv, type TokenSource } from "../azure/managed-identity.js";

export interface SharePointConfig {
  /** clientSecret (default): an app registration and its secret. managedIdentity: the Azure host's managed identity. */
  auth?: "clientSecret" | "managedIdentity";
  tenantId?: string;
  clientId?: string;
  clientSecret?: string;
  /** With managedIdentity: the client ID of a user-assigned identity. Empty means the system-assigned identity. */
  managedIdentityClientId?: string;
  /** https://contoso.sharepoint.com/sites/reporting, or a OneDrive URL https://contoso-my.sharepoint.com/personal/user_contoso_com */
  siteUrl: string;
  /** Document library name. Default "Documents" (Shared Documents in the URL). */
  library?: string;
  /** Folder inside the library. Default "FusionExport". */
  folder?: string;
}

export class SharePointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SharePointError";
  }
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

const GRAPH = "https://graph.microsoft.com/v1.0";
/** Graph takes up to 250 MB in one PUT; above this the sink uses an upload session. */
const SIMPLE_LIMIT = 200 * 1024 * 1024;
const CHUNK = 10 * 1024 * 1024;

export function assertGraphHost(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SharePointError("not a URL");
  }
  const host = parsed.hostname.toLowerCase();
  const ok =
    parsed.protocol === "https:" &&
    !parsed.username &&
    !parsed.password &&
    (host === "login.microsoftonline.com" || host === "graph.microsoft.com" || /^[a-z0-9-]+(-my)?\.sharepoint\.com$/.test(host));
  if (!ok) throw new SharePointError(`${host} is not a Microsoft Graph or SharePoint host`);
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Splits a SharePoint site or OneDrive URL into Graph's host and path form. */
export function siteReference(siteUrl: string): { host: string; path: string } {
  const url = new URL(siteUrl);
  if (url.protocol !== "https:" || !/\.sharepoint\.com$/i.test(url.hostname)) {
    throw new SharePointError("siteUrl must be an https SharePoint or OneDrive address, for example https://contoso.sharepoint.com/sites/reporting");
  }
  const path = url.pathname.replace(/\/+$/, "");
  return { host: url.hostname, path };
}

function encodePath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

export class SharePointSink {
  private token: { value: string; expires: number } | null = null;
  private driveId: string | null = null;
  readonly calls: Array<{ method: string; path: string; status: number }> = [];
  private readonly fetchImpl: FetchFn;

  private readonly identity: TokenSource | null;

  constructor(
    private readonly config: SharePointConfig,
    fetchImpl?: FetchFn,
    /** For the managedIdentity sign-in. Tests pass a fake; otherwise it comes from the environment. */
    identity?: TokenSource
  ) {
    const keys = config.auth === "managedIdentity" ? (["siteUrl"] as const) : (["tenantId", "clientId", "clientSecret", "siteUrl"] as const);
    for (const key of keys) {
      if (!config[key]) throw new SharePointError(`SharePoint upload needs ${key}.`);
    }
    this.identity =
      config.auth === "managedIdentity"
        ? (identity ??
          new ManagedIdentity({
            ...managedIdentityFromEnv(),
            ...(config.managedIdentityClientId ? { clientId: config.managedIdentityClientId } : {}),
          }))
        : null;
    const base = fetchImpl ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init));
    this.fetchImpl = async (input, init) => {
      assertGraphHost(input);
      return base(input, { ...init, redirect: "error" });
    };
  }

  get folder(): string {
    return (this.config.folder ?? "FusionExport").replace(/^\/+|\/+$/g, "");
  }

  private async send(url: string, init: RequestInit, attempt = 0): Promise<Response> {
    const response = await this.fetchImpl(url, init);
    this.calls.push({ method: init.method ?? "GET", path: new URL(url).pathname, status: response.status });
    if ((response.status === 429 || response.status === 503) && attempt < 4) {
      const wait = Math.min(60, Number(response.headers.get("Retry-After")) || 2 ** attempt * 2) * 1000;
      await response.body?.cancel().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, wait));
      return this.send(url, init, attempt + 1);
    }
    return response;
  }

  private async accessToken(): Promise<string> {
    if (this.identity) return (await this.identity.token(GRAPH_RESOURCE)).value;
    if (this.token && Date.now() < this.token.expires - 60_000) return this.token.value;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.config.clientId ?? "",
      client_secret: this.config.clientSecret ?? "",
      scope: "https://graph.microsoft.com/.default",
    });
    const response = await this.send(`https://login.microsoftonline.com/${encodeURIComponent(this.config.tenantId ?? "")}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const data = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!response.ok || !data.access_token) {
      // error_description never contains the secret; it names the app and the failure.
      throw new SharePointError(`Entra refused the app sign-in (${response.status} ${data.error ?? ""}): ${(data.error_description ?? "").split("\r\n")[0]}`);
    }
    this.token = { value: data.access_token, expires: Date.now() + (data.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  private async graph<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.accessToken();
    const response = await this.send(`${GRAPH}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
    const text = await response.text();
    if (!response.ok) {
      let message = text.slice(0, 300);
      try {
        message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
      } catch {
        // not JSON
      }
      throw new SharePointError(`Microsoft Graph answered ${response.status} for ${path.split("?")[0]}: ${message}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Finds the site and its library. Throws with a plain message when either is missing or not granted. */
  async resolve(): Promise<{ siteId: string; driveId: string; webUrl: string }> {
    const { host, path } = siteReference(this.config.siteUrl);
    const site = await this.graph<{ id: string; webUrl: string }>(`/sites/${host}:${path || "/"}?$select=id,webUrl`);
    const drives = await this.graph<{ value: Array<{ id: string; name: string }> }>(`/sites/${site.id}/drives?$select=id,name`);
    const wanted = this.config.library ?? "Documents";
    const drive = drives.value.find((d) => d.name.toLowerCase() === wanted.toLowerCase());
    if (!drive) throw new SharePointError(`The site has no library named ${wanted}. Libraries: ${drives.value.map((d) => d.name).join(", ") || "none visible"}.`);
    this.driveId = drive.id;
    return { siteId: site.id, driveId: drive.id, webUrl: site.webUrl };
  }

  /** Uploads one file into the folder. Returns the item's web URL. */
  async upload(name: string, text: string): Promise<string> {
    if (!this.driveId) await this.resolve();
    const bytes = Buffer.from(text, "utf8");
    const itemPath = encodePath(`${this.folder}/${name}`);
    if (bytes.length <= SIMPLE_LIMIT) {
      const item = await this.graph<{ webUrl?: string }>(`/drives/${this.driveId}/root:/${itemPath}:/content`, {
        method: "PUT",
        headers: { "Content-Type": name.endsWith(".json") ? "application/json" : "text/csv" },
        body: bytes,
      });
      return item.webUrl ?? "";
    }
    const session = await this.graph<{ uploadUrl: string }>(`/drives/${this.driveId}/root:/${itemPath}:/createUploadSession`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "replace" } }),
    });
    let webUrl = "";
    for (let start = 0; start < bytes.length; start += CHUNK) {
      const end = Math.min(bytes.length, start + CHUNK);
      const response = await this.send(session.uploadUrl, {
        method: "PUT",
        headers: { "Content-Length": String(end - start), "Content-Range": `bytes ${start}-${end - 1}/${bytes.length}` },
        body: bytes.subarray(start, end),
      });
      if (!response.ok) throw new SharePointError(`The upload session answered ${response.status} at byte ${start}.`);
      const data = (await response.json().catch(() => ({}))) as { webUrl?: string };
      if (data.webUrl) webUrl = data.webUrl;
    }
    return webUrl;
  }

  /**
   * Uploads the files whose hash differs from `previous` (name to sha256).
   * Returns the new hash map and the names sent.
   */
  async sync(files: ReadonlyMap<string, string>, previous: Record<string, string>): Promise<{ hashes: Record<string, string>; sent: string[] }> {
    const hashes: Record<string, string> = { ...previous };
    const sent: string[] = [];
    for (const [name, text] of files) {
      const hash = sha256(text);
      if (previous[name] === hash) continue;
      await this.upload(name, text);
      hashes[name] = hash;
      sent.push(name);
    }
    return { hashes, sent };
  }
}
