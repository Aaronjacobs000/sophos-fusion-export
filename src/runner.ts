/**
 * One export run: open the credential, load what the folder already holds,
 * run each data set, write every table back, record the run, and upload to
 * SharePoint when it is configured. A data set that fails is reported and
 * the others still run; its tables keep their previous rows.
 */

import { alertsDataset } from "./datasets/alerts.js";
import { casesDataset } from "./datasets/cases.js";
import type { Dataset, RunContext, TenantFacts } from "./datasets/context.js";
import { detectionsDataset } from "./datasets/detections.js";
import { endpointsDataset } from "./datasets/endpoints.js";
import { licensesDataset } from "./datasets/licenses.js";
import type { ExportConfig, DatasetName } from "./config.js";
import { schemaDocument, TABLES } from "./schema/tables.js";
import { FolderSink } from "./sinks/folder.js";
import { SharePointSink, type SharePointConfig } from "./sinks/sharepoint.js";
import type { CallRecord } from "./sophos/guard.js";
import { SophosSession } from "./sophos/session.js";
import { Watermarks } from "./state/watermarks.js";
import { TableStore } from "./store/table-store.js";
import { isoSeconds } from "./time.js";

export const DATASET_MODULES: Record<DatasetName, Dataset> = {
  licenses: licensesDataset,
  cases: casesDataset,
  detections: detectionsDataset,
  endpoints: endpointsDataset,
  alerts: alertsDataset,
};

export interface RunRequest {
  config: ExportConfig;
  mode: "run" | "backfill";
  backfillDays?: number;
  credentials: { clientId: string; clientSecret: string };
  sharepoint?: SharePointConfig | null;
  now?: Date;
  log?: (message: string) => void;
  /** Tests pass an open session over a fake Sophos. */
  session?: SophosSession;
}

export interface RunSummary {
  mode: "run" | "backfill";
  startedAt: string;
  finishedAt: string;
  tenantId: string;
  calls: number;
  callsByOperation: Record<string, number>;
  peakPerMinute: number;
  rateLimited: number;
  datasets: Record<string, { ok: boolean; rows: Record<string, number>; notes: string[]; error?: string }>;
  tables: Record<string, number>;
  warnings: string[];
  uploaded: string[];
  uploadError?: string;
  ok: boolean;
}

