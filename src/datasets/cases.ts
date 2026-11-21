/**
 * Cases. A Sophos Fusion tenant is read through Cases GraphQL v2 (documented):
 * the full list on a backfill, then only cases updated since the watermark
 * minus an overlap, upserted on case ID. A tenant Fusion doesn't hold answers
 * 503 "not found or not accessible"; it is still on the Classic cases API, so
 * the exporter reads cases v1 (REST, documented, deprecated) in full instead
 * and tags those rows api_version v1. A tenant with neither gets an empty
 * table and a note.
 *
 * The reference lists (types, statuses, verdicts) are per tenant, because
 * Fusion builds them from the services the tenant is licensed for.
 */

import { CASE_REFERENCE_DATA, CASES_PAGE } from "../sophos/documents.js";
import { isForbidden, isNotOnFusion } from "../sophos/session.js";
import type { Row } from "../store/csv.js";
import { dateKey, daysBetween, isoSeconds, localDate, toDate } from "../time.js";
import { store, type Dataset, type RunContext } from "./context.js";

/** Cases per page: the most Cases v2 serves. */
export const CASES_PAGE_SIZE = 100;
/** Cases v1 serves at most 50 a page. */
export const LEGACY_PAGE_SIZE = 50;
/** A stop for runaway paging: 200 pages is 20,000 cases. */
const MAX_PAGES = 200;

const SEVERITY_LABELS: Record<number, string> = { 2: "Informational", 4: "Low", 6: "Medium", 8: "High", 10: "Critical" };

export function severityLabel(severity: number | null | undefined): string {
  return severity ? (SEVERITY_LABELS[severity] ?? String(severity)) : "Not set";
}

type Ref = { id?: string; name?: string; title?: string | null; isClosed?: boolean } | null | undefined;

function title(ref: Ref): string | null {
  return ref ? (ref.title || ref.name || null) : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export interface FusionCase {
  id: string;
  shortId?: string;
  title?: string;
  severity?: number;
  type?: Ref;
  primaryStatus?: Ref;
  secondaryStatus?: Ref;
  primaryVerdict?: Ref;
  secondaryVerdict?: Ref;
  closeReason?: string | null;
  managedBy?: string | null;
  isCreatedByMDRProvider?: boolean;
  isCreatedByPartner?: boolean;
  assigneeId?: string | null;
  tenantId?: string;
  createdAt?: string;
  updatedAt?: string;
  closedAt?: string | null;
  archivedAt?: string | null;
  riskScore?: number | null;
  source?: Ref;
  tags?: string[] | null;
  detectionsCount?: number;
  eventsCount?: number;
  assetsCount?: number;
}

function timing(createdAt: unknown, closedAt: unknown, now: Date): { minutes: number | null; ageDays: number | null } {
  const created = toDate(createdAt);
  const closed = toDate(closedAt);
  if (!created) return { minutes: null, ageDays: null };
  return {
    minutes: closed ? Math.max(0, Math.round((closed.getTime() - created.getTime()) / 60_000)) : null,
    ageDays: Math.max(0, daysBetween(created, closed ?? now)),
  };
}

export function mapFusionCase(c: FusionCase, tenantId: string, timeZone: string, now: Date): Row {
  const { minutes, ageDays } = timing(c.createdAt, c.closedAt, now);
  const severity = num(c.severity) ?? 0;
  return {
    tenant_id: tenantId,
    case_id: c.id,
    short_id: c.shortId ?? null,
    title: c.title ?? null,
    severity,
    severity_label: severityLabel(severity),
    case_type_id: c.type?.id ?? null,
    case_type: title(c.type),
    primary_status_id: c.primaryStatus?.id ?? null,
    primary_status: title(c.primaryStatus),
    secondary_status: title(c.secondaryStatus),
    is_closed: c.primaryStatus?.isClosed ?? !!c.closedAt,
    primary_verdict: title(c.primaryVerdict),
    secondary_verdict: title(c.secondaryVerdict),
    close_reason: c.closeReason ?? null,
    managed_by: c.managedBy ?? null,
    created_by_mdr: c.isCreatedByMDRProvider ?? null,
    created_by_partner: c.isCreatedByPartner ?? null,
    assignee_id: c.assigneeId ?? null,
    created_at: isoSeconds(c.createdAt),
    created_local_date: localDate(c.createdAt, timeZone),
    created_date_key: dateKey(localDate(c.createdAt, timeZone)),
    updated_at: isoSeconds(c.updatedAt),
    closed_at: isoSeconds(c.closedAt),
    closed_local_date: localDate(c.closedAt, timeZone),
    closed_date_key: dateKey(localDate(c.closedAt, timeZone)),
    archived_at: isoSeconds(c.archivedAt),
    minutes_to_close: minutes,
    age_days: ageDays,
    risk_score: num(c.riskScore),
    source: title(c.source),
    tags: Array.isArray(c.tags) && c.tags.length ? c.tags.join("|") : null,
    detections_count: num(c.detectionsCount),
    events_count: num(c.eventsCount),
    assets_count: num(c.assetsCount),
    api_version: "v2",
    exported_at: isoSeconds(now),
  };
}

/** A cases v1 record (REST, Classic). */
export interface LegacyCase {
  id: string;
  type?: string;
  name?: string;
  managedBy?: string;
  createdAt?: string;
  resolvedAt?: string;
  updatedAt?: string;
  severity?: string;
  status?: string;
  assignee?: { id?: string; name?: string };
  detectionCount?: number;
  verdict?: string;
  createdBy?: { type?: string; accountType?: string };
}

const LEGACY_SEVERITY: Record<string, number> = { critical: 10, high: 8, medium: 6, low: 4, informational: 2, notSet: 0 };
const LEGACY_TITLES: Record<string, string> = {
  new: "New",
  investigating: "Investigating",
  onHold: "On hold",
  resolved: "Resolved",
  actionRequired: "Action required",
  falsePositive: "False positive",
  truePositiveMalicious: "True positive, malicious",
  truePositiveBenign: "True positive, benign",
  truePositive: "True positive",
  inconclusive: "Inconclusive",
};

function legacyTitle(value: string | undefined): string | null {
  if (!value) return null;
  return LEGACY_TITLES[value] ?? value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^\w/, (m) => m.toUpperCase());
}

