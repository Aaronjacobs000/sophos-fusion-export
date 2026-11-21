/**
 * Detections (Sophos Fusion Detections GraphQL v2, documented). One
 * detectionSearch call returns at most 10,000 detections, and offset paging
 * past 10,000 hands back the same rows again (measured on a live tenant,
 * 21/11/2026), so the window is cut into time slices: detectionCountByTenant
 * counts a slice, a slice over the limit is halved, and each slice small
 * enough is read in one search. Results are de-duplicated on detection ID,
 * since a detection on a slice boundary can come back twice.
 *
 * Every run reads the window again from local midnight detectionTrailingDays
 * ago (a backfill from backfillDays ago), because a detection's status changes
 * after creation. Rows inside the window are replaced, rows before it are
 * settled and stay, and detail older than detectionRetentionDays is pruned
 * while fact_detection_daily keeps the counts.
 */

import { DETECTION_COUNT, DETECTION_SEARCH } from "../sophos/documents.js";
import type { Row } from "../store/csv.js";
import { dateKey, isoSeconds, localDate, localDaysAgo, startOfLocalDay } from "../time.js";
import { store, type Dataset, type RunContext } from "./context.js";
import { sensorLabel } from "./sensor-labels.js";

/** The most detections one detectionSearch call returns. */
export const SEARCH_LIMIT = 10_000;
/** A stop for runaway splitting: slices shorter than this are read as they are. */
const MIN_SLICE_MS = 60_000;
const MAX_DEPTH = 24;

export interface FusionDetection {
  id: string;
  status?: string | null;
  resolution_reason?: string | null;
  attack_technique_ids?: string[] | null;
  sensor_types?: string[] | null;
  threat_score?: number | null;
  metadata?: {
    title?: string | null;
    description?: string | null;
    severity?: number | null;
    confidence?: number | null;
    created_at?: { seconds?: number | null } | null;
    first_seen_at?: { seconds?: number | null } | null;
    creator?: { detector?: { detector_id?: string | null; detector_name?: string | null } | null } | null;
  } | null;
  enrichment_details?: Array<{ mitre_attack_info?: { technique_id?: string | null; technique?: string | null; tactics?: string[] | null } | null }> | null;
  investigation_ids?: Array<{ id: string }> | null;
  source_entities?: Array<{ display_name?: string | null; subtype?: string | null }> | null;
  target_entities?: Array<{ display_name?: string | null; subtype?: string | null }> | null;
}

export const SEVERITY_BANDS = [
  { band: "Critical", rank: 5, min: 0.8 },
  { band: "High", rank: 4, min: 0.6 },
  { band: "Medium", rank: 3, min: 0.4 },
  { band: "Low", rank: 2, min: 0.2 },
  { band: "Info", rank: 1, min: -Infinity },
] as const;

