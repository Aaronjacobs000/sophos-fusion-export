/**
 * Sophos AI Defense, from the AI Defense Activity GraphQL API v1 and the AI
 * Defense Policy GraphQL API v1 (documented on developer.sophos.com since
 * 15/10/2026), on the same Sophos Fusion GraphQL endpoint as cases and
 * detections.
 *
 * Each run reads:
 *   - the AI Defense settings and Sophos's inventory totals (one request);
 *   - activity from local midnight aiDefense.trailingDays ago (a backfill from
 *     aiDefense.backfillDays ago, at most), because Sophos folds new telemetry
 *     into recent activities. Activities come 100 a request, so the backfill
 *     is shorter than the detections one. Rows inside the window are replaced,
 *     detail past aiDefense.retentionDays is pruned, and fact_ai_activity_daily
 *     keeps the counts;
 *   - the application and user inventories over aiDefense.inventoryDays, the
 *     sanctioning status of each application, and the policies, as today's
 *     snapshot.
 *
 * What the live endpoint did on 21/11/2026: activities answers at most 100 a
 * page whatever `first` asks for; an activity's action can be null and its
 * policyId an empty string; actor IDs can be a SID, an ID made from the
 * actor's name, or an IP address. A tenant without AI Defense answers with no
 * settings record and zero totals (NotFusion, 07/11/2026), and a tenant not on
 * Sophos Fusion with HTTP 503.
 *
 * User and device names and the raw actor ID are personal data: they are
 * written only with the personal data switch on. user_key, a hash of the
 * tenant and the actor ID, is always written so activity and users still join.
 */

import { createHash } from "node:crypto";
import { AI_ACTIVITIES, AI_APP_INVENTORY, AI_APP_SANCTIONING, AI_DEFENSE_OVERVIEW, AI_POLICIES, AI_USER_INVENTORY } from "../sophos/documents.js";
import { isForbidden, isNotOnFusion } from "../sophos/session.js";
import type { Row } from "../store/csv.js";
import { dateKey, isoSeconds, localDate, localDaysAgo, startOfLocalDay, toDate } from "../time.js";
import { store, type Dataset, type RunContext } from "./context.js";

/** The most activities one request returns (measured 21/11/2026; `first` above it is capped). */
export const AI_ACTIVITY_PAGE_SIZE = 100;
/** Inventory and policy pages. */
export const AI_INVENTORY_PAGE_SIZE = 100;
/** appSanctioning is sent this many application IDs at a time. */
export const AI_SANCTIONING_BATCH = 100;
const MAX_ACTIVITY_PAGES = 5000;
const MAX_APPS = 2000;
const MAX_USERS = 10_000;
const MAX_POLICY_PAGES = 20;
const DAY_MS = 86_400_000;

type Raw = Record<string, unknown>;

function record(value: unknown): Raw {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : {};
}

