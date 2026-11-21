// SPDX-License-Identifier: MIT
// Adapted from sophos-central-mcp-server (https://github.com/Aaronjacobs000/sophos-mcp),
// src/client/sophos-client.ts at commit 9471c18. MIT License, Copyright (c) 2026; the full notice
// is in LICENSE-MIT at the root of this package.

/**
 * HTTP client for Sophos Central APIs.
 * Handles region-aware routing, auth headers, retries, and error mapping.
 */

import type { TokenManager } from "../auth/token-manager.js";
import type { TenantResolver } from "./tenant-resolver.js";
import type { SophosApiError } from "../types/sophos.js";
import { SOPHOS_GLOBAL_API } from "../config.js";
import { sophosApiBase } from "../hosts.js";
import { buildUrl, defaultFetch, type FetchLike } from "../http.js";
import { log } from "../logger.js";

/**
 * A non-2xx response from a Sophos Central REST API. The message keeps the
 * MCP server's wording; the fields carry what an error sheet and the audit
 * log need, correlationId above all, because Sophos support asks for it.
 */
export class SophosApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly error: string | null,
    readonly correlationId: string | null,
    readonly requestId: string | null
  ) {
    super(message);
    this.name = "SophosApiRequestError";
  }
}

/**
 * A 429 from a client set to hand rate limits back to its caller
 * (onRateLimit "throw"), so the caller can pause every call it makes rather
 * than let each one wait and retry on its own.
 */
export class SophosRateLimitError extends SophosApiRequestError {
  constructor(
    message = "Sophos API error 429: TooManyRequests",
    /** Retry-After in milliseconds, when Sophos sent one. */
    readonly retryAfterMs: number | null = null
  ) {
    super(message, 429, "TooManyRequests", null, null);
    this.name = "SophosRateLimitError";
  }
}

/** True for a 429 from either client. */
export function isRateLimitError(error: unknown): boolean {
  return error instanceof SophosApiRequestError && error.status === 429;
}

/**
 * Awaited before each attempt. It resolves when the call may go, with a
 * function to call once the response (or the failure) arrives, given the
 * HTTP status when there was one. The app paces and counts its own calls
 * through it, because Sophos sends no rate-limit headers.
 */
export type RequestGate = () => Promise<(status?: number) => void>;

/** How a client sends its calls. The defaults are the interactive app's. */
export interface SophosClientOptions {
  /** Per-attempt timeout. Default 30 s. */
  timeoutMs?: number;
  /** Retries after the first attempt for 429, 5xx and network failures. Default 2. */
  retries?: number;
  /** "throw" ends a call at its first 429 with a SophosRateLimitError. Default "wait": wait and retry. */
  onRateLimit?: "wait" | "throw";
  gate?: RequestGate;
  /** Exporter local modification: the injected fetch, so the guard sees every call. */
  fetch?: FetchLike;
}

/** What a response said about itself, for the audit log and a ticket to Sophos. */
export interface ResponseMeta {
  status: number;
  /** The x-correlation-id header. Sophos support asks for it. */
  correlationId: string | null;
  /** The x-request-id header. */
  requestId: string | null;
}

/** A response body with its ResponseMeta. */
export interface MetaResult<T> {
  data: T;
  meta: ResponseMeta;
}

export interface RequestOptions {
  /** HTTP method */
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Query parameters */
  params?: Record<string, string>;
  /** JSON request body */
  body?: unknown;
  /** Additional headers */
  headers?: Record<string, string>;
  /**
   * False for a call that is not safe to repeat, such as starting a scan or
   * running an alert action. A 5xx or a network failure is then not retried,
   * because the first attempt may already have reached Sophos. A 429 is still
   * retried: Sophos turned it away before doing anything. Default true.
   */
  idempotent?: boolean;
  /**
   * False for a call the caller retries itself, such as the MAC block list
   * PUT, which has to read the list again before each try: no automatic
   * retry of any kind, and a 429 throws SophosRateLimitError. Default true.
   */
  retry?: boolean;
}

export class SophosClient {
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly onRateLimit: "wait" | "throw";
  private readonly gate: RequestGate | undefined;
  private readonly fetchImpl: FetchLike;