export function severityBand(severity: number | null | undefined): { band: string; rank: number } {
  const s = typeof severity === "number" && Number.isFinite(severity) ? severity : 0;
  const found = SEVERITY_BANDS.find((b) => s >= b.min)!;
  return { band: found.band, rank: found.rank };
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export interface MappedDetection {
  detection: Row;
  techniques: Row[];
  sensors: Row[];
  entities: Row[];
  detector: Row | null;
  mitre: Array<{ techniqueId: string; name: string | null; tactics: string[] }>;
}

export function mapDetection(d: FusionDetection, tenantId: string, timeZone: string, now: Date): MappedDetection {
  const meta = d.metadata ?? {};
  const createdSeconds = finite(meta.created_at?.seconds);
  const firstSeen = finite(meta.first_seen_at?.seconds);
  const { band, rank } = severityBand(meta.severity);
  const detectorId = meta.creator?.detector?.detector_id ?? null;

  // Techniques with their tactics: enrichment gives tactics; attack_technique_ids may add bare IDs.
  const byTechnique = new Map<string, { name: string | null; tactics: Set<string> }>();
  for (const e of d.enrichment_details ?? []) {
    const info = e?.mitre_attack_info;
    if (!info?.technique_id) continue;
    const entry = byTechnique.get(info.technique_id) ?? { name: null, tactics: new Set<string>() };
    if (info.technique && !entry.name) entry.name = info.technique;
    for (const t of info.tactics ?? []) if (t) entry.tactics.add(t);
    byTechnique.set(info.technique_id, entry);
  }
  for (const id of d.attack_technique_ids ?? []) if (id && !byTechnique.has(id)) byTechnique.set(id, { name: null, tactics: new Set() });

  const techniques: Row[] = [];
  for (const [techniqueId, entry] of byTechnique) {
    const tactics = entry.tactics.size ? [...entry.tactics].sort() : [""];
    for (const tactic of tactics) techniques.push({ tenant_id: tenantId, detection_id: d.id, technique_id: techniqueId, tactic });
  }
  const sensorTypes = [...new Set((d.sensor_types ?? []).filter(Boolean))].sort();
  const caseIds = [...new Set((d.investigation_ids ?? []).map((i) => i?.id).filter(Boolean))].sort();
  const entities: Row[] = [];
  const seen = new Set<string>();
  for (const [role, list] of [["source", d.source_entities], ["target", d.target_entities]] as const) {
    for (const e of list ?? []) {
      if (!e?.display_name) continue;
      const key = `${role}\u0001${e.subtype ?? ""}\u0001${e.display_name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entities.push({ tenant_id: tenantId, detection_id: d.id, role, subtype: e.subtype ?? null, display_name: e.display_name });
    }
  }

  return {
    detection: {
      tenant_id: tenantId,
      detection_id: d.id,
      created_at: createdSeconds === null ? null : isoSeconds(createdSeconds),
      created_local_date: createdSeconds === null ? null : localDate(createdSeconds, timeZone),
      created_date_key: createdSeconds === null ? null : dateKey(localDate(createdSeconds, timeZone)),
      first_seen_at: firstSeen === null ? null : isoSeconds(firstSeen),
      severity: finite(meta.severity),
      severity_band: band,
      severity_rank: rank,
      confidence: finite(meta.confidence),
      threat_score: finite(d.threat_score),
      status: d.status ?? null,
      resolution_reason: d.resolution_reason || null,
      detector_id: detectorId,
      title: meta.title ?? null,
      description: meta.description ?? null,
      technique_count: byTechnique.size,
      sensor_count: sensorTypes.length,
      case_count: caseIds.length,
      case_ids: caseIds.length ? caseIds.join("|") : null,
      exported_at: isoSeconds(now),
    },
    techniques,
    sensors: sensorTypes.map((s) => ({ tenant_id: tenantId, detection_id: d.id, sensor_type: s })),
    entities,
    detector: detectorId ? { tenant_id: tenantId, detector_id: detectorId, detector_name: meta.creator?.detector?.detector_name ?? detectorId } : null,
    mitre: [...byTechnique].map(([techniqueId, e]) => ({ techniqueId, name: e.name, tactics: [...e.tactics].sort() })),
  };
}

/** fact_detection_daily rows for a set of detection rows. */
export function dailyCounts(rows: Iterable<Row>, tenantId: string): Row[] {
  const counts = new Map<string, Row>();
  for (const r of rows) {
    if (!r.created_local_date) continue;
    const detector = String(r.detector_id ?? "");
    const key = `${r.created_local_date}\u0001${r.severity_band}\u0001${detector}`;
    const row = counts.get(key) ?? {
      tenant_id: tenantId,
      local_date: r.created_local_date,
      date_key: r.created_date_key,
      severity_band: r.severity_band,
      severity_rank: r.severity_rank,
      detector_id: detector || null,
      detections: 0,
      open_detections: 0,
    };
    row.detections = Number(row.detections) + 1;
    if (r.status === "OPEN") row.open_detections = Number(row.open_detections) + 1;
    counts.set(key, row);
  }
  return [...counts.values()];
}

/** fact_technique_daily and fact_sensor_daily rows for a set of mapped detections. */
export function breakdownCounts(mapped: readonly MappedDetection[], tenantId: string): { techniques: Row[]; sensors: Row[] } {
  const techniques = new Map<string, Row>();
  const sensors = new Map<string, Row>();
  for (const m of mapped) {
    const day = m.detection.created_local_date;
    if (!day) continue;
    for (const t of m.techniques) {
      const key = `${day}\u0001${t.technique_id}\u0001${t.tactic}`;
      const row = techniques.get(key) ?? { tenant_id: tenantId, local_date: day, date_key: m.detection.created_date_key, technique_id: t.technique_id, tactic: t.tactic, detections: 0 };
      row.detections = Number(row.detections) + 1;
      techniques.set(key, row);
    }
    for (const s of m.sensors) {
      const key = `${day}\u0001${s.sensor_type}`;
      const row = sensors.get(key) ?? { tenant_id: tenantId, local_date: day, date_key: m.detection.created_date_key, sensor_type: s.sensor_type, detections: 0 };
      row.detections = Number(row.detections) + 1;
      sensors.set(key, row);
    }
  }
  return { techniques: [...techniques.values()], sensors: [...sensors.values()] };
}

/** The QL for a window. Absolute times in quotes, UTC. */
export function detectionQuery(from: Date, to: Date): string {
  const iso = (d: Date) => `${d.toISOString().slice(0, 19)}Z`;
  return `FROM alert WHERE severity >= 0 EARLIEST='${iso(from)}' LATEST='${iso(to)}'`;
}

interface SearchResponse {
  detectionSearch: {
    status?: string;
    reason?: string;
    alerts?: { total_results?: number | null; next_offset?: number | null; list?: FusionDetection[] | null } | null;
  } | null;
}

interface CountResponse {
  detectionCountByTenant: { items?: Array<{ count: number; tenant?: { id?: string } }> | null } | null;
}

async function countDetections(ctx: RunContext, from: Date, to: Date): Promise<number> {
  const { data } = await ctx.session.graphql<CountResponse>(DETECTION_COUNT, { in: { ql_query: detectionQuery(from, to) } });
  return (data.detectionCountByTenant?.items ?? []).reduce((sum, i) => sum + (i.count ?? 0), 0);
}

async function searchSlice(ctx: RunContext, from: Date, to: Date, limit: number): Promise<FusionDetection[]> {
  const { data, warnings } = await ctx.session.graphql<SearchResponse>(DETECTION_SEARCH, { in: { cql_query: detectionQuery(from, to), limit, offset: 0 } });
  for (const w of warnings) ctx.warn(`Detection search partial response: ${w}`);
  const result = data.detectionSearch;
  if (result?.status && result.status !== "OK") throw new Error(`Detection search answered ${result.status}: ${result.reason ?? "no reason given"}`);
  return result?.alerts?.list ?? [];
}

/**
 * Every detection created in [from, to], one search per slice of at most
 * `limit` detections. `known` is the slice's count when the caller has it.
 */
export async function readDetections(ctx: RunContext, from: Date, to: Date, limit: number, known?: number, depth = 0): Promise<FusionDetection[]> {
  const count = known ?? (await countDetections(ctx, from, to));
  if (count === 0) return [];
  const span = to.getTime() - from.getTime();
  if (count <= limit || span <= MIN_SLICE_MS || depth >= MAX_DEPTH) {
    if (count > limit) ctx.warn(`${count} detections between ${isoSeconds(from)} and ${isoSeconds(to)}, more than one search returns; the first ${limit} were read.`);
    return searchSlice(ctx, from, to, Math.min(SEARCH_LIMIT, Math.max(limit, count)));
  }
  const mid = new Date(Math.floor((from.getTime() + span / 2) / 1000) * 1000);
  const left = await readDetections(ctx, from, mid, limit, undefined, depth + 1);
  const right = await readDetections(ctx, mid, to, limit, undefined, depth + 1);
  return [...left, ...right];
}

/** One detection per ID, the last one read winning. */
export function uniqueDetections(list: readonly FusionDetection[]): FusionDetection[] {
  const byId = new Map<string, FusionDetection>();
  for (const d of list) if (d?.id) byId.set(d.id, d);
  return [...byId.values()];
}

export const detectionsDataset: Dataset = {
  name: "detections",
  description: "Detections with MITRE ATT&CK, sensors and daily counts.",
  async run(ctx: RunContext) {
    const { now, timeZone, mode, backfillDays, detectionTrailingDays, detectionRetentionDays, personalData } = ctx.options;
    const days = mode === "backfill" ? backfillDays : detectionTrailingDays;
    const firstDay = localDaysAgo(now, days, timeZone);
    const from = startOfLocalDay(firstDay, timeZone);
    const fromIso = isoSeconds(from)!;
    const limit = Math.min(SEARCH_LIMIT, ctx.options.detectionPageSize);

    const expected = await countDetections(ctx, from, now);
    const list = uniqueDetections(await readDetections(ctx, from, now, limit, expected));
    // New detections keep arriving while the run reads, so a small gap is normal; a large one is not.
    if (Math.abs(list.length - expected) > Math.max(10, expected * 0.01)) {
      ctx.warn(`detectionCountByTenant said ${expected} detections in the window; the searches returned ${list.length}.`);
    }
    ctx.log(`  ${list.length} detections read (count said ${expected}).`);

    const mapped = list.map((d) => mapDetection(d, ctx.tenantId, timeZone, now));
    // Detections Sophos hands back from before the window (a clock edge) are kept out of it.
    const inWindow = mapped.filter((m) => String(m.detection.created_at ?? "") >= fromIso);

    const facts = store(ctx, "fact_detection");
    const windowIds = new Set<string>();
    for (const r of facts.all()) if (r.tenant_id === ctx.tenantId && String(r.created_at ?? "") >= fromIso) windowIds.add(String(r.detection_id));
    for (const m of inWindow) windowIds.add(String(m.detection.detection_id));
    const inIds = (r: Row) => r.tenant_id === ctx.tenantId && windowIds.has(String(r.detection_id));

    facts.replace(inIds, inWindow.map((m) => m.detection));
    store(ctx, "bridge_detection_technique").replace(inIds, inWindow.flatMap((m) => m.techniques));
    store(ctx, "bridge_detection_sensor").replace(inIds, inWindow.flatMap((m) => m.sensors));
    store(ctx, "bridge_detection_entity").replace(inIds, personalData ? inWindow.flatMap((m) => m.entities) : []);

    const daily = dailyCounts(inWindow.map((m) => m.detection), ctx.tenantId);
    const inDays = (r: Row) => r.tenant_id === ctx.tenantId && String(r.local_date ?? "") >= firstDay;
    store(ctx, "fact_detection_daily").replace(inDays, daily);
    const breakdown = breakdownCounts(inWindow, ctx.tenantId);
    store(ctx, "fact_technique_daily").replace(inDays, breakdown.techniques);
    store(ctx, "fact_sensor_daily").replace(inDays, breakdown.sensors);

    const detectors = new Map<string, Row>();
    for (const m of inWindow) if (m.detector) detectors.set(String(m.detector.detector_id), m.detector);
    store(ctx, "dim_detector").upsert(detectors.values());

    const techniqueStore = store(ctx, "dim_mitre_technique");
    const existing = new Map(techniqueStore.all().filter((r) => r.tenant_id === ctx.tenantId).map((r) => [String(r.technique_id), r]));
    const techniques = new Map<string, Row>();
    for (const m of inWindow) {
      for (const t of m.mitre) {
        const prior = techniques.get(t.techniqueId) ?? existing.get(t.techniqueId);
        const tactics = new Set([...String(prior?.tactics ?? "").split("|").filter(Boolean), ...t.tactics]);
        techniques.set(t.techniqueId, {
          tenant_id: ctx.tenantId,
          technique_id: t.techniqueId,
          technique_name: t.name || (prior?.technique_name ? String(prior.technique_name) : null),
          tactics: [...tactics].sort().join("|") || null,
        });
      }
    }
    techniqueStore.upsert(techniques.values());

    const sensorTypes = new Set(inWindow.flatMap((m) => m.sensors.map((s) => String(s.sensor_type))));
    store(ctx, "dim_sensor_type").upsert([...sensorTypes].map((s) => ({ tenant_id: ctx.tenantId, sensor_type: s, label: sensorLabel(s) })));

    // Prune detail past retention; the daily counts stay.
    const keepFrom = localDaysAgo(now, detectionRetentionDays, timeZone);
    const old = new Set(facts.all().filter((r) => r.tenant_id === ctx.tenantId && String(r.created_local_date ?? "") < keepFrom && r.created_local_date).map((r) => String(r.detection_id)));
    if (old.size) {
      const isOld = (r: Row) => r.tenant_id === ctx.tenantId && old.has(String(r.detection_id));
      for (const name of ["fact_detection", "bridge_detection_technique", "bridge_detection_sensor", "bridge_detection_entity"]) store(ctx, name).remove(isOld);
      ctx.log(`Pruned ${old.size} detections older than ${keepFrom} (counts stay in fact_detection_daily).`);
    }

    const marks: Partial<Record<string, string>> = { detectionsWindowStart: fromIso };
    if (mode === "backfill") marks.backfilledFrom = firstDay;
    ctx.watermarks.set(ctx.tenantId, marks);
    return {
      rows: {
        fact_detection: inWindow.length,
        bridge_detection_technique: inWindow.reduce((n, m) => n + m.techniques.length, 0),
        bridge_detection_sensor: inWindow.reduce((n, m) => n + m.sensors.length, 0),
        bridge_detection_entity: personalData ? inWindow.reduce((n, m) => n + m.entities.length, 0) : 0,
        fact_detection_daily: daily.length,
        fact_technique_daily: breakdown.techniques.length,
        fact_sensor_daily: breakdown.sensors.length,
        dim_detector: detectors.size,
        dim_mitre_technique: techniques.size,
        dim_sensor_type: sensorTypes.size,
      },
      notes: [
        ...(inWindow.length ? [] : [`No detections from ${firstDay}.`]),
        ...(personalData ? [] : ["bridge_detection_entity stays empty while the personal data switch is off."]),
      ],
    };
  },
};