function list(value: unknown): Raw[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Int64 arrives as a number or as a string of digits. */
function int(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

const RISK_RANK: Readonly<Record<string, number>> = { CRITICAL: 5, HIGH: 4, MEDIUM: 3, LOW: 2, INFO: 1 };

export function riskRank(risk: unknown): number {
  return typeof risk === "string" ? (RISK_RANK[risk.toUpperCase()] ?? 0) : 0;
}

/** The pseudonymous key for an actor: SHA-256 of the tenant and the actor ID, 32 hex characters. */
export function userKey(tenantId: string, actorId: unknown): string | null {
  const id = text(actorId);
  return id ? createHash("sha256").update(`${tenantId}\u0001${id}`).digest("hex").slice(0, 32) : null;
}

const joined = (values: Array<string | null>): string | null => {
  const set = [...new Set(values.filter((v): v is string => !!v))].sort();
  return set.length ? set.join("|") : null;
};

// ---------------------------------------------------------------- mappers

export function mapAiActivity(raw: Raw, tenantId: string, timeZone: string, now: Date): Row {
  const time = record(raw.timestamp);
  const actor = record(raw.actor);
  const app = record(raw.application);
  const device = record(raw.device);
  const sensors = list(raw.sensors);
  const start = isoSeconds(time.startTime);
  const day = localDate(time.startTime, timeZone);
  const records = int(raw.aggregationCount);
  return {
    tenant_id: tenantId,
    activity_id: text(raw.id),
    start_time: start,
    end_time: isoSeconds(time.endTime) ?? start,
    start_local_date: day,
    start_date_key: dateKey(day),
    action: text(raw.action),
    risk: text(raw.risk),
    risk_rank: riskRank(raw.risk),
    application_id: text(app.id),
    application_name: text(app.name) ?? text(app.id),
    provider: text(record(raw.applicationProvider).name),
    model_provider: text(record(raw.modelProvider).name),
    model: text(record(raw.model).name),
    user_key: userKey(tenantId, actor.id),
    actor_type: text(actor.type),
    actor_id: text(actor.id),
    actor_name: text(actor.name),
    device_id: text(device.id),
    device_name: text(device.name),
    device_type: text(device.type),
    device_platform: text(device.platform),
    sensor_types: joined(sensors.map((s) => text(s.type))),
    sensors: joined(sensors.map((s) => text(s.name))),
    policy_id: text(raw.policyId),
    policy_name: text(raw.policy),
    unsanctioned: raw.isUnsanctioned === true,
    records: Math.max(1, records ?? 1),
    exported_at: isoSeconds(now),
  };
}

/** fact_ai_activity_daily rows for a set of activity rows. */
export function aiActivityDaily(rows: Iterable<Row>, tenantId: string): Row[] {
  const counts = new Map<string, Row>();
  for (const r of rows) {
    if (!r.start_local_date) continue;
    const key = [r.start_local_date, r.application_id ?? "", r.action ?? "", r.risk ?? ""].join("\u0001");
    const row = counts.get(key) ?? {
      tenant_id: tenantId,
      local_date: r.start_local_date,
      date_key: r.start_date_key,
      application_id: r.application_id ?? null,
      action: r.action ?? null,
      risk: r.risk ?? null,
      risk_rank: r.risk_rank,
      activities: 0,
      records: 0,
      unsanctioned_activities: 0,
      application_name: r.application_name ?? null,
    };
    row.activities = Number(row.activities) + 1;
    row.records = Number(row.records) + Number(r.records ?? 1);
    if (r.unsanctioned === true) row.unsanctioned_activities = Number(row.unsanctioned_activities) + 1;
    counts.set(key, row);
  }
  return [...counts.values()];
}

export interface Sanctioning {
  status: string;
  policies: string | null;
}

/** Status and matching policy names per application ID, from appSanctioning entries. */
export function sanctioningByApp(entries: readonly Raw[]): Map<string, Sanctioning> {
  const out = new Map<string, Sanctioning>();
  for (const e of entries) {
    const appId = text(e.appId);
    if (!appId) continue;
    const policies = joined(list(e.enforcementTargets).map((t) => text(record(t.matchedPolicy).name)));
    out.set(appId, { status: text(e.status) ?? "NOT_COVERED", policies });
  }
  return out;
}

export function mapAiApp(raw: Raw, tenantId: string, snapshotDate: string, windowDays: number, sanctioning: ReadonlyMap<string, Sanctioning>): Row {
  const id = text(raw.id);
  return {
    tenant_id: tenantId,
    snapshot_date: snapshotDate,
    application_id: id,
    application_name: text(raw.name) ?? id,
    provider: text(raw.provider),
    risk: text(raw.risk),
    risk_rank: riskRank(raw.risk),
    sanctioning_status: (id && sanctioning.get(id)?.status) || null,
    window_days: windowDays,
    activities: int(raw.usage) ?? 0,
    unique_users: int(raw.uniqueUsers) ?? 0,
    unsanctioned_activities: int(raw.unsanctionedCount) ?? 0,
    last_seen_at: isoSeconds(raw.lastSeen),
  };
}

export function mapAiUser(raw: Raw, tenantId: string, snapshotDate: string, windowDays: number): Row {
  return {
    tenant_id: tenantId,
    snapshot_date: snapshotDate,
    user_key: userKey(tenantId, raw.id),
    user_id: text(raw.id),
    user_name: text(raw.name),
    risk: text(raw.risk),
    risk_rank: riskRank(raw.risk),
    apps_used: int(raw.appsUsed) ?? 0,
    activities: int(raw.usage) ?? 0,
    policy_violations: int(raw.policyViolations) ?? 0,
    unsanctioned_activities: int(raw.unsanctionedCount) ?? 0,
    top_app_id: text(raw.topAppId),
    top_app_name: text(raw.topApp),
    first_seen_at: isoSeconds(raw.firstSeen),
    last_seen_at: isoSeconds(raw.lastSeen),
    window_days: windowDays,
  };
}

export function mapAiPolicy(raw: Raw, tenantId: string): Row {
  const rules = list(raw.rules);
  const ruleCount = (action: string) => rules.filter((r) => r.action === action).length;
  const base = record(raw.baseRule);
  const sensors = record(raw.sensors);
  const enabled = (name: string) => record(sensors[name]).enabled === true;
  return {
    tenant_id: tenantId,
    policy_id: text(raw.id),
    policy_name: text(raw.name),
    rank: int(raw.rank),
    state: text(raw.state),
    enforcement_status: text(raw.enforcementStatus),
    origin: text(raw.origin),
    kind: text(raw.kind),
    built_in_key: text(raw.builtInKey),
    rules: rules.length,
    block_rules: ruleCount("BLOCK"),
    warn_rules: ruleCount("WARN"),
    allow_rules: ruleCount("ALLOW"),
    generative_ai_category_action: text(base.generativeAiCategoryAction),
    app_control_category_action: text(base.appControlCategoryAction),
    endpoint_enabled: enabled("endpoint"),
    firewall_enabled: enabled("firewall"),
    dns_enabled: enabled("dns"),
    browser_enabled: enabled("browser"),
    created_at: isoSeconds(raw.createdAt),
    updated_at: isoSeconds(raw.updatedAt),
  };
}

export function mapAiDefenseSnapshot(settings: unknown, summary: unknown, tenantId: string, snapshotDate: string, windowDays: number): Row {
  const s = record(settings);
  const apps = record(record(summary).apps);
  const users = record(record(summary).users);
  const has = settings !== null && settings !== undefined;
  return {
    tenant_id: tenantId,
    snapshot_date: snapshotDate,
    license_state: has ? text(s.licenseState) : null,
    license_type: has ? text(s.licenseType) : null,
    license_expiry_date: has ? (isoSeconds(s.licenseExpiryDate)?.slice(0, 10) ?? null) : null,
    grace_period_ends_at: has ? isoSeconds(s.gracePeriodEndsAt) : null,
    renewal_pending: has ? s.renewalPending === true : null,
    onboarding_status: has ? text(record(s.onboarding).status) : null,
    license_refreshed_at: has ? isoSeconds(s.refreshedAt) : null,
    window_days: windowDays,
    apps: int(apps.totalApps) ?? 0,
    apps_critical: int(apps.criticalRisk) ?? 0,
    apps_high: int(apps.highRisk) ?? 0,
    apps_medium: int(apps.mediumRisk) ?? 0,
    apps_low: int(apps.lowRisk) ?? 0,
    apps_info: int(apps.infoRisk) ?? 0,
    apps_unknown: int(apps.unknownRisk) ?? 0,
    apps_error: int(apps.errorRisk) ?? 0,
    apps_train_on_data: int(apps.trainsOnData),
    apps_unsanctioned: int(apps.unsanctionedCount) ?? 0,
    users: int(users.totalUsers) ?? 0,
    users_critical: int(users.criticalRisk) ?? 0,
    users_high: int(users.highRisk) ?? 0,
    users_medium: int(users.mediumRisk) ?? 0,
    users_low: int(users.lowRisk) ?? 0,
    users_info: int(users.infoRisk) ?? 0,
    users_unknown: int(users.unknownRisk) ?? 0,
    users_with_violations: int(users.withViolations) ?? 0,
    users_unsanctioned: int(users.unsanctionedCount) ?? 0,
  };
}

/** One activity per ID, the last one read winning. */
export function uniqueActivities(list: readonly Raw[]): Raw[] {
  const byId = new Map<string, Raw>();
  for (const a of list) {
    const id = text(a.id);
    if (id) byId.set(id, a);
  }
  return [...byId.values()];
}

// ---------------------------------------------------------------- reads

const range = (from: Date, to: Date) => ({ startTime: from.toISOString(), endTime: to.toISOString() });

async function query<T extends object>(ctx: RunContext, document: string, variables: Record<string, unknown>): Promise<T> {
  const { data, warnings } = await ctx.session.graphql<T>(document, variables);
  for (const w of warnings) ctx.warn(`AI Defense partial response: ${w}`);
  return data;
}

export async function readAiActivities(ctx: RunContext, from: Date, to: Date): Promise<{ list: Raw[]; expected: number }> {
  const out: Raw[] = [];
  let after: string | null = null;
  let expected = 0;
  for (let page = 0; page < MAX_ACTIVITY_PAGES; page++) {
    const data: Raw = await query<Raw>(ctx, AI_ACTIVITIES, { filter: { timeRange: range(from, to) }, first: AI_ACTIVITY_PAGE_SIZE, ...(after ? { after } : {}) });
    const connection = record(data.activities);
    if (page === 0) expected = int(connection.totalCount) ?? 0;
    const activities = list(connection.activities);
    out.push(...activities);
    const info = record(connection.pageInfo);
    after = info.hasNextPage === true ? text(info.endCursor) : null;
    if (!after || activities.length === 0) break;
    if (page === MAX_ACTIVITY_PAGES - 1) ctx.warn(`Stopped reading AI Defense activity after ${MAX_ACTIVITY_PAGES} pages.`);
  }
  return { list: out, expected };
}

async function readOffsetPages(ctx: RunContext, document: string, field: string, filter: Raw, max: number, what: string): Promise<Raw[]> {
  const out: Raw[] = [];
  for (let offset = 0; out.length < max; ) {
    const data = await query<Raw>(ctx, document, { filter, limit: AI_INVENTORY_PAGE_SIZE, offset });
    const page = record(data[field]);
    const entries = list(page.entries);
    out.push(...entries);
    if (page.hasNextPage !== true || entries.length === 0) return out;
    offset = (int(page.offset) ?? offset) + entries.length;
  }
  ctx.warn(`The ${what} inventory holds more than ${max} entries; the first ${max} were read.`);
  return out.slice(0, max);
}

async function readSanctioning(ctx: RunContext, appIds: readonly string[]): Promise<Map<string, Sanctioning>> {
  const entries: Raw[] = [];
  for (let start = 0; start < appIds.length; start += AI_SANCTIONING_BATCH) {
    const data = await query<Raw>(ctx, AI_APP_SANCTIONING, { appIds: appIds.slice(start, start + AI_SANCTIONING_BATCH) });
    entries.push(...list(record(data.appSanctioning).entries));
  }
  return sanctioningByApp(entries);
}

async function readPolicies(ctx: RunContext): Promise<Raw[]> {
  const out: Raw[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_POLICY_PAGES; page++) {
    const data: Raw = await query<Raw>(ctx, AI_POLICIES, { first: AI_INVENTORY_PAGE_SIZE, ...(after ? { after } : {}) });
    const connection = record(data.policies);
    out.push(...list(connection.policies));
    const info = record(connection.pageInfo);
    after = info.hasNextPage === true ? text(info.endCursor) : null;
    if (!after) break;
  }
  return out;
}

/** The first local day of the activity window this run reads. */
export function activityWindowStart(ctx: RunContext): string {
  const { now, timeZone, mode, backfillDays, aiDefense } = ctx.options;
  if (mode === "backfill") return localDaysAgo(now, Math.min(backfillDays, aiDefense.backfillDays), timeZone);
  const cap = localDaysAgo(now, aiDefense.backfillDays, timeZone);
  let day = localDaysAgo(now, aiDefense.trailingDays, timeZone);
  // A run after a gap (the machine was off) reads from the day of the last full read, up to the backfill cap.
  const readTo = localDate(ctx.watermarks.get(ctx.tenantId).aiActivitiesReadTo, timeZone);
  if (readTo && readTo < day) day = readTo;
  return day < cap ? cap : day;
}

export const aiDefenseDataset: Dataset = {
  name: "aiDefense",
  description: "Sophos AI Defense: activity, daily counts, applications with their sanctioning status, users and policies.",
  async run(ctx: RunContext) {
    const { now, timeZone, mode, aiDefense } = ctx.options;
    const tenantId = ctx.tenantId;
    const snapshotDate = localDate(now, timeZone)!;
    const windowDays = aiDefense.inventoryDays;
    const inventoryRange = range(new Date(now.getTime() - windowDays * DAY_MS), now);
    const tables = ["fact_ai_defense_snapshot", "fact_ai_activity", "fact_ai_activity_daily", "dim_ai_app", "fact_ai_app_snapshot", "fact_ai_user_snapshot", "dim_ai_policy"];
    const none = (note: string) => ({ rows: Object.fromEntries(tables.map((t) => [t, 0])), notes: [note] });

    let overview: Raw;
    try {
      overview = await query<Raw>(ctx, AI_DEFENSE_OVERVIEW, { summary: { timeRange: inventoryRange } });
    } catch (error) {
      if (isNotOnFusion(error)) return none("The tenant is not on Sophos Fusion, so there is no AI Defense data.");
      if (isForbidden(error)) {
        ctx.warn("Sophos refused the AI Defense APIs for this credential, so the AI Defense tables were not updated. Give the credential a role that can read AI Defense, or leave aiDefense out of datasets.");
        return none("Sophos refused the AI Defense APIs for this credential.");
      }
      throw error;
    }
    const settings = overview.secureAITenantSettings ?? null;
    const snapshot = mapAiDefenseSnapshot(settings, overview.inventorySummary, tenantId, snapshotDate, windowDays);
    const ofTenant = (r: Row) => r.tenant_id === tenantId;
    const onSnapshot = (r: Row) => r.tenant_id === tenantId && r.snapshot_date === snapshotDate;
    store(ctx, "fact_ai_defense_snapshot").replace(onSnapshot, [snapshot]);

    if (!settings && Number(snapshot.apps) === 0 && Number(snapshot.users) === 0) {
      store(ctx, "dim_ai_policy").remove(ofTenant);
      store(ctx, "fact_ai_app_snapshot").remove(onSnapshot);
      store(ctx, "fact_ai_user_snapshot").remove(onSnapshot);
      const result = none("No AI Defense on this tenant: Sophos holds no AI Defense settings and no AI activity.");
      result.rows.fact_ai_defense_snapshot = 1;
      return result;
    }

    // Activity, read again inside the window.
    const firstDay = activityWindowStart(ctx);
    const from = startOfLocalDay(firstDay, timeZone);
    const fromIso = isoSeconds(from)!;
    const { list: read, expected } = await readAiActivities(ctx, from, now);
    const activities = uniqueActivities(read);
    if (Math.abs(activities.length - expected) > Math.max(10, expected * 0.01)) {
      ctx.warn(`AI Defense said ${expected} activities in the window; the pages returned ${activities.length}.`);
    }
    ctx.log(`  ${activities.length} AI Defense activities read (Sophos said ${expected}).`);
    const rows = activities.map((a) => mapAiActivity(a, tenantId, timeZone, now)).filter((r) => r.activity_id && String(r.start_time ?? "") >= fromIso);

    const facts = store(ctx, "fact_ai_activity");
    const windowIds = new Set<string>();
    for (const r of facts.all()) if (r.tenant_id === tenantId && String(r.start_time ?? "") >= fromIso) windowIds.add(String(r.activity_id));
    for (const r of rows) windowIds.add(String(r.activity_id));
    facts.replace((r) => r.tenant_id === tenantId && windowIds.has(String(r.activity_id)), rows);
    const daily = aiActivityDaily(rows, tenantId);
    store(ctx, "fact_ai_activity_daily").replace((r) => r.tenant_id === tenantId && String(r.local_date ?? "") >= firstDay, daily);

    const keepFrom = localDaysAgo(now, aiDefense.retentionDays, timeZone);
    const pruned = facts.remove((r) => r.tenant_id === tenantId && !!r.start_local_date && String(r.start_local_date) < keepFrom);
    if (pruned) ctx.log(`Pruned ${pruned} AI Defense activities older than ${keepFrom} (counts stay in fact_ai_activity_daily).`);

    // Inventories, sanctioning and policies: today's snapshot.
    const apps = await readOffsetPages(ctx, AI_APP_INVENTORY, "appInventory", { timeRange: inventoryRange }, MAX_APPS, "AI application");
    const users = await readOffsetPages(ctx, AI_USER_INVENTORY, "userInventory", { timeRange: inventoryRange }, MAX_USERS, "AI user");
    const appIds = [...new Set([...apps.map((a) => text(a.id)), ...rows.map((r) => (r.application_id ? String(r.application_id) : null))].filter((id): id is string => !!id))].sort();
    const sanctioning = await readSanctioning(ctx, appIds);
    const policies = (await readPolicies(ctx)).map((p) => mapAiPolicy(p, tenantId)).filter((p) => p.policy_id);

    const appRows = apps.map((a) => mapAiApp(a, tenantId, snapshotDate, windowDays, sanctioning)).filter((r) => r.application_id);
    store(ctx, "fact_ai_app_snapshot").replace(onSnapshot, appRows);
    const userRows = users.map((u) => mapAiUser(u, tenantId, snapshotDate, windowDays)).filter((r) => r.user_key);
    store(ctx, "fact_ai_user_snapshot").replace(onSnapshot, userRows);
    store(ctx, "dim_ai_policy").replace(ofTenant, policies);

    // dim_ai_app: every application seen in the inventory or in activity, merged with what earlier runs knew.
    const dim = store(ctx, "dim_ai_app");
    const known = new Map(dim.all().filter(ofTenant).map((r) => [String(r.application_id), r]));
    const latest = (a: unknown, b: unknown) => {
      const x = toDate(a);
      const y = toDate(b);
      return isoSeconds(!x ? y : !y ? x : x > y ? x : y);
    };
    const merged = new Map<string, Row>();
    const touch = (id: string, patch: Row) => {
      const prior = merged.get(id) ?? known.get(id) ?? { tenant_id: tenantId, application_id: id };
      const next: Row = { ...prior };
      for (const [k, v] of Object.entries(patch)) if (v !== null && v !== undefined && v !== "") next[k] = v;
      next.last_seen_at = latest(prior.last_seen_at, patch.last_seen_at);
      merged.set(id, next);
    };
    for (const r of rows) touch(String(r.application_id), { application_name: r.application_name, provider: r.provider, last_seen_at: r.start_time });
    for (const a of appRows) touch(String(a.application_id), { application_name: a.application_name, provider: a.provider, risk: a.risk, risk_rank: a.risk_rank, last_seen_at: a.last_seen_at });
    for (const id of appIds) {
      const s = sanctioning.get(id);
      if (s) touch(id, { sanctioning_status: s.status, sanctioning_policies: s.policies });
    }
    const dimRows = [...merged.values()].map((r) => ({
      tenant_id: tenantId,
      application_id: r.application_id,
      application_name: r.application_name ?? r.application_id,
      provider: r.provider ?? null,
      risk: r.risk ?? null,
      risk_rank: r.risk ? riskRank(r.risk) : null,
      sanctioning_status: r.sanctioning_status ?? null,
      sanctioning_policies: r.sanctioning_policies ?? null,
      last_seen_at: r.last_seen_at ?? null,
      updated_at: isoSeconds(now),
    }));
    dim.upsert(dimRows);

    ctx.watermarks.set(tenantId, {
      aiActivitiesWindowStart: fromIso,
      aiActivitiesReadTo: isoSeconds(now)!,
      ...(mode === "backfill" ? { aiBackfilledFrom: firstDay } : {}),
    });
    return {
      rows: {
        fact_ai_defense_snapshot: 1,
        fact_ai_activity: rows.length,
        fact_ai_activity_daily: daily.length,
        dim_ai_app: dimRows.length,
        fact_ai_app_snapshot: appRows.length,
        fact_ai_user_snapshot: userRows.length,
        dim_ai_policy: policies.length,
      },
      notes: [
        ...(settings ? [] : ["Sophos holds no AI Defense settings record for this tenant, but it reported AI activity."]),
        ...(rows.length ? [] : [`No AI Defense activity from ${firstDay}.`]),
      ],
    };
  },
};
