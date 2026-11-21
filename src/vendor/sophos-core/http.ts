// SPDX-License-Identifier: Apache-2.0
/**
 * Query string and form encoding without URL or URLSearchParams. React
 * Native's built-in URLSearchParams has historically implemented only append
 * and toString, and URL has thrown on most getters, so the shipped path builds
 * strings directly rather than depend on a polyfill being installed.
 */

/** `${base}${path}` plus the params whose value is neither undefined nor "". */
export function buildUrl(
  base: string,
  path: string,
  params?: Record<string, string | undefined>
): string {
  const url = `${base}${path}`;
  const query = params
    ? Object.entries(params)
        .filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== "")
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join("&")
    : "";
  if (!query) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${query}`;
}

/** application/x-www-form-urlencoded body. */
export function formEncode(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

/**
 * The fetch function the clients call. Defaults to the global fetch, looked up
 * at call time; the exporter passes its read-only, rate-limited transport, so
 * every request goes through the guard. (Exporter local modification, adapted
 * from the SecOps Toolkit's 05/10/2026 change.)
 */
export type FetchLike = (input: string, init?: globalThis.RequestInit) => Promise<globalThis.Response>;

export const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);
