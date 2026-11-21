#!/usr/bin/env node
/**
 * Writes the Grafana dashboards in grafana/dashboards/ from the specs below.
 * Every panel reads the exporter's CSV tables through the Infinity data
 * source (uid fusion-export-csv) with the backend parser, so the queries run
 * server side. Run after changing a panel: node scripts/build-grafana.mjs
 */

import { writeFileSync } from "node:fs";

const DS = { type: "yesoreyeram-infinity-datasource", uid: "fusion-export-csv" };
// Infinity's backend filter reads a quoted date such as '2026-11-21' as a date and compares it as
// a number, so dates are filtered on the numeric *_date_key columns, empty keys read as 0, and a
// snapshot date is matched as a regular expression.
const RANGE = (key) => `(${key} ?? 0) >= \${__from:date:YYYYMMDD} && (${key} ?? 0) <= \${__to:date:YYYYMMDD}`;
const SNAPSHOT = "snapshot_date =~ '^${snapshot}$'";

const BAND_COLORS = { Critical: "dark-red", High: "red", Medium: "orange", Low: "yellow", Info: "blue" };
const SEVERITY_COLORS = { Critical: "dark-red", High: "red", Medium: "orange", Low: "yellow", Informational: "blue", "Not set": "text" };
const ALERT_COLORS = { high: "red", medium: "orange", low: "yellow" };
const ACTION_COLORS = { ALLOWED: "green", WARNED: "orange", BLOCKED: "red", MODIFIED: "purple", UNKNOWN: "text", "Not reported": "text" };
const RISK_COLORS = { CRITICAL: "dark-red", HIGH: "red", MEDIUM: "orange", LOW: "yellow", INFO: "blue", UNKNOWN: "text", ERROR: "text" };
const SANCTION_COLORS = { APPROVED: "green", WARNED: "orange", BLOCKED: "red", NOT_COVERED: "text" };

/** One Infinity CSV query. columns: [name, type] with type string, number or timestamp. */
function csv(refId, file, columns, o = {}) {
  return {
    refId,
    datasource: DS,
    type: "csv",
    source: "url",
    url: `/${file}`,
    url_options: { method: "GET", data: "" },
    parser: "backend",
    format: "table",
    root_selector: "",
    columns: columns.map(([selector, type]) => ({ selector, text: selector, type })),
    filters: [],
    computed_columns: (o.computed ?? []).map(([selector, text, type = "number"]) => ({ selector, text, type })),
    filterExpression: o.filter ?? "",
    summarizeExpression: o.summarize ?? "",
    summarizeBy: o.by ?? "",
    summarizeAlias: o.alias ?? "",
  };
}

let nextId = 1;
function base(type, title, gridPos, targets, extra = {}) {
  return { id: nextId++, type, title, gridPos, datasource: DS, targets, ...extra };
}

function stat(title, gridPos, target, { unit = "none", decimals = 0, color = "text", description, calc = "lastNotNull" } = {}) {
  return base("stat", title, gridPos, [target], {
    ...(description ? { description } : {}),
    options: {
      reduceOptions: { calcs: [calc], fields: "", values: false },
      colorMode: "value",
      graphMode: "none",
      justifyMode: "center",
      textMode: "value",
      orientation: "auto",
      wideLayout: true,
      showPercentChange: false,
    },
    fieldConfig: {
      defaults: { unit, decimals, noValue: "0", color: { mode: "fixed", fixedColor: color }, thresholds: { mode: "absolute", steps: [{ color: "green", value: null }] } },
      overrides: [],
    },
  });
}

function colorOverrides(map) {
  return Object.entries(map).map(([name, color]) => ({
    matcher: { id: "byName", options: name },
    properties: [{ id: "color", value: { mode: "fixed", fixedColor: color } }],
  }));
}

/**
 * Bars per day, one stacked series per value of `seriesField`, in the order of `colors`.
 * measure is ["sum", field] to add up a numeric column or ["count", field] to count rows.
 */
function stackedDaily(title, gridPos, target, dateField, seriesField, [how, field], colors, description) {
  const value = `${field} (${how})`;
  const first = `${dateField}\\${seriesField}`;
  return base("timeseries", title, gridPos, [target], {
    ...(description ? { description } : {}),
    transformations: [
      {
        id: "groupBy",
        options: {
          fields: {
            [dateField]: { aggregations: [], operation: "groupby" },
            [seriesField]: { aggregations: [], operation: "groupby" },
            [field]: { aggregations: [how], operation: "aggregate" },
          },
        },
      },
      { id: "groupingToMatrix", options: { columnField: seriesField, rowField: dateField, valueField: value, emptyValue: "zero" } },
      { id: "convertFieldType", options: { conversions: [{ targetField: first, destinationType: "time", dateFormat: "YYYY-MM-DD" }], fields: {} } },
      // The graph needs ascending times, and a table sorted by case or alert ID isn't.
      { id: "sortBy", options: { fields: {}, sort: [{ field: first }] } },
      { id: "organize", options: { excludeByName: {}, indexByName: Object.fromEntries([first, ...Object.keys(colors)].map((name, i) => [name, i])), renameByName: {} } },
    ],
    fieldConfig: {
      defaults: {
        custom: { drawStyle: "bars", fillOpacity: 85, lineWidth: 1, barAlignment: 0, stacking: { mode: "normal", group: "A" }, showPoints: "never", axisSoftMin: 0 },
        unit: "none",
        decimals: 0,
      },
      overrides: colorOverrides(colors),
    },
    options: { legend: { displayMode: "list", placement: "bottom", showLegend: true }, tooltip: { mode: "multi", sort: "none" } },
  });
}

