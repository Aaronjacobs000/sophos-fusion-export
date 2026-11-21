/**
 * The read-only transport. Every Sophos call the exporter makes goes through
 * the fetch this module builds, and it refuses anything that could change a
 * tenant before a byte leaves the process:
 *
 *   - only the Sophos token endpoint, the Sophos Central API hosts and the
 *     Sophos Fusion GraphQL host are reachable, over https;
 *   - Sophos Central: GET only, and only on the paths the exporter reads;
 *   - Fusion GraphQL: POST /graphql only, and the document must be one of the
 *     exporter's own queries (src/sophos/documents.ts), compared character for
 *     character. No name or pattern match, and no mutation of any kind, even
 *     though the credential behind this guard may be a Super Admin;
 *   - the token request: POST to the one token URL;
 *   - a redirect is never followed, because a followed 307 or 308 would send
 *     the same request (the client secret, on the token call) to wherever the
 *     Location header points.
 *
 * It also takes a slot from the credential's rate limiter for every API call,
 * tells the limiter about a 429, and records each call for the run log.
 *
 * Adapted from the SecOps Toolkit's guard (backend/src/sophos/guard.ts, MIT,
 * same author), with the Search mutations, the XDR query runs, the GeoIP
 * download and the name based allowlist taken out.
 */

import { retryAfterMs, type FetchLike } from "../vendor/sophos-core/index.js";
import { DOCUMENTS } from "./documents.js";
import type { RateLimiter } from "./limiter.js";

export class ReadOnlyViolationError extends Error {
  constructor(message: string) {
    super(`Blocked by the read-only guard: ${message}`);
    this.name = "ReadOnlyViolationError";
  }
}

export const AUTH_URL = "https://id.sophos.com/api/v2/oauth2/token";
export const GRAPHQL_HOST = "api.taegis.sophos.com";

/** The Sophos Central REST paths the exporter reads. Anything else is refused, GET or not. */
export const ALLOWED_GET_PATHS: readonly RegExp[] = [
  /^\/whoami\/v1$/,
  /^\/licenses\/v1\/licenses$/,
  /^\/endpoint\/v1\/endpoints$/,
  /^\/common\/v1\/alerts$/,
  /^\/account-health-check\/v1\/health-check$/,
  /^\/cases\/v1\/cases$/,
];

const DOCUMENT_SET = new Set(DOCUMENTS.values());

export function isCentralHost(host: string): boolean {
  return host === "api.central.sophos.com" || /^api-[a-z0-9]+\.central\.sophos\.com$/.test(host);
}

/** True for hosts whose calls count against the Sophos API rate limit. */
export function isRateLimitedHost(host: string): boolean {
  return isCentralHost(host) || host === GRAPHQL_HOST;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function bodyText(body: unknown): string {
  if (typeof body === "string") return body;
  if (body === undefined || body === null) return "";
  throw new ReadOnlyViolationError("request bodies must be text");
}

/** The operation name of an allowed GraphQL request body, or a violation. */
export function allowedDocument(body: unknown): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText(body));
  } catch (error) {
    if (error instanceof ReadOnlyViolationError) throw error;
    throw new ReadOnlyViolationError("a GraphQL request needs a JSON body");
  }
  if (!plainObject(parsed)) throw new ReadOnlyViolationError("a GraphQL request body must be an object");
  const { query, variables, operationName, ...rest } = parsed;
  if (Object.keys(rest).length) throw new ReadOnlyViolationError("a GraphQL request carries only query, variables and operationName");
  if (typeof query !== "string" || !DOCUMENT_SET.has(query)) {
    throw new ReadOnlyViolationError("only the exporter's own query documents are sent, exactly as written");
  }
  if (variables !== undefined && !plainObject(variables)) throw new ReadOnlyViolationError("GraphQL variables must be an object");
  const name = [...DOCUMENTS].find(([, document]) => document === query)![0];
  if (operationName !== undefined && operationName !== null && operationName !== name) {
    throw new ReadOnlyViolationError(`operationName must be ${name}`);
  }
  return name;
}

/**
 * Throws ReadOnlyViolationError unless the request is one the exporter may
 * send. Pure: it looks only at the URL, method and body.
 */
