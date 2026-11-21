// SPDX-License-Identifier: Apache-2.0
/**
 * The parts of @notfusion/sophos-core the exporter uses: the token manager,
 * the whoami tenant resolver, the Sophos Central REST client, the Sophos
 * Fusion GraphQL client and the licence parser. Exporter local modification:
 * this index replaces NotFusion's, which also wires services the exporter
 * never calls (writes among them), and createSophosCore takes the fetch every
 * client uses. See ATTRIBUTIONS.md.
 */

import { TokenManager } from "./auth/token-manager.js";
import { FusionClient, type FusionClientOptions } from "./client/fusion-client.js";
import { SophosClient, type SophosClientOptions } from "./client/sophos-client.js";
import { TenantResolver } from "./client/tenant-resolver.js";
import { defaultFetch, type FetchLike } from "./http.js";

export * from "./config.js";
export * from "./logger.js";
export { buildUrl, formEncode, defaultFetch, type FetchLike } from "./http.js";
export * from "./hosts.js";
export * from "./auth/token-manager.js";
export * from "./client/tenant-resolver.js";
export * from "./client/sophos-client.js";
export * from "./client/fusion-client.js";
export * from "./types/sophos.js";
export * from "./services/licenses.js";

export interface SophosCoreOptions {
  clientId: string;
  clientSecret: string;
  /** Every request goes through this fetch. The exporter passes its read-only guard. */
  fetch?: FetchLike;
  rest?: Omit<SophosClientOptions, "fetch">;
  fusion?: Omit<FusionClientOptions, "fetch">;
}

export interface SophosCore {
  tokens: TokenManager;
  tenants: TenantResolver;
  rest: SophosClient;
  fusion: FusionClient;
}

/** Wires one credential. Call `tenants.init()` first: it runs /whoami/v1. */
export function createSophosCore(options: SophosCoreOptions): SophosCore {
  const fetchImpl = options.fetch ?? defaultFetch;
  const tokens = new TokenManager(options.clientId, options.clientSecret, fetchImpl);
  const tenants = new TenantResolver(tokens, fetchImpl);
  const rest = new SophosClient(tokens, tenants, { ...options.rest, fetch: fetchImpl });
  const fusion = new FusionClient(tokens, { ...options.fusion, fetch: fetchImpl });
  return { tokens, tenants, rest, fusion };
}