function bars(title, gridPos, targets, { xField, transformations = [], colors, color = "blue", unit = "none", decimals = 0, description } = {}) {
  return base("barchart", title, gridPos, targets, {
    ...(description ? { description } : {}),
    transformations,
    options: {
      orientation: "horizontal",
      xField,
      showValue: "always",
      groupWidth: 0.7,
      barWidth: 0.8,
      stacking: "none",
      legend: { showLegend: false, displayMode: "list", placement: "bottom" },
      tooltip: { mode: "single", sort: "none" },
      xTickLabelRotation: 0,
      xTickLabelMaxLength: 40,
    },
    fieldConfig: {
      defaults: { unit, decimals, color: { mode: colors ? "fixed" : "fixed", fixedColor: color }, custom: { fillOpacity: 85, lineWidth: 0, axisSoftMin: 0 } },
      overrides: [],
    },
  });
}

function pie(title, gridPos, target, colors, description) {
  return base("piechart", title, gridPos, [target], {
    ...(description ? { description } : {}),
    options: {
      reduceOptions: { values: true, calcs: ["lastNotNull"], fields: "" },
      pieType: "donut",
      displayLabels: [],
      legend: { displayMode: "table", placement: "right", showLegend: true, values: ["value", "percent"] },
      tooltip: { mode: "single", sort: "none" },
    },
    fieldConfig: { defaults: { unit: "none", decimals: 0, color: { mode: "palette-classic" } }, overrides: colors ? colorOverrides(colors) : [] },
  });
}

function table(title, gridPos, target, { rename = {}, order, sort, limit, description, hide = [], decimals } = {}) {
  const transformations = [];
  if (sort) transformations.push({ id: "sortBy", options: { fields: {}, sort } });
  if (limit) transformations.push({ id: "limit", options: { limitField: limit } });
  transformations.push({
    id: "organize",
    options: {
      excludeByName: Object.fromEntries(hide.map((h) => [h, true])),
      indexByName: order ? Object.fromEntries(order.map((name, i) => [name, i])) : {},
      renameByName: rename,
    },
  });
  return base("table", title, gridPos, [target], {
    ...(description ? { description } : {}),
    transformations,
    options: { showHeader: true, cellHeight: "sm", footer: { show: false, reducer: ["sum"], fields: "" } },
    fieldConfig: { defaults: { ...(decimals === undefined ? {} : { decimals }), custom: { align: "auto", cellOptions: { type: "auto" }, inspect: false } }, overrides: [] },
  });
}

function text(gridPos, content) {
  return { id: nextId++, type: "text", title: "", gridPos, options: { mode: "markdown", content, code: { language: "markdown", showLineNumbers: false, showMiniMap: false } } };
}

function dashboard(uid, title, description, panels, { time = "now-30d", templating = [] } = {}) {
  return {
    uid,
    title,
    description,
    tags: ["fusion-export", "unofficial"],
    editable: false,
    graphTooltip: 1,
    timezone: "browser",
    schemaVersion: 41,
    version: 1,
    refresh: "",
    time: { from: time, to: "now" },
    timepicker: {},
    templating: { list: templating },
    annotations: { list: [] },
    links: [{ title: "Fusion Export", type: "dashboards", tags: ["fusion-export"], asDropdown: false, includeVars: false, keepTime: true, targetBlank: false }],
    panels,
  };
}

const NOTE =
  "Unofficial: built on the CSV tables of the Unofficial Sophos Fusion Data Exporter, not a Sophos product. Dates are in the exporter's report time zone.";

const snapshotVariable = {
  name: "snapshot",
  label: "Snapshot",
  type: "query",
  datasource: DS,
  query: {
    refId: "snapshots",
    queryType: "infinity",
    infinityQuery: csv("snapshots", "fact_endpoint_snapshot.csv", [["snapshot_date", "string"]]),
  },
  refresh: 1,
  sort: 2,
  includeAll: false,
  multi: false,
  current: {},
  options: [],
  hide: 0,
  description: "The endpoint, license and health check snapshot to show. The newest is picked on load.",
};