export function assertReadOnly(input: string, init: globalThis.RequestInit = {}): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ReadOnlyViolationError("not a URL");
  }
  if (url.protocol !== "https:") throw new ReadOnlyViolationError(`${url.protocol} is not allowed, only https`);
  if (url.username || url.password || url.port) throw new ReadOnlyViolationError("no user name, password or port in a Sophos URL");
  const method = (init.method ?? "GET").toUpperCase();
  const host = url.hostname.toLowerCase();

  if (`${url.origin}${url.pathname}` === AUTH_URL) {
    if (method !== "POST" || url.search) throw new ReadOnlyViolationError("the token endpoint takes a plain POST only");
    return url;
  }

  if (isCentralHost(host)) {
    if (method !== "GET") throw new ReadOnlyViolationError(`${method} ${url.pathname} would change something; the exporter only reads`);
    if (init.body !== undefined && init.body !== null) throw new ReadOnlyViolationError("a GET carries no body");
    if (!ALLOWED_GET_PATHS.some((pattern) => pattern.test(url.pathname))) {
      throw new ReadOnlyViolationError(`${url.pathname} is not one of the paths the exporter reads`);
    }
    return url;
  }

  if (host === GRAPHQL_HOST) {
    if (method !== "POST" || url.pathname !== "/graphql" || url.search) {
      throw new ReadOnlyViolationError("Fusion GraphQL takes POST /graphql only");
    }
    allowedDocument(init.body);
    return url;
  }

  throw new ReadOnlyViolationError(`${host} is not a Sophos API host`);
}

export interface CallRecord {
  at: number;
  method: string;
  host: string;
  path: string;
  status: number;
  ms: number;
  /** The GraphQL operation name, for Fusion GraphQL calls. */
  operation?: string;
}

export interface GuardOptions {
  limiter: RateLimiter;
  /** The underlying fetch. Tests pass a fake Sophos. */
  baseFetch?: FetchLike;
  onCall?: (record: CallRecord) => void;
  /** Stops the run once this many API calls have gone out (a guard against runaway paging). */
  maxCalls?: number;
}

export class CallBudgetError extends Error {
  constructor(limit: number) {
    super(`The run reached its cap of ${limit} Sophos API calls and stopped. Raise maxCallsPerRun if the tenant needs more.`);
    this.name = "CallBudgetError";
  }
}

export function createGuardedFetch(options: GuardOptions): FetchLike & { calls: () => number } {
  const base = options.baseFetch ?? ((input, init) => globalThis.fetch(input, init));
  let calls = 0;
  const guarded = async (input: string, init: globalThis.RequestInit = {}) => {
    const url = assertReadOnly(input, init);
    const limited = isRateLimitedHost(url.hostname);
    if (limited) {
      if (options.maxCalls !== undefined && calls >= options.maxCalls) throw new CallBudgetError(options.maxCalls);
      calls++;
      await options.limiter.acquire();
    }
    const method = (init.method ?? "GET").toUpperCase();
    const operation = url.hostname === GRAPHQL_HOST ? allowedDocument(init.body) : undefined;
    const started = Date.now();
    const record = (status: number) => {
      if (!limited) return;
      options.onCall?.({ at: started, method, host: url.hostname, path: url.pathname, status, ms: Date.now() - started, operation });
    };
    let response: Response;
    try {
      response = await base(input, { ...init, redirect: "error" });
    } catch (error) {
      // A request that got no answer (a timeout) was still sent: it counts, with status 0.
      record(0);
      throw error;
    }
    record(response.status);
    if (response.status === 429) {
      // Seconds or an HTTP date; Number() read a date as NaN, so the pause fell back to 30 s.
      const waitMs = retryAfterMs(response.headers.get("Retry-After"));
      options.limiter.backoff(waitMs !== null && waitMs > 0 ? waitMs / 1000 : null);
    }
    if (response.status >= 300 && response.status <= 399) {
      response.body?.cancel().catch(() => {});
      throw new ReadOnlyViolationError(`Sophos answered ${url.host}${url.pathname} with a ${response.status} redirect, which is never followed`);
    }
    return response;
  };
  return Object.assign(guarded, { calls: () => calls });
}
