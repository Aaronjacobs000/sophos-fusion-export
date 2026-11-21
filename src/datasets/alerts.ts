/**
 * Product alerts (Common API, GET /common/v1/alerts, documented). The API
 * lists the alerts still open, so each run reads all of them and upserts on
 * alert ID; an acknowledged alert leaves the API but keeps its row, with
 * last_seen_open_at saying when a run last saw it. This is the alert feed for
 * tenants without XDR or MDR, where there are no detections or cases.
 */

import type { Row } from "../store/csv.js";
import { dateKey, isoSeconds, localDate } from "../time.js";
import { store, type Dataset, type RunContext } from "./context.js";

export const ALERT_PAGE_SIZE = 1000;
const MAX_PAGES = 100;

export interface RawAlert {
  id: string;
  raisedAt?: string;
  severity?: string;
  category?: string;
  product?: string;
  type?: string;
  status?: string;
  description?: string;
  eventCount?: number;
  managedAgent?: { id?: string; type?: string };
  tenant?: { id?: string; name?: string };
}

export function mapAlert(a: RawAlert, tenantId: string, timeZone: string, now: Date): Row {
  return {
    tenant_id: tenantId,
    alert_id: a.id,
    raised_at: isoSeconds(a.raisedAt),
    raised_local_date: localDate(a.raisedAt, timeZone),
    raised_date_key: dateKey(localDate(a.raisedAt, timeZone)),
    severity: a.severity ?? null,
    category: a.category ?? null,
    product: a.product ?? null,
    alert_type: a.type ?? null,
    status: a.status ?? null,
    managed_agent_id: a.managedAgent?.id ?? null,
    managed_agent_type: a.managedAgent?.type ?? null,
    event_count: typeof a.eventCount === "number" ? a.eventCount : null,
    description: a.description ?? null,
    last_seen_open_at: isoSeconds(now),
  };
}

interface AlertPage {
  items?: RawAlert[];
  pages?: { nextKey?: string };
}

export const alertsDataset: Dataset = {
  name: "alerts",
  description: "Sophos Central product alerts (fact_alert).",
  async run(ctx: RunContext) {
    const { now, timeZone } = ctx.options;
    const alerts: RawAlert[] = [];
    let fromKey: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await ctx.session.rest<AlertPage>("/common/v1/alerts", {
        pageSize: String(ALERT_PAGE_SIZE),
        ...(fromKey ? { pageFromKey: fromKey } : {}),
      });
      alerts.push(...(body.items ?? []));
      fromKey = body.pages?.nextKey;
      if (!fromKey || !body.items?.length) break;
    }
    const name = alerts.find((a) => a.tenant?.name)?.tenant?.name;
    if (name) ctx.facts.tenantName ??= name;
    const rows = alerts.map((a) => mapAlert(a, ctx.tenantId, timeZone, now));
    store(ctx, "fact_alert").upsert(rows);
    return { rows: { fact_alert: rows.length }, notes: rows.length ? [] : ["No open alerts."] };
  },
};