// ---------- Overview ----------
nextId = 1;
const overview = dashboard(
  "fusion-overview",
  "Fusion Export: Overview",
  "Cases, detections, endpoints and alerts for one tenant, from the exporter's CSV tables.",
  [
    text({ x: 0, y: 0, w: 24, h: 2 }, NOTE),
    stat("Open cases", { x: 0, y: 2, w: 3, h: 4 }, csv("A", "fact_case.csv", [["case_id", "string"], ["is_closed", "string"]], { filter: "is_closed == 'false'", summarize: "count(case_id)" }), { color: "orange", description: "Cases not closed, whatever the time range." }),
    stat("Cases opened", { x: 3, y: 2, w: 3, h: 4 }, csv("A", "fact_case.csv", [["case_id", "string"], ["created_date_key", "number"]], { filter: RANGE("created_date_key"), summarize: "count(case_id)" }), { description: "Cases created in the time range." }),
    stat("Detections", { x: 6, y: 2, w: 3, h: 4 }, csv("A", "fact_detection_daily.csv", [["date_key", "number"], ["detections", "number"]], { filter: RANGE("date_key"), summarize: "sum(detections)" }), { unit: "short", description: "Detections created in the time range." }),
    stat("High and up", { x: 9, y: 2, w: 3, h: 4 }, csv("A", "fact_detection_daily.csv", [["date_key", "number"], ["severity_rank", "number"], ["detections", "number"]], { filter: `${RANGE("date_key")} && severity_rank >= 4`, summarize: "sum(detections)" }), { unit: "short", color: "red", description: "Detections with severity 0.6 and up in the time range." }),
    stat("Endpoints", { x: 12, y: 2, w: 3, h: 4 }, csv("A", "fact_endpoint_snapshot.csv", [["snapshot_date", "string"], ["endpoint_id", "string"]], { filter: SNAPSHOT, summarize: "count(endpoint_id)" }), { description: "Endpoints in the selected snapshot." }),
    stat("Unhealthy", { x: 15, y: 2, w: 3, h: 4 }, csv("A", "fact_endpoint_snapshot.csv", [["snapshot_date", "string"], ["health_overall", "string"]], { filter: SNAPSHOT, computed: [["health_overall != 'good' ? 1 : 0", "unhealthy"]], summarize: "sum(unhealthy)" }), { color: "red" }),
    stat("Not seen 7+ days", { x: 18, y: 2, w: 3, h: 4 }, csv("A", "fact_endpoint_snapshot.csv", [["snapshot_date", "string"], ["days_since_seen", "number"]], { filter: SNAPSHOT, computed: [["days_since_seen >= 7 ? 1 : 0", "stale"]], summarize: "sum(stale)" }), { color: "orange" }),
    stat("Alerts raised", { x: 21, y: 2, w: 3, h: 4 }, csv("A", "fact_alert.csv", [["alert_id", "string"], ["raised_date_key", "number"]], { filter: RANGE("raised_date_key"), summarize: "count(alert_id)" }), { description: "Sophos Central product alerts raised in the time range." }),
    stackedDaily("Detections per day by severity", { x: 0, y: 6, w: 16, h: 9 }, csv("A", "fact_detection_daily.csv", [["local_date", "string"], ["severity_band", "string"], ["detections", "number"]]), "local_date", "severity_band", ["sum", "detections"], BAND_COLORS),
    bars("Open cases by severity", { x: 16, y: 6, w: 8, h: 9 }, [csv("A", "fact_case.csv", [["severity_label", "string"], ["case_id", "string"], ["is_closed", "string"], ["severity", "number"]], { filter: "is_closed == 'false'", summarize: "count(case_id)", by: "severity_label", alias: "open_cases" })], { xField: "severity_label", color: "orange" }),
    bars("Detections by ATT&CK tactic", { x: 0, y: 15, w: 12, h: 9 }, [csv("A", "fact_technique_daily.csv", [["tactic", "string"], ["date_key", "number"], ["detections", "number"]], { filter: `${RANGE("date_key")} && tactic != ''`, summarize: "sum(detections)", by: "tactic", alias: "detections" })], { xField: "tactic", color: "purple", transformations: [{ id: "sortBy", options: { fields: {}, sort: [{ field: "detections", desc: true }] } }] }),
    pie("Endpoint health", { x: 12, y: 15, w: 6, h: 9 }, csv("A", "fact_endpoint_snapshot.csv", [["snapshot_date", "string"], ["health_overall", "string"], ["endpoint_id", "string"]], { filter: SNAPSHOT, summarize: "count(endpoint_id)", by: "health_overall", alias: "endpoints" }), { good: "green", suspicious: "orange", bad: "red", unknown: "text" }),
    pie("Open cases by who manages them", { x: 18, y: 15, w: 6, h: 9 }, csv("A", "fact_case.csv", [["managed_by", "string"], ["case_id", "string"], ["is_closed", "string"]], { filter: "is_closed == 'false'", computed: [["managed_by == '' ? 'Not claimed' : managed_by", "manager", "string"]], summarize: "count(case_id)", by: "manager", alias: "cases" }), { PROVIDER: "purple", CUSTOMER: "blue", "Not claimed": "text" }),
  ],
  { templating: [snapshotVariable] }
);

