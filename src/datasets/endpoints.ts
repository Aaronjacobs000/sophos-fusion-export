/**
 * Endpoint health and coverage (Endpoint API, GET /endpoint/v1/endpoints,
 * documented): every endpoint, once a day, so history exists only because the
 * exporter keeps the snapshots. Plus the Account Health Check scores
 * (GET /account-health-check/v1/health-check, documented).
 */

import type { Row } from "../store/csv.js";
import { daysBetween, isoSeconds, localDate, toDate } from "../time.js";
import { store, type Dataset, type RunContext } from "./context.js";

export const ENDPOINT_PAGE_SIZE = 500;
const MAX_PAGES = 400;

export interface RawEndpoint {
  id: string;
  type?: string;
  hostname?: string;
  health?: { overall?: string; threats?: { status?: string }; services?: { status?: string } };
  os?: { platform?: string; name?: string; majorVersion?: number; minorVersion?: number; build?: number };
  ipv4Addresses?: string[];
  associatedPerson?: { name?: string; viaLogin?: string };
  tamperProtectionEnabled?: boolean;
  tamperProtectionSupported?: boolean;
  assignedProducts?: Array<{ code?: string; version?: string; status?: string }>;
  lastSeenAt?: string;
  online?: boolean;
  mdrManaged?: boolean;
  group?: { name?: string };
  groupName?: string;
  isolation?: { status?: string };
  lockdown?: { status?: string };
  packages?: { protection?: { name?: string; assignedId?: string } };
}

function trimmed(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function mapEndpoint(e: RawEndpoint, tenantId: string, snapshotDate: string, now: Date): Row {
  const lastSeen = toDate(e.lastSeenAt);
  const os = e.os ?? {};
  const build = [os.majorVersion, os.minorVersion, os.build].filter((v) => typeof v === "number").join(".");
  const installed = (e.assignedProducts ?? []).filter((p) => p.code && p.status === "installed");
  const core = (e.assignedProducts ?? []).find((p) => p.code === "coreAgent");
  return {
    tenant_id: tenantId,
    snapshot_date: snapshotDate,
    endpoint_id: e.id,
    endpoint_type: e.type ?? null,
    hostname: trimmed(e.hostname),
    os_platform: os.platform ?? null,
    os_name: trimmed(os.name),
    os_build: build || null,
    health_overall: e.health?.overall ?? null,
    health_threats: e.health?.threats?.status ?? null,
    health_services: e.health?.services?.status ?? null,
    last_seen_at: isoSeconds(e.lastSeenAt),
    days_since_seen: lastSeen ? Math.max(0, daysBetween(lastSeen, now)) : null,
    online: typeof e.online === "boolean" ? e.online : null,
    tamper_protection_enabled: typeof e.tamperProtectionEnabled === "boolean" ? e.tamperProtectionEnabled : null,
    tamper_protection_supported: typeof e.tamperProtectionSupported === "boolean" ? e.tamperProtectionSupported : null,
    isolation_status: e.isolation?.status ?? null,
    lockdown_status: e.lockdown?.status ?? null,
    group_name: trimmed(e.group?.name) ?? trimmed(e.groupName),
    mdr_managed: typeof e.mdrManaged === "boolean" ? e.mdrManaged : null,
    protection_package: trimmed(e.packages?.protection?.name) ?? trimmed(e.packages?.protection?.assignedId),
    core_agent_version: trimmed(core?.version),
    products: installed.length ? installed.map((p) => p.code).sort().join("|") : null,
    ipv4_addresses: e.ipv4Addresses?.length ? e.ipv4Addresses.join("|") : null,
    associated_person: trimmed(e.associatedPerson?.viaLogin) ?? trimmed(e.associatedPerson?.name),
  };
}

const ISSUE_FIELDS = ["notFullyProtected", "notOnRecommended", "numberOfSecurityRisks", "disabled"] as const;

/**
 * One row per scored check in an Account Health Check answer: every object
 * under `endpoint` that carries a numeric score, named by its path.
 */
export function flattenHealthCheck(body: unknown, tenantId: string, snapshotDate: string): Row[] {
  const rows: Row[] = [];
  const root = body && typeof body === "object" ? (body as Record<string, unknown>).endpoint : null;
  const walk = (node: unknown, path: string[]) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    const obj = node as Record<string, unknown>;
    if (typeof obj.score === "number" && path.length >= 2) {
      const issue = ISSUE_FIELDS.map((f) => obj[f]).find((v) => typeof v === "number");
      rows.push({
        tenant_id: tenantId,
        snapshot_date: snapshotDate,
        area: path[0]!,
        scope: path.slice(1).join(".") || path[0]!,
        score: obj.score,
        total: typeof obj.total === "number" ? obj.total : null,
        issue_count: typeof issue === "number" ? issue : null,
        snoozed: typeof obj.snoozed === "boolean" ? obj.snoozed : null,
      });
    }
    for (const [key, value] of Object.entries(obj)) {
      if (key === "snoozeDetail" || Array.isArray(value)) continue;
      walk(value, [...path, key]);
    }
  };
  if (root && typeof root === "object") for (const [area, value] of Object.entries(root)) walk(value, [area]);
  return rows;
}

interface EndpointPage {
  items?: RawEndpoint[];
  pages?: { nextKey?: string };
}

export const endpointsDataset: Dataset = {
  name: "endpoints",
  description: "Endpoint health snapshot and Account Health Check scores.",
  async run(ctx: RunContext) {
    const { now, timeZone } = ctx.options;
    const snapshotDate = localDate(now, timeZone)!;
    const endpoints: RawEndpoint[] = [];
    let fromKey: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await ctx.session.rest<EndpointPage>("/endpoint/v1/endpoints", {
        pageSize: String(ENDPOINT_PAGE_SIZE),
        ...(fromKey ? { pageFromKey: fromKey } : {}),
      });
      endpoints.push(...(body.items ?? []));
      fromKey = body.pages?.nextKey;
      if (!fromKey || !body.items?.length) break;
    }
    const rows = endpoints.map((e) => mapEndpoint(e, ctx.tenantId, snapshotDate, now));
    store(ctx, "fact_endpoint_snapshot").replace((r) => r.tenant_id === ctx.tenantId && r.snapshot_date === snapshotDate, rows);

    const health = flattenHealthCheck(await ctx.session.rest<unknown>("/account-health-check/v1/health-check"), ctx.tenantId, snapshotDate);
    store(ctx, "fact_health_check_snapshot").replace((r) => r.tenant_id === ctx.tenantId && r.snapshot_date === snapshotDate, health);
    return {
      rows: { fact_endpoint_snapshot: rows.length, fact_health_check_snapshot: health.length },
      notes: [...(rows.length ? [] : ["The tenant has no endpoints."]), ...(health.length ? [] : ["The Account Health Check returned no scores."])],
    };
  },
};
