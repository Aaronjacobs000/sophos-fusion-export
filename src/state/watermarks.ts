/**
 * Watermarks, kept per tenant and data set in _state/watermarks.json. They
 * hold times and counts only, never a credential or a token.
 */

export interface TenantWatermarks {
  /** Latest case updatedAt seen. The next run reads from this minus the overlap. */
  casesUpdatedAt?: string;
  /** Start of the last detection window read. */
  detectionsWindowStart?: string;
  /** Earliest local date a backfill covered. */
  backfilledFrom?: string;
  lastRunAt?: string;
  lastMode?: "run" | "backfill";
}

export interface WatermarkFile {
  version: 1;
  tenants: Record<string, TenantWatermarks>;
}

export class Watermarks {
  private data: WatermarkFile;

  constructor(text: string | null) {
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    const file = parsed as Partial<WatermarkFile> | null;
    this.data = file && file.version === 1 && file.tenants && typeof file.tenants === "object" ? (file as WatermarkFile) : { version: 1, tenants: {} };
  }

  get(tenantId: string): TenantWatermarks {
    return (this.data.tenants[tenantId] ??= {});
  }

  set(tenantId: string, patch: Partial<TenantWatermarks>): void {
    this.data.tenants[tenantId] = { ...this.get(tenantId), ...patch };
  }

  toJson(): string {
    return `${JSON.stringify(this.data, null, 2)}\n`;
  }
}