// ---------- Cases ----------
nextId = 1;
const casesBoard = dashboard(
  "fusion-cases",
  "Fusion Export: Cases",
  "Case backlog, response times and outcomes.",
  [
    text({ x: 0, y: 0, w: 24, h: 2 }, `${NOTE} Sophos sends no first response or SLA time, so response is measured as created to closed.`),
    stat("Open cases", { x: 0, y: 2, w: 4, h: 4 }, csv("A", "fact_case.csv", [["case_id", "string"], ["is_closed", "string"]], { filter: "is_closed == 'false'", summarize: "count(case_id)" }), { color: "orange" }),
    stat("Opened in range", { x: 4, y: 2, w: 4, h: 4 }, csv("A", "fact_case.csv", [["case_id", "string"], ["created_date_key", "number"]], { filter: RANGE("created_date_key"), summarize: "count(case_id)" })),
    stat("Closed in range", { x: 8, y: 2, w: 4, h: 4 }, csv("A", "fact_case.csv", [["case_id", "string"], ["closed_date_key", "number"]], { filter: RANGE("closed_date_key"), summarize: "count(case_id)" }), { color: "green" }),
    stat("Mean time to close", { x: 12, y: 2, w: 4, h: 4 }, csv("A", "fact_case.csv", [["closed_date_key", "number"], ["minutes_to_close", "number"]], { filter: RANGE("closed_date_key"), computed: [["minutes_to_close / 60", "hours"]], summarize: "mean(hours)" }), { unit: "h", decimals: 1, description: "Cases closed in the time range, created to closed." }),
    stat("Mean open case age", { x: 16, y: 2, w: 4, h: 4 }, csv("A", "fact_case.csv", [["is_closed", "string"], ["age_days", "number"]], { filter: "is_closed == 'false'", summarize: "mean(age_days)" }), { unit: "d", decimals: 1, color: "orange", description: "Days since creation, as of the last export." }),
    stat("Provider managed", { x: 20, y: 2, w: 4, h: 4 }, csv("A", "fact_case.csv", [["case_id", "string"], ["is_closed", "string"], ["managed_by", "string"]], { filter: "is_closed == 'false' && managed_by == 'PROVIDER'", summarize: "count(case_id)" }), { color: "purple", description: "Open cases Sophos MDR or the partner manages." }),
    stackedDaily("Cases opened per day by severity", { x: 0, y: 6, w: 16, h: 8 }, csv("A", "fact_case.csv", [["created_local_date", "string"], ["severity_label", "string"], ["case_id", "string"]]), "created_local_date", "severity_label", ["count", "case_id"], SEVERITY_COLORS),
    bars("Open cases by status", { x: 16, y: 6, w: 8, h: 8 }, [csv("A", "fact_case.csv", [["primary_status", "string"], ["case_id", "string"], ["is_closed", "string"]], { filter: "is_closed == 'false'", summarize: "count(case_id)", by: "primary_status", alias: "cases" })], { xField: "primary_status", color: "orange", transformations: [{ id: "sortBy", options: { fields: {}, sort: [{ field: "cases", desc: true }] } }] }),
    table(
      "Mean hours to close by severity",
      { x: 0, y: 14, w: 8, h: 8 },
      csv("A", "fact_case.csv", [["severity_label", "string"], ["closed_date_key", "number"], ["minutes_to_close", "number"]], { filter: RANGE("closed_date_key"), computed: [["minutes_to_close / 60", "hours"]], summarize: "mean(hours)", by: "severity_label", alias: "mean_hours" }),
      { sort: [{ field: "mean_hours", desc: true }], rename: { severity_label: "Severity", mean_hours: "Mean hours to close" }, decimals: 1, description: "Cases closed in the time range, created to closed." }
    ),
    bars("Verdicts of cases closed in range", { x: 8, y: 14, w: 8, h: 8 }, [csv("A", "fact_case.csv", [["primary_verdict", "string"], ["case_id", "string"], ["closed_date_key", "number"]], { filter: `${RANGE("closed_date_key")} && primary_verdict != ''`, summarize: "count(case_id)", by: "primary_verdict", alias: "cases" })], { xField: "primary_verdict", color: "green", transformations: [{ id: "sortBy", options: { fields: {}, sort: [{ field: "cases", desc: true }] } }] }),
    pie("Cases opened by type", { x: 16, y: 14, w: 8, h: 8 }, csv("A", "fact_case.csv", [["case_type", "string"], ["case_id", "string"], ["created_date_key", "number"]], { filter: RANGE("created_date_key"), summarize: "count(case_id)", by: "case_type", alias: "cases" })),
    table(
      "Open cases, highest severity first",
      { x: 0, y: 22, w: 24, h: 10 },
      csv("A", "fact_case.csv", [["short_id", "string"], ["severity", "number"], ["severity_label", "string"], ["case_type", "string"], ["primary_status", "string"], ["managed_by", "string"], ["created_local_date", "string"], ["age_days", "number"], ["detections_count", "number"], ["is_closed", "string"]], { filter: "is_closed == 'false'" }),
      {
        sort: [{ field: "severity", desc: true }],
        hide: ["is_closed", "severity"],
        order: ["short_id", "severity_label", "case_type", "primary_status", "managed_by", "created_local_date", "age_days", "detections_count"],
        rename: { short_id: "Case", severity_label: "Severity", case_type: "Type", primary_status: "Status", managed_by: "Managed by", created_local_date: "Created", age_days: "Age (days)", detections_count: "Detections" },
      }
    ),
  ]
);