export function mapLegacyCase(c: LegacyCase, tenantId: string, timeZone: string, now: Date): Row {
  const closed = c.status === "resolved";
  const closedAt = closed ? c.resolvedAt : undefined;
  const { minutes, ageDays } = timing(c.createdAt, closedAt, now);
  const severity = c.severity ? (LEGACY_SEVERITY[c.severity] ?? 0) : 0;
  return {
    tenant_id: tenantId,
    case_id: c.id,
    short_id: c.id,
    title: c.name ?? null,
    severity,
    severity_label: severityLabel(severity),
    case_type_id: c.type ?? null,
    case_type: legacyTitle(c.type),
    primary_status_id: c.status ?? null,
    primary_status: legacyTitle(c.status),
    secondary_status: null,
    is_closed: closed,
    primary_verdict: legacyTitle(c.verdict),
    secondary_verdict: null,
    close_reason: null,
    managed_by: c.managedBy === "sophos" ? "PROVIDER" : c.managedBy === "self" ? "CUSTOMER" : null,
    created_by_mdr: c.managedBy === "sophos" ? true : null,
    created_by_partner: c.createdBy?.accountType === "partner" ? true : null,
    assignee_id: c.assignee?.id ?? null,
    created_at: isoSeconds(c.createdAt),
    created_local_date: localDate(c.createdAt, timeZone),
    created_date_key: dateKey(localDate(c.createdAt, timeZone)),
    updated_at: isoSeconds(c.updatedAt ?? c.createdAt),
    closed_at: isoSeconds(closedAt),
    closed_local_date: localDate(closedAt, timeZone),
    closed_date_key: dateKey(localDate(closedAt, timeZone)),
    archived_at: null,
    minutes_to_close: minutes,
    age_days: ageDays,
    risk_score: null,
    source: null,
    tags: null,
    detections_count: typeof c.detectionCount === "number" ? c.detectionCount : null,
    events_count: null,
    assets_count: null,
    api_version: "v1",
    exported_at: isoSeconds(now),
  };
}

