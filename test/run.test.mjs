// Whole runs over the fake Sophos: golden CSV output, idempotent reruns,
// window replacement, snapshots, the personal data switch and watermarks.
// Set UPDATE_GOLDEN=1 to rewrite the golden files after a deliberate change.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExport } from "../dist/runner.js";
import { buildConfig } from "../dist/config.js";
import { SophosSession } from "../dist/sophos/session.js";
import { TABLES } from "../dist/schema/tables.js";
import { parseCsv } from "../dist/store/csv.js";
import { fakeSophos, fixture } from "./helpers/fake-sophos.mjs";

const NOW = new Date("2026-11-21T08:00:00Z");
const GOLDEN = new URL("./golden/", import.meta.url);

async function exportOnce(dir, { now = NOW, mode = "backfill", sophos = fakeSophos(), personalData = false, days = 3 } = {}) {
  const config = buildConfig({ outputDir: dir, reportTimezone: "Australia/Sydney", tenantName: "Example Tenant", personalData });
  const session = await SophosSession.open({ clientId: "id", clientSecret: "secret", baseFetch: sophos.fetch, perMinute: 100 });
  const summary = await runExport({ config, mode, backfillDays: days, credentials: { clientId: "", clientSecret: "" }, now, session });
  return { summary, sophos };
}

async function readTables(dir) {
  const out = {};
  for (const t of TABLES) out[t.name] = await readFile(join(dir, `${t.name}.csv`), "utf8");
  return out;
}

async function scratch() {
  return mkdtemp(join(tmpdir(), "fusion-export-test-"));
}

test("golden: column names, order and types of every table", async () => {
  const actual = Object.fromEntries(TABLES.map((t) => [t.name, t.columns.map((c) => `${c.name}:${c.type}${c.personal ? ":personal" : ""}`)]));
  const file = new URL("columns.json", GOLDEN);
  if (process.env.UPDATE_GOLDEN) await writeFile(file, `${JSON.stringify(actual, null, 2)}\n`);
  assert.deepEqual(actual, JSON.parse(await readFile(file, "utf8")));
});