// ---------- Detections ----------
nextId = 1;
const detectionsBoard = dashboard(
  "fusion-detections",
  "Fusion Export: Detections and ATT&CK",
  "Detection volume, detectors, MITRE ATT&CK tactics and techniques, and sources.",
  [
    text({ x: 0, y: 0, w: 24, h: 2 }, `${NOTE} Detection detail is kept for 90 days by default; these panels use the daily counts, which the exporter keeps for good.`),
    stat("Detections", { x: 0, y: 2, w: 6, h: 4 }, csv("A", "fact_detection_daily.csv", [["date_key", "number"], ["detections", "number"]], { filter: RANGE("date_key"), summarize: "sum(detections)" }), { unit: "short" }),
    stat("High and critical", { x: 6, y: 2, w: 6, h: 4 }, csv("A", "fact_detection_daily.csv", [["date_key", "number"], ["severity_rank", "number"], ["detections", "number"]], { filter: `${RANGE("date_key")} && severity_rank >= 4`, summarize: "sum(detections)" }), { unit: "short", color: "red" }),
    stat("Still open", { x: 12, y: 2, w: 6, h: 4 }, csv("A", "fact_detection_daily.csv", [["date_key", "number"], ["open_detections", "number"]], { filter: RANGE("date_key"), summarize: "sum(open_detections)" }), { unit: "short", color: "orange", description: "Detections from the range still OPEN at the last export." }),
    stat("Techniques seen", { x: 18, y: 2, w: 6, h: 4 }, csv("A", "fact_technique_daily.csv", [["date_key", "number"], ["technique_id", "string"], ["detections", "number"]], { filter: RANGE("date_key"), summarize: "sum(detections)", by: "technique_id" }), { color: "purple", calc: "count", description: "Distinct ATT&CK techniques named in the range." }),
    stackedDaily("Detections per day by severity", { x: 0, y: 6, w: 24, h: 9 }, csv("A", "fact_detection_daily.csv", [["local_date", "string"], ["severity_band", "string"], ["detections", "number"]]), "local_date", "severity_band", ["sum", "detections"], BAND_COLORS),
    bars("Top detectors", { x: 0, y: 15, w: 12, h: 9 }, [csv("A", "fact_detection_daily.csv", [["detector_name", "string"], ["date_key", "number"], ["detections", "number"]], { filter: RANGE("date_key"), summarize: "sum(detections)", by: "detector_name", alias: "detections" })], {
      xField: "detector_name",
      color: "blue",
      transformations: [{ id: "sortBy", options: { fields: {}, sort: [{ field: "detections", desc: true }] } }, { id: "limit", options: { limitField: 10 } }],
    }),
    bars("Detections by ATT&CK tactic", { x: 12, y: 15, w: 12, h: 9 }, [csv("A", "fact_technique_daily.csv", [["tactic", "string"], ["date_key", "number"], ["detections", "number"]], { filter: `${RANGE("date_key")} && tactic != ''`, summarize: "sum(detections)", by: "tactic", alias: "detections" })], { xField: "tactic", color: "purple", transformations: [{ id: "sortBy", options: { fields: {}, sort: [{ field: "detections", desc: true }] } }] }),
    table(
      "Top ATT&CK techniques",
      { x: 0, y: 24, w: 12, h: 10 },
      csv("A", "fact_technique_daily.csv", [["technique_id", "string"], ["technique_name", "string"], ["date_key", "number"], ["detections", "number"]], { filter: RANGE("date_key"), computed: [["technique_id + ' ' + (technique_name ?? '')", "technique", "string"]], summarize: "sum(detections)", by: "technique", alias: "detections" }),
      { sort: [{ field: "detections", desc: true }], limit: 15, rename: { technique: "Technique", detections: "Detections" } }
    ),
    bars("Detections by source", { x: 12, y: 24, w: 12, h: 10 }, [csv("A", "fact_sensor_daily.csv", [["sensor_label", "string"], ["date_key", "number"], ["detections", "number"]], { filter: RANGE("date_key"), summarize: "sum(detections)", by: "sensor_label", alias: "detections" })], {
      xField: "sensor_label",
      color: "green",
      transformations: [{ id: "sortBy", options: { fields: {}, sort: [{ field: "detections", desc: true }] } }, { id: "limit", options: { limitField: 12 } }],
      description: "Sensor types that contributed, by readable name. A detection with two sources counts for both.",
    }),
  ],
  { time: "now-30d" }
);