export function summarizeCalls(calls: readonly CallRecord[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of calls) {
    const key = c.operation ? `graphql ${c.operation}` : `${c.method} ${c.path}`;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

export function tenantRow(tenantId: string, apiHost: string, facts: TenantFacts, config: ExportConfig, now: Date): Record<string, string | null> {
  return {
    tenant_id: tenantId,
    tenant_name: config.tenantName ?? facts.tenantName ?? tenantId,
    fusion_tenant_id: facts.fusionTenantId ?? null,
    partner_id: facts.partnerId ?? null,
    organization_id: facts.organizationId ?? null,
    data_region: apiHost || null,
    platform: facts.platform ?? null,
    report_timezone: config.reportTimezone,
    license_codes: facts.licenseCodes?.length ? facts.licenseCodes.join("|") : null,
    exported_at: isoSeconds(now),
  };
}

export async function runExport(request: RunRequest): Promise<RunSummary> {
  const { config, mode } = request;
  const log = request.log ?? (() => {});
  const now = request.now ?? new Date();
  const startedAt = isoSeconds(now)!;
  const folder = new FolderSink(config.outputDir);
  await folder.ensure();

  const session =
    request.session ??
    (await SophosSession.open({
      clientId: request.credentials.clientId,
      clientSecret: request.credentials.clientSecret,
      perMinute: config.rate.perMinute,
      perHour: config.rate.perHour,
      maxCalls: config.maxCallsPerRun,
    }));
  log(`Signed in: tenant ${session.tenantId}, region ${session.apiHost || "unknown"}.`);

  const stores = new Map<string, TableStore>();
  for (const def of TABLES) {
    const store = new TableStore(def, config.personalData);
    store.load(await folder.read(`${def.name}.csv`));
    stores.set(def.name, store);
  }
  const watermarks = new Watermarks(await folder.read("_state/watermarks.json"));
  const warnings: string[] = [];
  const facts: TenantFacts = {};
  const ctx: RunContext = {
    session,
    tenantId: session.tenantId,
    stores,
    watermarks,
    facts,
    options: {
      now,
      timeZone: config.reportTimezone,
      personalData: config.personalData,
      mode,
      backfillDays: request.backfillDays ?? config.backfillDays,
      detectionTrailingDays: config.detections.trailingDays,
      detectionRetentionDays: config.detections.retentionDays,
      detectionPageSize: config.detections.pageSize,
      caseOverlapMinutes: config.cases.overlapMinutes,
      ...(config.tenantName ? { tenantName: config.tenantName } : {}),
    },
    log,
    warn: (message) => {
      warnings.push(message);
      log(`Warning: ${message}`);
    },
  };

  const datasets: RunSummary["datasets"] = {};
  for (const name of config.datasets) {
    const dataset = DATASET_MODULES[name];
    const before = session.callCount;
    try {
      const result = await dataset.run(ctx);
      datasets[name] = { ok: true, ...result };
      log(`${name}: ${Object.entries(result.rows).map(([t, n]) => `${t} ${n}`).join(", ")} (${session.callCount - before} calls)`);
      for (const note of result.notes) log(`  ${note}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      datasets[name] = { ok: false, rows: {}, notes: [], error: message };
      log(`${name} failed: ${message}`);
    }
  }

  // Keep the platform from an earlier run when this run didn't read cases.
  const tenantStore = stores.get("dim_tenant")!;
  const prior = tenantStore.all().find((r) => r.tenant_id === session.tenantId);
  if (!facts.platform && prior?.platform) facts.platform = String(prior.platform) as TenantFacts["platform"];
  if (!facts.fusionTenantId && prior?.fusion_tenant_id) facts.fusionTenantId = String(prior.fusion_tenant_id);
  if (!facts.licenseCodes && prior?.license_codes) facts.licenseCodes = String(prior.license_codes).split("|");
  if (!facts.tenantName && prior?.tenant_name && prior.tenant_name !== session.tenantId) facts.tenantName = String(prior.tenant_name);
  if (!facts.partnerId && prior?.partner_id) facts.partnerId = String(prior.partner_id);
  if (!facts.organizationId && prior?.organization_id) facts.organizationId = String(prior.organization_id);
  tenantStore.upsert([tenantRow(session.tenantId, session.apiHost, facts, config, now)]);

  const files = new Map<string, string>();
  const tables: Record<string, number> = {};
  for (const def of TABLES) {
    const store = stores.get(def.name)!;
    const text = store.toCsv();
    await folder.write(`${def.name}.csv`, text);
    files.set(`${def.name}.csv`, text);
    tables[def.name] = def.personalOnly && !config.personalData ? 0 : store.size;
  }
  const schemaText = `${JSON.stringify(schemaDocument(), null, 2)}\n`;
  await folder.write("_schema.json", schemaText);
  files.set("_schema.json", schemaText);
  watermarks.set(session.tenantId, { lastRunAt: startedAt, lastMode: mode });
  await folder.write("_state/watermarks.json", watermarks.toJson());

  let uploaded: string[] = [];
  let uploadError: string | undefined;
  if (request.sharepoint) {
    try {
      const sink = new SharePointSink(request.sharepoint);
      const previousText = await folder.read("_state/uploads.json");
      const previous = previousText ? (JSON.parse(previousText) as Record<string, string>) : {};
      const result = await sink.sync(files, previous);
      uploaded = result.sent;
      await folder.write("_state/uploads.json", `${JSON.stringify(result.hashes, null, 2)}\n`);
      log(`SharePoint: uploaded ${uploaded.length} changed file(s) to ${request.sharepoint.siteUrl} (${sink.folder}).`);
    } catch (error) {
      uploadError = error instanceof Error ? error.message : String(error);
      log(`SharePoint upload failed: ${uploadError}`);
    }
  }

  const ok = Object.values(datasets).every((d) => d.ok) && !uploadError;
  const summary: RunSummary = {
    mode,
    startedAt,
    finishedAt: isoSeconds(new Date())!,
    tenantId: session.tenantId,
    calls: session.callCount,
    callsByOperation: summarizeCalls(session.calls),
    peakPerMinute: session.limiter.peakPerMinute(),
    rateLimited: session.calls.filter((c) => c.status === 429).length,
    datasets,
    tables,
    warnings,
    uploaded,
    ...(uploadError ? { uploadError } : {}),
    ok,
  };
  await folder.append("_state/runs.jsonl", `${JSON.stringify(summary)}\n`);
  log(`${ok ? "Done" : "Finished with errors"}: ${summary.calls} Sophos API calls, peak ${summary.peakPerMinute} in a minute, ${summary.rateLimited} rate limited.`);
  return summary;
}
