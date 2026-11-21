/**
 * doctor: checks everything a run needs, with as few calls as it can
 * (about ten), and says what to fix in plain words.
 */

import { access, constants, mkdir } from "node:fs/promises";
import type { ExportConfig } from "./config.js";
import { AI_ACTIVITIES, AI_DEFENSE_OVERVIEW, CASES_PAGE, DETECTION_COUNT } from "./sophos/documents.js";
import { isForbidden, isNotOnFusion, SophosSession } from "./sophos/session.js";
import { SharePointSink, type SharePointConfig } from "./sinks/sharepoint.js";
import { hasSecOpsLicense, parseLicenses } from "./vendor/sophos-core/index.js";
import { ALERT_PAGE_SIZE } from "./datasets/alerts.js";
import { ENDPOINT_PAGE_SIZE } from "./datasets/endpoints.js";
import { CASES_PAGE_SIZE } from "./datasets/cases.js";
import { AI_ACTIVITY_PAGE_SIZE, AI_INVENTORY_PAGE_SIZE } from "./datasets/ai-defense.js";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorReport {
  checks: Check[];
  calls: number;
  ok: boolean;
}

export async function runDoctor(options: {
  config: ExportConfig;
  credentials: { clientId: string; clientSecret: string };
  sharepoint?: SharePointConfig | null;
  session?: SophosSession;
}): Promise<DoctorReport> {
  const { config } = options;
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  try {
    await mkdir(config.outputDir, { recursive: true });
    await access(config.outputDir, constants.W_OK);
    add("Output folder", true, config.outputDir);
  } catch {
    add("Output folder", false, `Can't write to ${config.outputDir}.`);
  }
  add("Report time zone", true, config.reportTimezone);
  add("Personal data", true, config.personalData ? "on: hostnames, users, titles and descriptions are exported" : "off (default): personal columns stay empty");

  let session: SophosSession | undefined = options.session;
  try {
    session ??= await SophosSession.open({ ...options.credentials, perMinute: config.rate.perMinute, perHour: config.rate.perHour, maxCalls: 50 });
    add("Credential", true, `tenant ${session.tenantId}, data region ${session.apiHost}`);
  } catch (error) {
    add("Credential", false, error instanceof Error ? error.message : String(error));
    return { checks, calls: 0, ok: false };
  }

  const estimate: Record<string, number> = { whoami: 1 };
  const attempt = async (name: string, fn: () => Promise<string>) => {
    try {
      add(name, true, await fn());
    } catch (error) {
      add(name, false, error instanceof Error ? error.message : String(error));
    }
  };

  await attempt("Licenses", async () => {
    const licenses = parseLicenses(await session!.global<unknown>("/licenses/v1/licenses"));
    estimate.licenses = 1;
    const codes = [...new Set(licenses.map((l) => l.code))];
    return `${licenses.length} license records; ${hasSecOpsLicense(codes) ? "XDR or MDR present, so cases and detections apply" : "no XDR or MDR license, so expect alerts and endpoint health only"}`;
  });

  await attempt("Cases", async () => {
    try {
      const { data } = await session!.graphql<{ cases: { totalCount: number } }>(CASES_PAGE, { arguments: { query: "", pagination: { cursor: { first: 1 } } } });
      estimate.cases = 2 + Math.ceil(Math.min(data.cases.totalCount, 500) / CASES_PAGE_SIZE);
      return `Sophos Fusion Cases v2: ${data.cases.totalCount} cases (a backfill reads them all)`;
    } catch (error) {
      if (isNotOnFusion(error)) {
        try {
          const body = await session!.rest<{ pages?: { items?: number } }>("/cases/v1/cases", { page: "1", pageSize: "1" });
          estimate.cases = 1 + Math.ceil((body.pages?.items ?? 0) / 50);
          return `Not on Sophos Fusion yet: cases v1 holds ${body.pages?.items ?? "an unknown number of"} cases`;
        } catch (legacy) {
          if (isForbidden(legacy)) return "No cases API for this tenant (no XDR or MDR license). The cases tables stay empty.";
          throw legacy;
        }
      }
      throw error;
    }
  });

  await attempt("Detections", async () => {
    const { data } = await session!.graphql<{ detectionCountByTenant: { items?: Array<{ count: number }> } }>(DETECTION_COUNT, { in: { ql_query: "FROM alert WHERE severity >= 0 EARLIEST=-1d" } });
    const perDay = (data.detectionCountByTenant.items ?? []).reduce((n, i) => n + i.count, 0);
    estimate.detections = 1 + Math.max(1, Math.ceil((perDay * config.detections.trailingDays) / config.detections.pageSize));
    return `${perDay} detections in the last 24 hours`;
  });

  await attempt("Endpoints", async () => {
    const body = await session!.rest<{ pages?: { items?: number } }>("/endpoint/v1/endpoints", { pageSize: "1", pageTotal: "true" });
    const count = body.pages?.items ?? 0;
    estimate.endpoints = Math.max(1, Math.ceil(count / ENDPOINT_PAGE_SIZE));
    return `${count} endpoints`;
  });

  await attempt("Account Health Check", async () => {
    await session!.rest<unknown>("/account-health-check/v1/health-check");
    estimate.health = 1;
    return "reachable";
  });

  await attempt("Alerts", async () => {
    const body = await session!.rest<{ pages?: { items?: number } }>("/common/v1/alerts", { pageSize: "1", pageTotal: "true" });
    const count = body.pages?.items ?? 0;
    estimate.alerts = Math.max(1, Math.ceil(count / ALERT_PAGE_SIZE));
    return `${count} open alerts`;
  });

  if (config.datasets.includes("aiDefense")) {
    await attempt("AI Defense", async () => {
      const now = Date.now();
      const window = (days: number) => ({ startTime: new Date(now - days * 86_400_000).toISOString(), endTime: new Date(now).toISOString() });
      try {
        const { data } = await session!.graphql<{ secureAITenantSettings: { licenseState?: string | null } | null; inventorySummary: { apps: { totalApps: number }; users: { totalUsers: number } } }>(AI_DEFENSE_OVERVIEW, {
          summary: { timeRange: window(config.aiDefense.inventoryDays) },
        });
        const apps = Number(data.inventorySummary.apps.totalApps) || 0;
        const users = Number(data.inventorySummary.users.totalUsers) || 0;
        if (!data.secureAITenantSettings && apps === 0 && users === 0) {
          estimate.aiDefense = 1;
          return "no AI Defense on this tenant; the AI Defense tables stay empty";
        }
        const { data: day } = await session!.graphql<{ activities: { totalCount: number } }>(AI_ACTIVITIES, { filter: { timeRange: window(1) }, first: 1 });
        const perDay = Number(day.activities.totalCount) || 0;
        const pages = (n: number) => Math.max(1, Math.ceil(n / AI_INVENTORY_PAGE_SIZE));
        estimate.aiDefense = 2 + Math.max(1, Math.ceil((perDay * (config.aiDefense.trailingDays + 1)) / AI_ACTIVITY_PAGE_SIZE)) + 2 * pages(apps) + pages(users);
        return `license ${data.secureAITenantSettings?.licenseState ?? "not recorded"}; ${perDay} activities in the last 24 hours; ${apps} apps and ${users} users in the last ${config.aiDefense.inventoryDays} days. A backfill reads ${config.aiDefense.backfillDays} days at ${AI_ACTIVITY_PAGE_SIZE} activities a call`;
      } catch (error) {
        if (isNotOnFusion(error)) return "not on Sophos Fusion, so no AI Defense data";
        throw error;
      }
    });
  }

  const perRun = Object.values(estimate).reduce((a, b) => a + b, 0);
  add(
    "Rate budget",
    perRun < config.maxCallsPerRun,
    `about ${perRun} calls for a daily run; the exporter sends at most ${config.rate.perMinute} a minute and ${config.rate.perHour} an hour, under Sophos's 100 a minute per credential, which every integration on this credential shares`
  );

  if (options.sharepoint) {
    try {
      const sink = new SharePointSink(options.sharepoint);
      const where = await sink.resolve();
      add("SharePoint", true, `${where.webUrl}, folder ${sink.folder}`);
    } catch (error) {
      add("SharePoint", false, error instanceof Error ? error.message : String(error));
    }
  }

  return { checks, calls: session.callCount, ok: checks.every((c) => c.ok) };
}