interface ReferenceData {
  caseTypes?: { types?: Array<{ id: string; name: string; title?: string | null; managedBy?: string | null }> };
  casePrimaryStatuses?: { primaryStatuses?: Array<{ id: string; name: string; title?: string | null; isClosed?: boolean }> };
  caseSecondaryStatuses?: { secondaryStatuses?: Array<{ id: string; name: string; title?: string | null }> };
  casePrimaryVerdicts?: { primaryVerdicts?: Array<{ id: string; name: string; title?: string | null }> };
  caseSecondaryVerdicts?: { secondaryVerdicts?: Array<{ id: string; name: string; title?: string | null }> };
}

export function mapReferenceData(data: ReferenceData, tenantId: string): { types: Row[]; statuses: Row[]; verdicts: Row[] } {
  return {
    types: (data.caseTypes?.types ?? []).map((t) => ({ tenant_id: tenantId, case_type_id: t.id, name: t.name, title: t.title || t.name, managed_by: t.managedBy ?? null })),
    statuses: [
      ...(data.casePrimaryStatuses?.primaryStatuses ?? []).map((s) => ({ tenant_id: tenantId, status_id: s.id, level: "primary", name: s.name, title: s.title || s.name, is_closed: s.isClosed ?? null })),
      ...(data.caseSecondaryStatuses?.secondaryStatuses ?? []).map((s) => ({ tenant_id: tenantId, status_id: s.id, level: "secondary", name: s.name, title: s.title || s.name, is_closed: null })),
    ],
    verdicts: [
      ...(data.casePrimaryVerdicts?.primaryVerdicts ?? []).map((v) => ({ tenant_id: tenantId, verdict_id: v.id, level: "primary", name: v.name, title: v.title || v.name })),
      ...(data.caseSecondaryVerdicts?.secondaryVerdicts ?? []).map((v) => ({ tenant_id: tenantId, verdict_id: v.id, level: "secondary", name: v.name, title: v.title || v.name })),
    ],
  };
}

/** Reference lists for a Classic tenant, from the fixed cases v1 values. */
export function legacyReferenceData(tenantId: string): { types: Row[]; statuses: Row[]; verdicts: Row[] } {
  const types = ["investigation", "incident", "hunt", "activeThreat", "exposure", "healthCheck", "postureImprovement", "customerRequest", "duplicate", "managedRisk", "generalRequest"];
  const statuses = ["new", "investigating", "onHold", "resolved", "actionRequired"];
  const verdicts = ["falsePositive", "truePositiveMalicious", "truePositiveBenign", "truePositive", "inconclusive"];
  return {
    types: types.map((t) => ({ tenant_id: tenantId, case_type_id: t, name: t, title: legacyTitle(t), managed_by: null })),
    statuses: statuses.map((s) => ({ tenant_id: tenantId, status_id: s, level: "primary", name: s, title: legacyTitle(s), is_closed: s === "resolved" })),
    verdicts: verdicts.map((v) => ({ tenant_id: tenantId, verdict_id: v, level: "primary", name: v, title: legacyTitle(v) })),
  };
}

/** The QL filter for an incremental read, or "" for a full one. */
export function casesFilter(watermark: string | undefined, overlapMinutes: number): string {
  const at = toDate(watermark);
  if (!at) return "";
  const from = new Date(at.getTime() - overlapMinutes * 60_000);
  return `updatedAt >= '${from.toISOString().slice(0, 19)}Z'`;
}

interface CasesPage {
  cases: { totalCount: number; pageInfo: { endCursor: string | null; hasNextPage: boolean }; cases: FusionCase[] };
}

