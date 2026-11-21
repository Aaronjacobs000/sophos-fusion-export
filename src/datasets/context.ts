/** What every data set gets for a run. */

import type { SophosSession } from "../sophos/session.js";
import type { TableStore } from "../store/table-store.js";
import type { Watermarks } from "../state/watermarks.js";

export interface RunOptions {
  now: Date;
  timeZone: string;
  personalData: boolean;
  mode: "run" | "backfill";
  /** Days of history a backfill reads (cases are read in full either way). */
  backfillDays: number;
  /** Detections re-read on every run, because their status changes after creation. */
  detectionTrailingDays: number;
  /** Detection detail older than this is pruned; fact_detection_daily keeps the counts. */
  detectionRetentionDays: number;
  /** The most detections one search reads; a time slice holding more is split (Sophos serves up to 10,000). */
  detectionPageSize: number;
  /** Re-read cases updated this long before the last watermark. */
  caseOverlapMinutes: number;
  /** AI Defense: activity re-read on every run, retention of activity detail, the most a backfill reads, and the inventory window. */
  aiDefense: { trailingDays: number; retentionDays: number; backfillDays: number; inventoryDays: number };
  tenantName?: string;
}

/** What one data set learned that dim_tenant reports. */
export interface TenantFacts {
  platform?: "fusion" | "classic";
  fusionTenantId?: string;
  tenantName?: string;
  partnerId?: string;
  organizationId?: string;
  licenseCodes?: string[];
}

export interface RunContext {
  session: SophosSession;
  tenantId: string;
  stores: ReadonlyMap<string, TableStore>;
  watermarks: Watermarks;
  options: RunOptions;
  facts: TenantFacts;
  log: (message: string) => void;
  warn: (message: string) => void;
}

export function store(ctx: RunContext, name: string): TableStore {
  const found = ctx.stores.get(name);
  if (!found) throw new Error(`No store for ${name}`);
  return found;
}

export interface DatasetResult {
  /** Rows the data set wrote this run, per table. */
  rows: Record<string, number>;
  /** Why a table is empty, when it is. */
  notes: string[];
}

export interface Dataset {
  name: string;
  description: string;
  run(ctx: RunContext): Promise<DatasetResult>;
}