test("golden: the CSV a backfill writes from the fixtures", async () => {
  const dir = await scratch();
  try {
    const { summary } = await exportOnce(dir);
    assert.equal(summary.ok, true, JSON.stringify(summary.datasets));
    const tables = await readTables(dir);
    const goldenDir = new URL("csv/", GOLDEN);
    if (process.env.UPDATE_GOLDEN) {
      await mkdir(goldenDir, { recursive: true });
      for (const [name, text] of Object.entries(tables)) await writeFile(new URL(`${name}.csv`, goldenDir), text);
    }
    for (const [name, text] of Object.entries(tables)) {
      const header = text.split("\n")[0];
      assert.equal(header, TABLES.find((t) => t.name === name).columns.map((c) => c.name).join(","), `${name} header`);
      // exported_at and last_seen_open_at come from the fixed clock, so the whole file is stable.
      assert.equal(text, await readFile(new URL(`${name}.csv`, goldenDir), "utf8"), `${name}.csv differs from its golden file`);
    }
    const schema = JSON.parse(await readFile(join(dir, "_schema.json"), "utf8"));
    assert.equal(schema.tables.length, TABLES.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a rerun with the same answers writes the same bytes", async () => {
  const dir = await scratch();
  try {
    await exportOnce(dir);
    const first = await readTables(dir);
    await exportOnce(dir);
    assert.deepEqual(await readTables(dir), first);
    await exportOnce(dir, { mode: "run" });
    assert.deepEqual(await readTables(dir), first);
    const runs = (await readFile(join(dir, "_state/runs.jsonl"), "utf8")).trim().split("\n");
    assert.equal(runs.length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a detection gone from the window is removed, and its bridge rows with it", async () => {
  const dir = await scratch();
  try {
    await exportOnce(dir);
    const page = fixture("detections-page.json");
    page.data.detectionSearch.alerts.list = page.data.detectionSearch.alerts.list.slice(1);
    const sophos = fakeSophos({
      overrides: {
        ExportDetectionSearch: () => page,
        ExportDetectionCount: () => ({ data: { detectionCountByTenant: { items: [{ count: 2, tenant: { id: "100001" } }] } } }),
      },
    });
    await exportOnce(dir, { sophos, mode: "run" });
    const facts = parseCsv(await readFile(join(dir, "fact_detection.csv"), "utf8")).rows;
    assert.equal(facts.length, 2);
    const bridge = parseCsv(await readFile(join(dir, "bridge_detection_technique.csv"), "utf8")).rows;
    assert.deepEqual(bridge.map((r) => r.technique_id), ["T1059"]);
    const daily = parseCsv(await readFile(join(dir, "fact_detection_daily.csv"), "utf8")).rows;
    assert.equal(daily.reduce((n, r) => n + Number(r.detections), 0), 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshots: a second day adds rows, the same day replaces them", async () => {
  const dir = await scratch();
  try {
    await exportOnce(dir);
    await exportOnce(dir, { mode: "run" });
    let endpoints = parseCsv(await readFile(join(dir, "fact_endpoint_snapshot.csv"), "utf8")).rows;
    assert.equal(endpoints.length, 2);
    await exportOnce(dir, { mode: "run", now: new Date("2026-11-22T08:00:00Z") });
    endpoints = parseCsv(await readFile(join(dir, "fact_endpoint_snapshot.csv"), "utf8")).rows;
    assert.deepEqual([...new Set(endpoints.map((r) => r.snapshot_date))], ["2026-11-21", "2026-11-22"]);
    assert.equal(endpoints.length, 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("personal data off: personal columns empty and the entity table holds only its header", async () => {
  const dir = await scratch();
  try {
    await exportOnce(dir, { personalData: true });
    const on = parseCsv(await readFile(join(dir, "fact_endpoint_snapshot.csv"), "utf8")).rows;
    assert.ok(on.some((r) => r.hostname === "DC1"));
    assert.ok(parseCsv(await readFile(join(dir, "bridge_detection_entity.csv"), "utf8")).rows.length > 0);
    // Turning the switch off scrubs what an earlier run wrote.
    await exportOnce(dir, { personalData: false });
    for (const t of TABLES) {
      const { rows } = parseCsv(await readFile(join(dir, `${t.name}.csv`), "utf8"));
      if (t.personalOnly) assert.equal(rows.length, 0, t.name);
      for (const c of t.columns.filter((c) => c.personal)) assert.ok(rows.every((r) => r[c.name] === ""), `${t.name}.${c.name}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("watermarks: an incremental run asks for cases updated since the last one, minus the overlap", async () => {
  const dir = await scratch();
  try {
    await exportOnce(dir);
    const marks = JSON.parse(await readFile(join(dir, "_state/watermarks.json"), "utf8"));
    const tenant = Object.values(marks.tenants)[0];
    assert.equal(tenant.casesUpdatedAt, "2026-11-20T01:00:00Z");
    assert.equal(tenant.lastMode, "backfill");
    const { sophos } = await exportOnce(dir, { mode: "run" });
    const casesCall = sophos.requests.find((r) => r.operation === "ExportCasesPage");
    assert.equal(casesCall.variables.arguments.query, "updatedAt >= '2026-11-20T00:45:00Z'");
    assert.equal(casesCall.variables.arguments.pagination.cursor.first, 100);
    const watermarkText = await readFile(join(dir, "_state/watermarks.json"), "utf8");
    assert.ok(!/secret|token/i.test(watermarkText));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a window over the search limit is split into slices and de-duplicated", async () => {
  const dir = await scratch();
  try {
    const list = fixture("detections-page.json").data.detectionSearch.alerts.list;
    let searches = 0;
    const sophos = fakeSophos({
      overrides: {
        // The whole window claims 25,000; any slice shorter than a day claims 2.
        ExportDetectionCount: (r) => {
          const q = r.variables.in.ql_query;
          const [, a, b] = /EARLIEST='([^']+)' LATEST='([^']+)'/.exec(q);
          const hours = (Date.parse(b) - Date.parse(a)) / 3_600_000;
          return { data: { detectionCountByTenant: { items: [{ count: hours > 24 ? 25_000 : 2, tenant: { id: "100001" } }] } } };
        },
        ExportDetectionSearch: () => {
          searches++;
          return { data: { detectionSearch: { status: "OK", reason: "success", alerts: { total_results: 3, list } } } };
        },
      },
    });
    const { summary } = await exportOnce(dir, { sophos, days: 3 });
    assert.ok(searches >= 4, `expected the window to be split, got ${searches} searches`);
    assert.equal(summary.datasets.detections.rows.fact_detection, 3, "the same detections from several slices are kept once");
    assert.ok(summary.warnings.some((w) => /detectionCountByTenant said 25000/.test(w)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a tenant not on Sophos Fusion falls back to cases v1", async () => {
  const dir = await scratch();
  try {
    const sophos = fakeSophos({ notOnFusion: true });
    const { summary } = await exportOnce(dir, { sophos });
    assert.equal(summary.datasets.cases.ok, true);
    assert.equal(summary.datasets.detections.ok, false, "detections need Fusion");
    const cases = parseCsv(await readFile(join(dir, "fact_case.csv"), "utf8")).rows;
    assert.deepEqual(cases.map((c) => c.api_version), ["v1", "v1"]);
    const tenant = parseCsv(await readFile(join(dir, "dim_tenant.csv"), "utf8")).rows[0];
    assert.equal(tenant.platform, "classic");
    assert.equal(summary.ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("detail past retention is pruned while the daily counts stay", async () => {
  const dir = await scratch();
  try {
    await exportOnce(dir);
    const config = buildConfig({ outputDir: dir, reportTimezone: "Australia/Sydney", detections: { retentionDays: 10, trailingDays: 1 } });
    const later = new Date("2026-12-10T08:00:00Z");
    const sophos = fakeSophos({
      overrides: {
        ExportDetectionSearch: () => ({ data: { detectionSearch: { status: "OK", alerts: { total_results: 0, list: [] } } } }),
        ExportDetectionCount: () => ({ data: { detectionCountByTenant: { items: [] } } }),
      },
    });
    const session = await SophosSession.open({ clientId: "id", clientSecret: "secret", baseFetch: sophos.fetch, perMinute: 100 });
    await runExport({ config, mode: "run", credentials: { clientId: "", clientSecret: "" }, now: later, session });
    assert.equal(parseCsv(await readFile(join(dir, "fact_detection.csv"), "utf8")).rows.length, 0);
    assert.equal(parseCsv(await readFile(join(dir, "bridge_detection_sensor.csv"), "utf8")).rows.length, 0);
    assert.ok(parseCsv(await readFile(join(dir, "fact_detection_daily.csv"), "utf8")).rows.length > 0);
    assert.ok(existsSync(join(dir, "_schema.json")));
    const files = await readdir(dir);
    assert.ok(!files.some((f) => f.endsWith(".tmp")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const aiOps = (sophos) => sophos.requests.filter((r) => r.operation?.startsWith("ExportAi"));

test("AI Defense: a tenant without it costs one call and leaves only the status row", async () => {
  const dir = await scratch();
  try {
    const sophos = fakeSophos({
      overrides: {
        ExportAiDefenseOverview: () => ({ data: { secureAITenantSettings: null, inventorySummary: { apps: { totalApps: 0 }, users: { totalUsers: 0 } } } }),
      },
    });
    const { summary } = await exportOnce(dir, { sophos });
    assert.equal(summary.ok, true);
    assert.equal(aiOps(sophos).length, 1);
    assert.match(summary.datasets.aiDefense.notes[0], /No AI Defense/);
    const status = parseCsv(await readFile(join(dir, "fact_ai_defense_snapshot.csv"), "utf8")).rows;
    assert.equal(status.length, 1);
    assert.equal(status[0].license_state, "");
    assert.equal(parseCsv(await readFile(join(dir, "fact_ai_activity.csv"), "utf8")).rows.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("AI Defense: a refused credential is a warning, not a failed run", async () => {
  const dir = await scratch();
  try {
    const sophos = fakeSophos({ overrides: { ExportAiDefenseOverview: () => ({ errors: [{ message: "not authorized to access SecureAI" }], data: null }) } });
    const { summary } = await exportOnce(dir, { sophos });
    assert.equal(summary.datasets.aiDefense.ok, true);
    assert.ok(summary.warnings.some((w) => /refused the AI Defense APIs/.test(w)));
    assert.equal(summary.ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("AI Defense: activity gone from the window is removed, and a run after a gap reads from the last full read", async () => {
  const dir = await scratch();
  try {
    await exportOnce(dir);
    const marks = JSON.parse(await readFile(join(dir, "_state/watermarks.json"), "utf8"));
    const tenant = Object.values(marks.tenants)[0];
    assert.equal(tenant.aiActivitiesReadTo, "2026-11-21T08:00:00Z");
    assert.equal(tenant.aiBackfilledFrom, "2026-11-18");

    // Ten days later, with the default 3 trailing days, the run starts at the last full read instead.
    const second = fixture("ai-activities-page.json");
    second.data.activities.activities = second.data.activities.activities.slice(1);
    second.data.activities.pageInfo = { hasNextPage: false, endCursor: null };
    second.data.activities.totalCount = 2;
    const sophos = fakeSophos({ overrides: { ExportAiActivities: () => second } });
    await exportOnce(dir, { sophos, mode: "run", now: new Date("2026-12-01T08:00:00Z") });
    const read = aiOps(sophos).find((r) => r.operation === "ExportAiActivities");
    assert.equal(read.variables.filter.timeRange.startTime, "2026-11-20T13:00:00.000Z", "from local midnight of 21/11 in Sydney");
    const ids = parseCsv(await readFile(join(dir, "fact_ai_activity.csv"), "utf8")).rows.map((r) => r.activity_id.split(":").pop());
    // 200001 and 200002 are before the window and stay; 200004 was in the window and is gone from Sophos's answer.
    assert.deepEqual(ids.sort(), ["200001", "200002", "200003"]);
    const daily = parseCsv(await readFile(join(dir, "fact_ai_activity_daily.csv"), "utf8")).rows;
    assert.ok(!daily.some((r) => r.local_date === "2026-11-21"), "the daily counts inside the window are replaced too");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
