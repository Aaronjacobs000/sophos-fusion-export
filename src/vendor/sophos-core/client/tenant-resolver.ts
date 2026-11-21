// SPDX-License-Identifier: MIT
// Adapted from sophos-central-mcp-server (https://github.com/Aaronjacobs000/sophos-mcp),
// src/client/tenant-resolver.ts at commit 9471c18. MIT License, Copyright (c) 2026; the full notice
// is in LICENSE-MIT at the root of this package.

/**
 * Discovers the caller's identity type via /whoami/v1 and resolves
 * tenant IDs to their regional API hosts. Caches the mapping.
 */

import { SOPHOS_GLOBAL_API } from "../config.js";
import { buildUrl, defaultFetch, type FetchLike } from "../http.js";
import { log } from "../logger.js";
import type { TokenManager } from "../auth/token-manager.js";
import type {
  SophosIdType,
  SophosWhoamiResponse,
  SophosTenant,
  SophosTenantPage,
} from "../types/sophos.js";

/** The largest page the tenant list serves. */
export const TENANT_PAGE_SIZE = 100;

export interface TenantInfo {
  id: string;
  name: string;
  apiHost: string;
  dataRegion: string;
  dataGeography: string;
  /**
   * The tenant's license codes from the tenant list, [] for a tenant with
   * none. Undefined when the list carries no license codes for any tenant,
   * so a list that doesn't send them never reads as "nothing licensed".
   */
  products?: string[];
}

export interface CallerIdentity {
  id: string;
  idType: SophosIdType;
  apiHosts: {
    global: string;
    dataRegion?: string;
  };
}

export class TenantResolver {
  private identity: CallerIdentity | null = null;
  private tenantCache = new Map<string, TenantInfo>();
  private tenantsLoaded = false;

  constructor(
    private tokenManager: TokenManager,
    // Exporter local modification: the injected fetch, so the guard sees whoami and the tenant list.
    private fetchImpl: FetchLike = defaultFetch
  ) {}

  /**
   * Initialize: calls /whoami/v1 and discovers the caller identity.
   */
  async init(): Promise<CallerIdentity> {
    const token = await this.tokenManager.getToken();
    const response = await this.fetchImpl(`${SOPHOS_GLOBAL_API}/whoami/v1`, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Whoami failed (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as SophosWhoamiResponse;
    this.identity = {
      id: data.id,
      idType: data.idType,
      apiHosts: data.apiHosts,
    };

    log().debug(`[sophos-tenant] Identity: ${data.idType} (${data.id})`);

    // For tenant-level callers, the data region host is returned directly
    if (data.idType === "tenant" && data.apiHosts.dataRegion) {
      this.tenantCache.set(data.id, {
        id: data.id,
        name: "self",
        apiHost: data.apiHosts.dataRegion,
        dataRegion: "self",
        dataGeography: "unknown",
      });
      this.tenantsLoaded = true;
    }

    return this.identity;
  }

  getIdentity(): CallerIdentity {
    if (!this.identity) {
      throw new Error("TenantResolver not initialized. Call init() first.");
    }
    return this.identity;
  }

  /**
   * Returns the ID type header name needed for partner/org API calls.
   */
  getIdHeader(): { name: string; value: string } {
    const identity = this.getIdentity();
    switch (identity.idType) {
      case "partner":
        return { name: "X-Partner-ID", value: identity.id };
      case "organization":
        return { name: "X-Organization-ID", value: identity.id };
      case "tenant":
        return { name: "X-Tenant-ID", value: identity.id };
    }
  }

  /**
   * Loads all tenants for partner/org callers. Paginates through all pages.
   */
  async loadTenants(): Promise<TenantInfo[]> {
    const identity = this.getIdentity();

    if (identity.idType === "tenant") {
      return Array.from(this.tenantCache.values());
    }

    if (this.tenantsLoaded) {
      return Array.from(this.tenantCache.values());
    }

    const apiPath =
      identity.idType === "partner"
        ? "/partner/v1/tenants"
        : "/organization/v1/tenants";

    // 100 a page is the most the list serves (1000 is a 400). Once the first page gives the
    // page count, the rest are read together, which keeps the list near 2 s at any size.
    const first = await this.loadTenantPage(apiPath, 1);
    const totalPages = first.pages?.total ?? 1;
    const rest = await Promise.all(
      Array.from({ length: Math.max(0, totalPages - 1) }, (_, index) => this.loadTenantPage(apiPath, index + 2))
    );
    const listed: SophosTenant[] = [first, ...rest].flatMap((page) => page.items ?? []);

    const carriesProducts = listed.some((tenant) => Array.isArray(tenant.products));
    for (const tenant of listed) {
      this.tenantCache.set(tenant.id, {
        id: tenant.id,
        name: tenant.name,
        apiHost: tenant.apiHost,
        dataRegion: tenant.dataRegion,
        dataGeography: tenant.dataGeography,
        ...(carriesProducts ? { products: productCodes(tenant.products) } : {}),
      });
    }

    this.tenantsLoaded = true;
    log().debug(`[sophos-tenant] Loaded ${this.tenantCache.size} tenants`);
    return Array.from(this.tenantCache.values());
  }

  private async loadTenantPage(apiPath: string, page: number): Promise<SophosTenantPage> {
    const idHeader = this.getIdHeader();
    const token = await this.tokenManager.getToken();
    const url = buildUrl(SOPHOS_GLOBAL_API, apiPath, {
      page: String(page),
      pageSize: String(TENANT_PAGE_SIZE),
      pageTotal: page === 1 ? "true" : undefined,
    });
    const response = await this.fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        [idHeader.name]: idHeader.value,
      },
      redirect: "error",
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`List tenants failed (${response.status}): ${errorText}`);
    }
    return (await response.json()) as SophosTenantPage;
  }

  /**
   * Resolves a tenant ID to its API host. Loads tenants if not cached.
   */
  async resolveApiHost(tenantId: string): Promise<string> {
    if (this.tenantCache.has(tenantId)) {
      return this.tenantCache.get(tenantId)!.apiHost;
    }

    // Try loading tenants if we haven't yet
    if (!this.tenantsLoaded) {
      await this.loadTenants();
    }

    const info = this.tenantCache.get(tenantId);
    if (!info) {
      throw new Error(
        `Tenant ${tenantId} is not one this credential can see.`
      );
    }
    return info.apiHost;
  }

  /**
   * Returns the tenant ID to use. For single-tenant callers, returns the
   * identity ID. For partner/org callers, requires an explicit tenant ID.
   */
  resolveTenantId(providedTenantId?: string): string {
    const identity = this.getIdentity();

    if (identity.idType === "tenant") {
      return providedTenantId || identity.id;
    }

    if (!providedTenantId) {
      throw new Error(
        "A tenant ID is required for partner and organization credentials. Choose a tenant first."
      );
    }

    return providedTenantId;
  }

  /**
   * Returns all cached tenants.
   */
  getCachedTenants(): TenantInfo[] {
    return Array.from(this.tenantCache.values());
  }
}

/** The license codes in a tenant list entry's products, without blanks or repeats. */
export function productCodes(products: SophosTenant["products"]): string[] {
  if (!Array.isArray(products)) return [];
  const codes = products.map((product) => (product && typeof product.code === "string" ? product.code.trim() : "")).filter(Boolean);
  return [...new Set(codes)];
}
