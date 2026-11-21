/**
 * One Sophos credential, opened for a run: the vendored sophos-core clients
 * wired to the read-only guard and the rate limiter, the whoami answer, and
 * the call log.
 *
 * This release takes a tenant credential only. A partner or organization
 * credential is refused with a plain message; partner mode is planned as an
 * added auth mode and tenant fan-out in this same exporter, which is why
 * every row already carries tenant_id.
 */

import { createSophosCore, FusionGraphQLError, SophosApiRequestError, type FetchLike, type SophosCore } from "../vendor/sophos-core/index.js";
import { createGuardedFetch, type CallRecord } from "./guard.js";
import { RateLimiter } from "./limiter.js";

export interface SessionOptions {
  clientId: string;
  clientSecret: string;
  perMinute?: number;
  perHour?: number;
  maxCalls?: number;
  /** Tests pass a fake Sophos here. It still sits behind the guard. */
  baseFetch?: FetchLike;
  limiter?: RateLimiter;
  /** Retries after the first attempt for 429, 5xx and network failures. Default 2. */
  retries?: number;
}

export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialError";
  }
}

export class SophosSession {
  readonly calls: CallRecord[] = [];
  readonly limiter: RateLimiter;
  private readonly guarded: ReturnType<typeof createGuardedFetch>;
  private readonly core: SophosCore;
  tenantId = "";
  apiHost = "";
  globalHost = "";

  private constructor(options: SessionOptions) {
    this.limiter = options.limiter ?? new RateLimiter({ perMinute: options.perMinute, perHour: options.perHour });
    this.guarded = createGuardedFetch({
      limiter: this.limiter,
      baseFetch: options.baseFetch,
      maxCalls: options.maxCalls,
      onCall: (record) => this.calls.push(record),
    });
    const retries = options.retries ?? 2;
    this.core = createSophosCore({
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      fetch: this.guarded,
      rest: { retries },
      fusion: { retries },
    });
  }

  /** Signs in and runs /whoami/v1. Throws CredentialError for anything but a tenant credential. */
  static async open(options: SessionOptions): Promise<SophosSession> {
    if (!options.clientId || !options.clientSecret) {
      throw new CredentialError("No Sophos credential. Set SOPHOS_CLIENT_ID and SOPHOS_CLIENT_SECRET, or pass --env-file.");
    }
    const session = new SophosSession(options);
    let identity;
    try {
      identity = await session.core.tenants.init();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/auth failed \((400|401)\)/i.test(message)) {
        throw new CredentialError(
          "Sophos refused the credential. Check the client ID and secret. API credentials last three years and can't be renewed; " +
            "an expired one disappears from Sophos Central without notice (Sophos KBA-000004438), so create a new one if it is gone."
        );
      }
      throw error;
    }
    if (identity.idType !== "tenant") {
      throw new CredentialError(
        `This is a ${identity.idType} credential. This release exports one tenant, so it needs a tenant credential. Partner and organization credentials are planned.`
      );
    }
    session.tenantId = identity.id;
    session.apiHost = identity.apiHosts.dataRegion ?? "";
    session.globalHost = identity.apiHosts.global;
    return session;
  }

  /** A GET on the tenant's regional host. */
  rest<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    return this.core.rest.tenantRequest<T>(this.tenantId, path, { params });
  }

  /** A GET on the global host scoped by X-Tenant-ID (licences). */
  global<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    return this.core.rest.tenantGlobalRequest<T>(this.tenantId, path, { params });
  }

  /** One of the exporter's own GraphQL queries. Partial responses come back with warnings. */
  async graphql<T extends object>(document: string, variables: Record<string, unknown> = {}): Promise<{ data: T; warnings: string[] }> {
    const result = await this.core.fusion.query<T>(this.tenantId, document, variables);
    return { data: result.data, warnings: result.warnings };
  }

  /** API calls sent so far (token requests included). */
  get callCount(): number {
    return this.guarded.calls();
  }
}

/** True when Fusion says the tenant isn't on Sophos Fusion (HTTP 503 "not found or not accessible"). */
export function isNotOnFusion(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Sophos Fusion API error 503/.test(message) && /not found or not accessible/i.test(message);
}

/** True for a 403 or a GraphQL "not allowed" style refusal. */
export function isForbidden(error: unknown): boolean {
  if (error instanceof SophosApiRequestError) return error.status === 403;
  if (error instanceof FusionGraphQLError) return error.errors.some((e) => /not (allowed|authorized)|forbidden|permission/i.test(e.message ?? ""));
  const message = error instanceof Error ? error.message : String(error);
  return /\b403\b/.test(message);
}
