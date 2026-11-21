// SPDX-License-Identifier: Apache-2.0
/**
 * A tenant's licenses (GET /licenses/v1/licenses on the global host with
 * X-Tenant-ID), and the rule for whether a tenant can have cases: Sophos
 * XDR, Sophos MDR or Sophos EDR.
 *
 * The Licenses API answers { licenses, tenant, partner?, organization? }.
 * Each license has product { code, name, genericCode? }, type (term, trial,
 * usage), quantity, startDate and endDate, perpetual and unlimited flags,
 * and usage.current.count. An MSP monthly license comes as type "usage",
 * unlimited and perpetual, with no quantity and no end date (live tenants,
 * 11/10/2026).
 */

import type { SophosClient } from "../client/sophos-client.js";

export interface TenantLicense {
  /** Sophos's ID for the license record. A product can appear on more than one. */
  id: string;
  /** The license code, for example CIXAXDR or XDR-MSP. */
  code: string;
  /** The product name Sophos gives, for example "Sophos XDR - User". The code when there is none. */
  name: string;
  /** "term", "trial", "usage" (MSP monthly), or another word Sophos sends. Null when absent. */
  type: string | null;
  /** Licensed quantity. Null for an unlimited license or when Sophos sends none. */
  quantity: number | null;
  /** Current usage count. Null when Sophos sends none. */
  used: number | null;
  unlimited: boolean;
  perpetual: boolean;
  /** YYYY-MM-DD. */
  startDate: string | null;
  /** YYYY-MM-DD. Null for a perpetual license or when Sophos sends none. */
  endDate: string | null;
}

const SECOPS_PRODUCT = /EDR|XDR|MTR|MDR/;
const ADDON = /ADDON/;

/**
 * Whether a license code gives the tenant cases: a code containing EDR, XDR,
 * MTR or MDR counts, unless it contains ADDON. Seen live on 11/10/2026:
 * XDR-MSP, SVRXDR-MSP, CIXAXDR and SVRCIXAXDR (Sophos XDR); CIXAMTR-STD-MSP,
 * SVRCIXAMTR-STD-MSP, CIXAMTR-ADV-MSP, SVRCIXAMTR-ADV-MSP, MDR-COMPLETE and
 * SVRMDR-COMPLETE (Sophos MDR and MDR Plus); SVREDR-MSP (Sophos EDR). Not
 * counted: CIXA-MSP (Sophos Endpoint), NDR, ITDR, MDR-DS1-ADDON-MSP (data
 * storage) and MDR-FWI-ADDON (Firewall Integration Pack).
 */
export function isSecOpsLicenseCode(code: string): boolean {
  const upper = code.toUpperCase();
  return SECOPS_PRODUCT.test(upper) && !ADDON.test(upper);
}

/** Whether any of these license codes gives the tenant cases. */
export function hasSecOpsLicense(codes: readonly string[]): boolean {
  return codes.some(isSecOpsLicenseCode);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** The licenses in a Licenses API answer, skipping any without a code. Sorted by name. */
export function parseLicenses(body: unknown): TenantLicense[] {
  const root = record(body);
  const list = Array.isArray(root.licenses) ? root.licenses : Array.isArray(root.items) ? root.items : [];
  const licenses: TenantLicense[] = [];
  list.forEach((entry, index) => {
    const raw = record(entry);
    const product = record(raw.product);
    const code = text(product.code) ?? text(raw.licenseCode);
    if (!code) return;
    const unlimited = raw.unlimited === true;
    const perpetual = raw.perpetual === true;
    licenses.push({
      id: text(raw.id) ?? `${code}-${index}`,
      code,
      name: (text(product.name) ?? code).replace(/\s{2,}/g, " "),
      type: text(raw.type),
      quantity: unlimited ? null : count(raw.quantity),
      used: count(record(record(raw.usage).current).count),
      unlimited,
      perpetual,
      startDate: text(raw.startDate),
      endDate: perpetual ? null : text(raw.endDate),
    });
  });
  return licenses.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.code.localeCompare(b.code));
}

export class LicensesService {
  constructor(private client: SophosClient) {}

  /** Every license the tenant holds. Read only. */
  async list(tenantId: string): Promise<TenantLicense[]> {
    return parseLicenses(await this.client.tenantGlobalRequest<unknown>(tenantId, "/licenses/v1/licenses"));
  }
}
