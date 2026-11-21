/**
 * Licences (GET /licenses/v1/licenses on the global host, documented in the
 * Sophos Licensing API): fact_license, one snapshot a day, plus the partner
 * and organization IDs dim_tenant reports.
 */

import { parseLicenses } from "../vendor/sophos-core/index.js";
import type { Row } from "../store/csv.js";
import { dateDiffDays, localDate } from "../time.js";
import { store, type Dataset, type RunContext } from "./context.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function mapLicenses(body: unknown, tenantId: string, snapshotDate: string): Row[] {
  const root = record(body);
  const raw = Array.isArray(root.licenses) ? root.licenses : [];
  const genericById = new Map<string, string>();
  for (const entry of raw) {
    const e = record(entry);
    const id = text(e.id);
    const generic = text(record(e.product).genericCode);
    if (id && generic) genericById.set(id, generic);
  }
  return parseLicenses(body).map((l) => ({
    tenant_id: tenantId,
    snapshot_date: snapshotDate,
    license_id: l.id,
    license_code: l.code,
    generic_code: genericById.get(l.id) ?? null,
    product_name: l.name,
    license_type: l.type,
    quantity: l.quantity,
    used: l.used,
    unlimited: l.unlimited,
    perpetual: l.perpetual,
    start_date: l.startDate,
    end_date: l.endDate,
    days_to_end: l.endDate ? dateDiffDays(snapshotDate, l.endDate) : null,
  }));
}

/** Partner and organization IDs from a Licenses API answer. */
export function licenseOwners(body: unknown): { partnerId?: string; organizationId?: string } {
  const root = record(body);
  const partnerId = text(record(root.partner).id) ?? undefined;
  const organizationId = text(record(root.organization).id) ?? undefined;
  return { ...(partnerId ? { partnerId } : {}), ...(organizationId ? { organizationId } : {}) };
}

export const licensesDataset: Dataset = {
  name: "licenses",
  description: "Licences held by the tenant (fact_license).",
  async run(ctx: RunContext) {
    const snapshotDate = localDate(ctx.options.now, ctx.options.timeZone)!;
    const body = await ctx.session.global<unknown>("/licenses/v1/licenses");
    const rows = mapLicenses(body, ctx.tenantId, snapshotDate);
    store(ctx, "fact_license").replace((r) => r.tenant_id === ctx.tenantId && r.snapshot_date === snapshotDate, rows);
    Object.assign(ctx.facts, licenseOwners(body), { licenseCodes: [...new Set(rows.map((r) => String(r.license_code)))].sort() });
    return { rows: { fact_license: rows.length }, notes: rows.length ? [] : ["The Licenses API listed no licences for this tenant."] };
  },
};