async function readFusionCases(ctx: RunContext, query: string): Promise<FusionCase[]> {
  const out: FusionCase[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const cursor: Record<string, unknown> = { first: CASES_PAGE_SIZE, ...(after ? { after } : {}) };
    const { data, warnings } = await ctx.session.graphql<CasesPage>(CASES_PAGE, { arguments: { query, pagination: { cursor } } });
    for (const w of warnings) ctx.warn(`Cases v2 partial response: ${w}`);
    out.push(...data.cases.cases);
    if (!data.cases.pageInfo.hasNextPage || !data.cases.pageInfo.endCursor || data.cases.cases.length === 0) return out;
    after = data.cases.pageInfo.endCursor;
  }
  ctx.warn(`Cases v2 stopped after ${MAX_PAGES} pages.`);
  return out;
}

async function readLegacyCases(ctx: RunContext): Promise<LegacyCase[]> {
  const out: LegacyCase[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await ctx.session.rest<{ items?: LegacyCase[]; pages?: { total?: number } }>("/cases/v1/cases", { page: String(page), pageSize: String(LEGACY_PAGE_SIZE) });
    out.push(...(body.items ?? []));
    if (!body.items?.length || page >= (body.pages?.total ?? 1)) return out;
  }
  ctx.warn(`Cases v1 stopped after ${MAX_PAGES} pages.`);
  return out;
}

export const casesDataset: Dataset = {
  name: "cases",
  description: "Cases and their reference lists (fact_case, dim_case_type, dim_case_status, dim_case_verdict).",
  async run(ctx: RunContext) {
    const { now, timeZone, mode, caseOverlapMinutes } = ctx.options;
    const marks = ctx.watermarks.get(ctx.tenantId);
    const query = mode === "backfill" ? "" : casesFilter(marks.casesUpdatedAt, caseOverlapMinutes);
    let rows: Row[];
    let reference: ReturnType<typeof mapReferenceData>;
    const notes: string[] = [];
    try {
      const cases = await readFusionCases(ctx, query);
      ctx.facts.platform = "fusion";
      const fusionTenant = cases.find((c) => c.tenantId)?.tenantId;
      if (fusionTenant) ctx.facts.fusionTenantId = fusionTenant;
      rows = cases.map((c) => mapFusionCase(c, ctx.tenantId, timeZone, now));
      const ref = await ctx.session.graphql<ReferenceData>(CASE_REFERENCE_DATA);
      for (const w of ref.warnings) ctx.warn(`Case reference data partial response: ${w}`);
      reference = mapReferenceData(ref.data, ctx.tenantId);
    } catch (error) {
      if (!isNotOnFusion(error)) throw error;
      ctx.facts.platform = "classic";
      try {
        rows = (await readLegacyCases(ctx)).map((c) => mapLegacyCase(c, ctx.tenantId, timeZone, now));
        reference = legacyReferenceData(ctx.tenantId);
        notes.push("The tenant is not on Sophos Fusion yet, so cases come from cases v1.");
      } catch (legacyError) {
        if (!isForbidden(legacyError)) throw legacyError;
        rows = [];
        reference = { types: [], statuses: [], verdicts: [] };
        notes.push("The tenant has no cases: Sophos refused both Cases v2 and cases v1 (no XDR or MDR licence).");
      }
    }

    store(ctx, "fact_case").upsert(rows);
    store(ctx, "dim_case_type").replace((r) => r.tenant_id === ctx.tenantId, reference.types);
    store(ctx, "dim_case_status").replace((r) => r.tenant_id === ctx.tenantId, reference.statuses);
    store(ctx, "dim_case_verdict").replace((r) => r.tenant_id === ctx.tenantId, reference.verdicts);

    // Cases v1 reads are full, so only a v2 read moves the watermark.
    if (ctx.facts.platform === "fusion") {
      const latest = rows.map((r) => String(r.updated_at ?? "")).filter(Boolean).sort().pop();
      const previous = marks.casesUpdatedAt ?? "";
      if (latest && latest > previous) ctx.watermarks.set(ctx.tenantId, { casesUpdatedAt: latest });
    }
    if (!rows.length && !notes.length) notes.push(query ? "No case changed since the last run." : "The tenant has no cases.");
    return {
      rows: { fact_case: rows.length, dim_case_type: reference.types.length, dim_case_status: reference.statuses.length, dim_case_verdict: reference.verdicts.length },
      notes,
    };
  },
};