// ---------- Endpoints, licenses and alerts ----------
nextId = 1;
const endpointsBoard = dashboard(
  "fusion-endpoints",
  "Fusion Export: Endpoints, licenses and alerts",
  "Endpoint health and coverage, Account Health Check scores, licenses and product alerts.",
  [
    text({ x: 0, y: 0, w: 24, h: 2 }, `${NOTE} Endpoints, licenses and health check scores come from the snapshot picked above; the exporter takes one a day.`),
    stat("Endpoints", { x: 0, y: 2, w: 4, h: 4 }, csv("A", "fact_endpoint_snapshot.csv", [["snapshot_date", "string"], ["endpoint_id", "string"]], { filter: SNAPSHOT, summarize: "count(endpoint_id)" })),
    stat("Servers", { x: 4, y: 2, w: 4, h: 4 }, csv("A", "fact_endpoint_snapshot.csv", [["snapshot_date", "string"], ["endpoint_type", "string"]], { filter: SNAPSHOT, computed: [["endpoint_type == 'server' ? 1 : 0", "servers"]], summarize: "sum(servers)" })),
    stat("Not in good health", { x: 8, y: 2, w: 4, h: 4 }, csv("A", "fact_endpoint_snapshot.csv", [["snapshot_date", "string"], ["health_overall", "string"]], { filter: SNAPSHOT, computed: [["health_overall != 'good' ? 1 : 0", "unhealthy"]], summarize: "sum(unhealthy)" }), { color: "red" }),
    stat("Not seen 7+ days", { x: 12, y: 2, w: 4, h: 4 }, csv("A", "fact_endpoint_snapshot.csv", [["snapshot_date", "string"], ["days_since_seen", "number"]], { filter: SNAPSHOT, computed: [["days_since_seen >= 7 ? 1 : 0", "stale"]], summarize: "sum(stale)" }), { color: "orange" }),
    stat("Tamper protection off", { x: 16, y: 2, w: 4, h: 4 }, csv("A", "fact_endpoint_snapshot.csv", [["snapshot_date", "string"], ["tamper_protection_enabled", "string"]], { filter: SNAPSHOT, computed: [["tamper_protection_enabled == 'false' ? 1 : 0", "off"]], summarize: "sum(off)" }), { color: "orange" }),
    stat("Isolated", { x: 20, y: 2, w: 4, h: 4 }, csv("A", "fact_endpoint_snapshot.csv", [["snapshot_date", "string"], ["isolation_status", "string"]], { filter: SNAPSHOT, computed: [["isolation_status == 'isolated' ? 1 : 0", "isolated"]], summarize: "sum(isolated)" })),
    pie("Health", { x: 0, y: 6, w: 6, h: 8 }, csv("A", "fact_endpoint_snapshot.csv", [["snapshot_date", "string"], ["health_overall", "string"], ["endpoint_id", "string"]], { filter: SNAPSHOT, summarize: "count(endpoint_id)", by: "health_overall", alias: "endpoints" }), { good: "green", suspicious: "orange", bad: "red", unknown: "text" }),
    bars("Operating systems", { x: 6, y: 6, w: 9, h: 8 }, [csv("A", "fact_endpoint_snapshot.csv", [["snapshot_date", "string"], ["os_name", "string"], ["endpoint_id", "string"]], { filter: SNAPSHOT, summarize: "count(endpoint_id)", by: "os_name", alias: "endpoints" })], { xField: "os_name", color: "blue", transformations: [{ id: "sortBy", options: { fields: {}, sort: [{ field: "endpoints", desc: true }] } }] }),
    bars("Core agent versions", { x: 15, y: 6, w: 9, h: 8 }, [csv("A", "fact_endpoint_snapshot.csv", [["snapshot_date", "string"], ["core_agent_version", "string"], ["endpoint_id", "string"]], { filter: SNAPSHOT, summarize: "count(endpoint_id)", by: "core_agent_version", alias: "endpoints" })], { xField: "core_agent_version", color: "purple", transformations: [{ id: "sortBy", options: { fields: {}, sort: [{ field: "endpoints", desc: true }] } }] }),
    table(
      "Endpoints needing attention",
      { x: 0, y: 14, w: 14, h: 9 },
      csv("A", "fact_endpoint_snapshot.csv", [["snapshot_date", "string"], ["endpoint_id", "string"], ["hostname", "string"], ["endpoint_type", "string"], ["os_name", "string"], ["health_overall", "string"], ["days_since_seen", "number"], ["tamper_protection_enabled", "string"], ["group_name", "string"]], {
        filter: `${SNAPSHOT} && (health_overall != 'good' || days_since_seen >= 7 || tamper_protection_enabled == 'false')`,
      }),
      {
        sort: [{ field: "days_since_seen", desc: true }],
        hide: ["snapshot_date"],
        order: ["hostname", "endpoint_id", "endpoint_type", "os_name", "health_overall", "days_since_seen", "tamper_protection_enabled", "group_name"],
        rename: { endpoint_id: "Endpoint ID", hostname: "Hostname", endpoint_type: "Type", os_name: "OS", health_overall: "Health", days_since_seen: "Days since seen", tamper_protection_enabled: "Tamper protection", group_name: "Group" },
        description: "Hostnames stay empty unless the exporter's personal data switch is on.",
      }
    ),
    bars("Account Health Check scores", { x: 14, y: 14, w: 10, h: 9 }, [csv("A", "fact_health_check_snapshot.csv", [["snapshot_date", "string"], ["area", "string"], ["scope", "string"], ["score", "number"]], { filter: SNAPSHOT, computed: [["area + ': ' + scope", "check", "string"]] })], {
      xField: "check",
      color: "green",
      unit: "percent",
      transformations: [
        { id: "organize", options: { excludeByName: { snapshot_date: true, area: true, scope: true }, indexByName: { check: 0, score: 1 }, renameByName: {} } },
        { id: "sortBy", options: { fields: {}, sort: [{ field: "score" }] } },
      ],
    }),
    table(
      "Licenses",
      { x: 0, y: 23, w: 14, h: 9 },
      csv("A", "fact_license.csv", [["snapshot_date", "string"], ["product_name", "string"], ["license_code", "string"], ["license_type", "string"], ["quantity", "number"], ["used", "number"], ["end_date", "string"], ["days_to_end", "number"]], { filter: SNAPSHOT }),
      {
        sort: [{ field: "days_to_end" }],
        hide: ["snapshot_date"],
        order: ["product_name", "license_code", "license_type", "quantity", "used", "end_date", "days_to_end"],
        rename: { product_name: "Product", license_code: "Code", license_type: "Type", quantity: "Quantity", used: "Used", end_date: "Ends", days_to_end: "Days left" },
      }
    ),
    stackedDaily("Alerts raised per day by severity", { x: 14, y: 23, w: 10, h: 9 }, csv("A", "fact_alert.csv", [["raised_local_date", "string"], ["severity", "string"], ["alert_id", "string"]]), "raised_local_date", "severity", ["count", "alert_id"], ALERT_COLORS),
    table(
      "Alerts",
      { x: 0, y: 32, w: 24, h: 9 },
      csv("A", "fact_alert.csv", [["raised_at", "string"], ["severity", "string"], ["category", "string"], ["product", "string"], ["alert_type", "string"], ["last_seen_open_at", "string"], ["raised_date_key", "number"]], { filter: RANGE("raised_date_key") }),
      { sort: [{ field: "raised_at", desc: true }], hide: ["raised_date_key"], order: ["raised_at", "severity", "category", "product", "alert_type", "last_seen_open_at"], rename: { raised_at: "Raised (UTC)", severity: "Severity", category: "Category", product: "Product", alert_type: "Type", last_seen_open_at: "Last seen open (UTC)" } }
    ),
  ],
  { templating: [snapshotVariable] }
);