  constructor(
    private tokenManager: TokenManager,
    private tenantResolver: TenantResolver,
    options: SophosClientOptions = {}
  ) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.retries = options.retries ?? 2;
    this.onRateLimit = options.onRateLimit ?? "wait";
    this.gate = options.gate;
    this.fetchImpl = options.fetch ?? defaultFetch;
  }

  /**
   * Make a request to a tenant-scoped API endpoint.
   * Automatically resolves the regional API host for the tenant.
   */
  async tenantRequest<T>(
    tenantId: string,
    path: string,
    options: RequestOptions = {}
  ): Promise<T> {
    return (await this.tenantRequestWithMeta<T>(tenantId, path, options)).data;
  }

  /** tenantRequest, plus the correlation and request IDs Sophos sent back. Writes use it for the audit log. */
  async tenantRequestWithMeta<T>(
    tenantId: string,
    path: string,
    options: RequestOptions = {}
  ): Promise<MetaResult<T>> {
    // The host comes from Sophos's answers and the saved profile: checked before the token goes anywhere.
    const apiHost = sophosApiBase(await this.tenantResolver.resolveApiHost(tenantId));
    const token = await this.tokenManager.getToken();

    const url = buildUrl(apiHost, path, options.params);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "X-Tenant-ID": tenantId,
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    };

    const fetchOptions: globalThis.RequestInit = {
      method: options.method || "GET",
      headers,
    };

    if (options.body) {
      fetchOptions.body = JSON.stringify(options.body);
    }

    return this.executeWithRetry<T>(url, fetchOptions, options.idempotent !== false, options.retry !== false);
  }

  /**
   * Make a request to a global API endpoint (partner/org level).
   */
  async globalRequest<T>(
    path: string,
    options: RequestOptions = {}
  ): Promise<T> {
    const identity = this.tenantResolver.getIdentity();
    const global = sophosApiBase(identity.apiHosts.global);
    const token = await this.tokenManager.getToken();
    const idHeader = this.tenantResolver.getIdHeader();

    const url = buildUrl(global, path, options.params);

    // Some global-host APIs (licensing, accounts, audit, business automation) are
    // scoped by an explicit X-Tenant-ID / X-Distributor-ID header. Sending the
    // caller's identity header alongside those can be rejected, so skip it when
    // the caller provides its own scope header.
    const hasOwnScopeHeader =
      options.headers &&
      Object.keys(options.headers).some((h) =>
        ["x-tenant-id", "x-distributor-id"].includes(h.toLowerCase())
      );

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      ...(hasOwnScopeHeader ? {} : { [idHeader.name]: idHeader.value }),
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    };

    const fetchOptions: globalThis.RequestInit = {
      method: options.method || "GET",
      headers,
    };

    if (options.body) {
      fetchOptions.body = JSON.stringify(options.body);
    }

    return (await this.executeWithRetry<T>(url, fetchOptions, options.idempotent !== false, options.retry !== false)).data;
  }

  /**
   * A request to a global-host API scoped to one tenant by X-Tenant-ID, such
   * as /licenses/v1/licenses. Unlike globalRequest it needs no /whoami/v1
   * first: the host is the global one and the only scope header is the
   * tenant's, which works for tenant and partner credentials alike.
   */
  async tenantGlobalRequest<T>(
    tenantId: string,
    path: string,
    options: RequestOptions = {}
  ): Promise<T> {
    const token = await this.tokenManager.getToken();
    const url = buildUrl(SOPHOS_GLOBAL_API, path, options.params);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "X-Tenant-ID": tenantId,
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    };
    const fetchOptions: globalThis.RequestInit = { method: options.method || "GET", headers };
    if (options.body) {
      fetchOptions.body = JSON.stringify(options.body);
    }
    return (await this.executeWithRetry<T>(url, fetchOptions, options.idempotent !== false, options.retry !== false)).data;
  }

  private async executeWithRetry<T>(
    url: string,
    options: globalThis.RequestInit,
    retryOnFailure: boolean,
    retry = true
  ): Promise<MetaResult<T>> {
    let lastError: Error | null = null;
    const retries = retry ? this.retries : 0;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const release = this.gate ? await this.gate() : undefined;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
        let response: globalThis.Response;
        try {
          // A redirect is refused rather than followed: the request carries the tenant's ID and any body to the new host.
          response = await this.fetchImpl(url, { ...options, redirect: "error", signal: controller.signal });
        } catch (error) {
          release?.();
          throw error;
        } finally {
          clearTimeout(timeout);
        }
        release?.(response.status);

        if (response.status === 429 && (this.onRateLimit === "throw" || !retry)) {
          throw new SophosRateLimitError(undefined, retryAfterMs(response.headers.get("Retry-After")));
        }

        if (response.status === 429) {
          // Rate limited: wait and retry
          const waitMs = retryAfterMs(response.headers.get("Retry-After")) ?? 5000;
          log().warn(`[sophos-client] Rate limited, waiting ${waitMs}ms (attempt ${attempt + 1})`);
          await this.sleep(waitMs);
          continue;
        }

        if (!response.ok) {
          const errorBody = await response.text();
          let parsed: SophosApiError | null = null;
          try {
            parsed = JSON.parse(errorBody) as SophosApiError;
          } catch {
            // Not JSON
          }

          const msg = parsed
            ? `Sophos API error ${response.status}: ${parsed.error ?? "UnknownError"}${parsed.message ? ` - ${parsed.message}` : ""}${parsed.correlationId ? ` (correlationId: ${parsed.correlationId})` : ""}`
            : `Sophos API error (${response.status}): ${errorBody.slice(0, 500)}`;

          throw new SophosApiRequestError(
            msg,
            response.status,
            parsed?.error ?? null,
            parsed?.correlationId ?? null,
            parsed?.requestId ?? null
          );
        }

        const meta: ResponseMeta = {
          status: response.status,
          correlationId: response.headers.get("x-correlation-id"),
          requestId: response.headers.get("x-request-id"),
        };

        // Some endpoints return 204 No Content
        if (response.status === 204) {
          return { data: {} as T, meta };
        }

        return { data: (await response.json()) as T, meta };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Don't retry on 4xx client errors (message contains "error NNN:" where NNN is 4xx)
        if (/Sophos API error 4\d\d:/.test(lastError.message)) {
          throw lastError;
        }

        // A call that is not safe to repeat may already have reached Sophos.
        if (!retryOnFailure) {
          throw lastError;
        }

        if (attempt < retries) {
          const backoff = Math.pow(2, attempt) * 1000;
          log().warn(`[sophos-client] Request failed, retrying in ${backoff}ms: ${lastError.message}`);
          await this.sleep(backoff);
        }
      }
    }

    throw lastError || new Error("Request failed after retries");
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * A Retry-After header as the milliseconds to wait, or null when there is
 * none or it can't be read. Sophos may send seconds or an HTTP date (RFC
 * 9110, 10.2.3); a date waits until then, and one already gone waits 0.
 * Either form is then waited out the same way, under the same limits.
 */
export function retryAfterMs(header: string | null | undefined, now: number = Date.now()): number | null {
  const value = header?.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number.parseInt(value, 10) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}