// ---------- AI Defense ----------
nextId = 1;
const AI_SNAPSHOT = "snapshot_date =~ '^${ai_snapshot}$'";
const aiSnapshotVariable = {
  ...snapshotVariable,
  name: "ai_snapshot",
  query: { refId: "snapshots", queryType: "infinity", infinityQuery: csv("snapshots", "fact_ai_defense_snapshot.csv", [["snapshot_date", "string"]]) },
  description: "The AI application, user and license snapshot to show. The newest is picked on load.",
};
const actionLabel = ["action == '' ? 'Not reported' : action", "action_label", "string"];
const aiBoard = dashboard(
  "fusion-ai-defense",
  "Fusion Export: AI Defense",
  "Sophos AI Defense: AI application use, what policies blocked or warned, sanctioning status, users and policies.",
  [
    text({ x: 0, y: 0, w: 24, h: 2 }, `${NOTE} Activity panels follow the time range; the application, user and license panels show the snapshot picked above, which covers the exporter's inventory window (30 days by default).`),
    stat("AI activities", { x: 0, y: 2, w: 4, h: 4 }, csv("A", "fact_ai_activity_daily.csv", [["date_key", "number"], ["activities", "number"]], { filter: RANGE("date_key"), summarize: "sum(activities)" }), { unit: "short", description: "Activities that started in the time range." }),
    stat("Blocked", { x: 4, y: 2, w: 4, h: 4 }, csv("A", "fact_ai_activity_daily.csv", [["date_key", "number"], ["action", "string"], ["activities", "number"]], { filter: `${RANGE("date_key")} && action == 'BLOCKED'`, summarize: "sum(activities)" }), { unit: "short", color: "red" }),
    stat("Warned", { x: 8, y: 2, w: 4, h: 4 }, csv("A", "fact_ai_activity_daily.csv", [["date_key", "number"], ["action", "string"], ["activities", "number"]], { filter: `${RANGE("date_key")} && action == 'WARNED'`, summarize: "sum(activities)" }), { unit: "short", color: "orange" }),
    stat("Unsanctioned", { x: 12, y: 2, w: 4, h: 4 }, csv("A", "fact_ai_activity_daily.csv", [["date_key", "number"], ["unsanctioned_activities", "number"]], { filter: RANGE("date_key"), summarize: "sum(unsanctioned_activities)" }), { unit: "short", color: "purple", description: "Allowed activity for apps no policy covers." }),
    stat("AI apps in use", { x: 16, y: 2, w: 4, h: 4 }, csv("A", "fact_ai_defense_snapshot.csv", [["snapshot_date", "string"], ["apps", "number"]], { filter: AI_SNAPSHOT, summarize: "sum(apps)" }), { description: "Applications in the inventory window of the snapshot, as Sophos counts them." }),
    stat("AI users", { x: 20, y: 2, w: 4, h: 4 }, csv("A", "fact_ai_defense_snapshot.csv", [["snapshot_date", "string"], ["users", "number"]], { filter: AI_SNAPSHOT, summarize: "sum(users)" }), { description: "Users in the inventory window of the snapshot, as Sophos counts them." }),
    stackedDaily("AI activity per day by action", { x: 0, y: 6, w: 12, h: 9 }, csv("A", "fact_ai_activity_daily.csv", [["local_date", "string"], ["action", "string"], ["activities", "number"]], { computed: [actionLabel] }), "local_date", "action_label", ["sum", "activities"], ACTION_COLORS),
    pie("Activity by risk", { x: 12, y: 6, w: 6, h: 9 }, csv("A", "fact_ai_activity_daily.csv", [["risk", "string"], ["date_key", "number"], ["activities", "number"]], { filter: RANGE("date_key"), summarize: "sum(activities)", by: "risk", alias: "activities" }), RISK_COLORS),
    bars("Activity by AI application", { x: 0, y: 15, w: 12, h: 9 }, [csv("A", "fact_ai_activity_daily.csv", [["application_name", "string"], ["date_key", "number"], ["activities", "number"]], { filter: RANGE("date_key"), summarize: "sum(activities)", by: "application_name", alias: "activities" })], {
      xField: "application_name",
      color: "blue",
      transformations: [{ id: "sortBy", options: { fields: {}, sort: [{ field: "activities", desc: true }] } }, { id: "limit", options: { limitField: 12 } }],
    }),
    bars("Blocked and warned by application", { x: 12, y: 15, w: 12, h: 9 }, [csv("A", "fact_ai_activity_daily.csv", [["application_name", "string"], ["date_key", "number"], ["action", "string"], ["activities", "number"]], { filter: `${RANGE("date_key")} && (action == 'BLOCKED' || action == 'WARNED')`, summarize: "sum(activities)", by: "application_name", alias: "activities" })], {
      xField: "application_name",
      color: "red",
      transformations: [{ id: "sortBy", options: { fields: {}, sort: [{ field: "activities", desc: true }] } }, { id: "limit", options: { limitField: 12 } }],
      description: "Activities the tenant's AI Defense policies blocked or warned on.",
    }),
    table(
      "AI applications and sanctioning",
      { x: 0, y: 24, w: 24, h: 10 },
      csv("A", "fact_ai_app_snapshot.csv", [["snapshot_date", "string"], ["application_name", "string"], ["provider", "string"], ["risk", "string"], ["sanctioning_status", "string"], ["activities", "number"], ["unique_users", "number"], ["unsanctioned_activities", "number"], ["last_seen_at", "string"]], { filter: AI_SNAPSHOT }),
      {
        sort: [{ field: "activities", desc: true }],
        hide: ["snapshot_date"],
        order: ["application_name", "provider", "risk", "sanctioning_status", "activities", "unique_users", "unsanctioned_activities", "last_seen_at"],
        rename: { application_name: "Application", provider: "Provider", risk: "Risk", sanctioning_status: "Sanctioning", activities: "Activities", unique_users: "Users", unsanctioned_activities: "Unsanctioned", last_seen_at: "Last seen (UTC)" },
        description: "The snapshot's inventory window. Sanctioning is what the tenant's policies give each application.",
      }
    ),
    pie("Applications by sanctioning status", { x: 18, y: 6, w: 6, h: 9 }, csv("A", "fact_ai_app_snapshot.csv", [["snapshot_date", "string"], ["sanctioning_status", "string"], ["application_id", "string"]], { filter: AI_SNAPSHOT, summarize: "count(application_id)", by: "sanctioning_status", alias: "applications" }), SANCTION_COLORS),
    table(
      "Users, highest risk first",
      { x: 0, y: 34, w: 24, h: 10 },
      csv("A", "fact_ai_user_snapshot.csv", [["snapshot_date", "string"], ["user_key", "string"], ["user_name", "string"], ["risk", "string"], ["risk_rank", "number"], ["apps_used", "number"], ["activities", "number"], ["policy_violations", "number"], ["top_app_name", "string"], ["last_seen_at", "string"]], { filter: AI_SNAPSHOT }),
      {
        sort: [{ field: "risk_rank", desc: true }, { field: "policy_violations", desc: true }],
        hide: ["snapshot_date", "risk_rank"],
        order: ["user_name", "user_key", "risk", "apps_used", "activities", "policy_violations", "top_app_name", "last_seen_at"],
        rename: { user_name: "User", user_key: "User key", risk: "Risk", apps_used: "Apps", activities: "Activities", policy_violations: "Blocked or warned", top_app_name: "Top app", last_seen_at: "Last seen (UTC)" },
        description: "User names stay empty unless the exporter's personal data switch is on; the user key is a hash that matches across tables.",
      }
    ),
    table(
      "Policies, in the order Sophos checks them",
      { x: 0, y: 44, w: 24, h: 7 },
      csv("A", "dim_ai_policy.csv", [["rank", "number"], ["policy_name", "string"], ["state", "string"], ["enforcement_status", "string"], ["origin", "string"], ["block_rules", "number"], ["warn_rules", "number"], ["allow_rules", "number"], ["generative_ai_category_action", "string"]]),
      {
        sort: [{ field: "rank" }],
        order: ["rank", "policy_name", "state", "enforcement_status", "origin", "block_rules", "warn_rules", "allow_rules", "generative_ai_category_action"],
        rename: { rank: "Rank", policy_name: "Policy", state: "State", enforcement_status: "Enforcement", origin: "Origin", block_rules: "Block rules", warn_rules: "Warn rules", allow_rules: "Allow rules", generative_ai_category_action: "Other Generative AI" },
      }
    ),
    table(
      "Latest blocked and warned activity",
      { x: 0, y: 51, w: 24, h: 10 },
      csv("A", "fact_ai_activity.csv", [["start_time", "string"], ["start_date_key", "number"], ["application_name", "string"], ["action", "string"], ["risk", "string"], ["policy_name", "string"], ["actor_type", "string"], ["device_type", "string"], ["sensor_types", "string"], ["records", "number"]], { filter: `${RANGE("start_date_key")} && (action == 'BLOCKED' || action == 'WARNED')` }),
      {
        sort: [{ field: "start_time", desc: true }],
        limit: 50,
        hide: ["start_date_key"],
        order: ["start_time", "application_name", "action", "risk", "policy_name", "actor_type", "device_type", "sensor_types", "records"],
        rename: { start_time: "Started (UTC)", application_name: "Application", action: "Action", risk: "Risk", policy_name: "Policy", actor_type: "Actor", device_type: "Device", sensor_types: "Seen by", records: "Records" },
        description: "The 50 most recent in the time range. Activity detail is kept for 90 days by default.",
      }
    ),
  ],
  { templating: [aiSnapshotVariable] }
);

const out = new URL("../grafana/dashboards/", import.meta.url);
for (const [file, board] of [["overview.json", overview], ["cases.json", casesBoard], ["detections.json", detectionsBoard], ["endpoints.json", endpointsBoard], ["ai-defense.json", aiBoard]]) {
  writeFileSync(new URL(file, out), `${JSON.stringify(board, null, 2)}\n`);
  console.log(`wrote grafana/dashboards/${file}: ${board.panels.length} panels`);
}
