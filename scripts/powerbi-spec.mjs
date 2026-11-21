/**
 * What the Power BI templates hold beyond the tables: measures,
 * relationships, the direct path's Power Query, and the report pages.
 * Read by scripts/build-powerbi.mjs.
 */

// ---------- tables in the CSV model ----------

export const CSV_TABLES = [
  "dim_tenant",
  "fact_license",
  "fact_case",
  "dim_case_type",
  "dim_case_status",
  "dim_case_verdict",
  "fact_detection",
  "bridge_detection_technique",
  "bridge_detection_sensor",
  "bridge_detection_entity",
  "dim_detector",
  "dim_mitre_technique",
  "dim_sensor_type",
  "fact_detection_daily",
  "fact_technique_daily",
  "fact_sensor_daily",
  "fact_endpoint_snapshot",
  "fact_health_check_snapshot",
  "fact_alert",
];

// ---------- relationships (many side first) ----------

export const RELATIONSHIPS = [
  { from: ["fact_detection", "detector_id"], to: ["dim_detector", "detector_id"] },
  { from: ["fact_detection_daily", "detector_id"], to: ["dim_detector", "detector_id"] },
  { from: ["bridge_detection_technique", "detection_id"], to: ["fact_detection", "detection_id"] },
  { from: ["bridge_detection_technique", "technique_id"], to: ["dim_mitre_technique", "technique_id"] },
  { from: ["bridge_detection_sensor", "detection_id"], to: ["fact_detection", "detection_id"] },
  { from: ["bridge_detection_sensor", "sensor_type"], to: ["dim_sensor_type", "sensor_type"] },
  { from: ["bridge_detection_entity", "detection_id"], to: ["fact_detection", "detection_id"] },
  { from: ["fact_technique_daily", "technique_id"], to: ["dim_mitre_technique", "technique_id"] },
  { from: ["fact_sensor_daily", "sensor_type"], to: ["dim_sensor_type", "sensor_type"] },
  { from: ["fact_case", "case_type_id"], to: ["dim_case_type", "case_type_id"] },
  { from: ["fact_case", "primary_status_id"], to: ["dim_case_status", "status_id"] },
  { from: ["fact_case", "created_local_date"], to: ["Date", "Date"] },
  { from: ["fact_case", "closed_local_date"], to: ["Date", "Date"], inactive: true },
  { from: ["fact_detection", "created_local_date"], to: ["Date", "Date"] },
  { from: ["fact_detection_daily", "local_date"], to: ["Date", "Date"] },
  { from: ["fact_technique_daily", "local_date"], to: ["Date", "Date"] },
  { from: ["fact_sensor_daily", "local_date"], to: ["Date", "Date"] },
  { from: ["fact_alert", "raised_local_date"], to: ["Date", "Date"] },
  { from: ["fact_endpoint_snapshot", "snapshot_date"], to: ["Date", "Date"] },
  { from: ["fact_license", "snapshot_date"], to: ["Date", "Date"] },
  { from: ["fact_health_check_snapshot", "snapshot_date"], to: ["Date", "Date"] },
];

// ---------- measures ----------

const latest = (table, filter) =>
  `VAR LatestSnapshot = MAX(${table}[snapshot_date])\nRETURN CALCULATE(COUNTROWS(${table}), ${table}[snapshot_date] = LatestSnapshot${filter ? `, ${filter}` : ""}) + 0`;

export const MEASURES = {
  fact_case: [
    { name: "Cases", dax: "COUNTROWS(fact_case) + 0", format: "0", description: "Cases created in the selected dates." },
    { name: "Open cases", dax: "CALCULATE(COUNTROWS(fact_case), fact_case[is_closed] == FALSE(), REMOVEFILTERS('Date')) + 0", format: "0", description: "Cases not closed, whatever dates are selected." },
    { name: "Closed cases", dax: "CALCULATE(COUNTROWS(fact_case), USERELATIONSHIP(fact_case[closed_local_date], 'Date'[Date]), fact_case[is_closed] == TRUE()) + 0", format: "0", description: "Cases closed in the selected dates." },
    { name: "Mean hours to close", dax: "CALCULATE(DIVIDE(AVERAGE(fact_case[minutes_to_close]), 60), USERELATIONSHIP(fact_case[closed_local_date], 'Date'[Date]))", format: "0.0", description: "Created to closed, for cases closed in the selected dates. Sophos sends no first response time." },
    { name: "Median hours to close", dax: "CALCULATE(DIVIDE(MEDIAN(fact_case[minutes_to_close]), 60), USERELATIONSHIP(fact_case[closed_local_date], 'Date'[Date]))", format: "0.0", description: "Median created to closed, for cases closed in the selected dates." },
    { name: "Mean open case age (days)", dax: "CALCULATE(AVERAGE(fact_case[age_days]), fact_case[is_closed] == FALSE(), REMOVEFILTERS('Date'))", format: "0.0", description: "Days since creation of the cases still open, as of the last export." },
    { name: "Provider managed share", dax: "DIVIDE(CALCULATE(COUNTROWS(fact_case), fact_case[managed_by] = \"PROVIDER\"), COUNTROWS(fact_case))", format: "0%", description: "Share of cases Sophos MDR or the partner manages." },
  ],
  fact_detection_daily: [
    { name: "Total detections", dax: "SUM(fact_detection_daily[detections]) + 0", format: "#,0", description: "Detections created in the selected dates (daily counts, kept past detail retention)." },
    { name: "High and critical detections", dax: "CALCULATE(SUM(fact_detection_daily[detections]), fact_detection_daily[severity_rank] >= 4) + 0", format: "#,0", description: "Detections with severity 0.6 and up." },
    { name: "Open detections", dax: "SUM(fact_detection_daily[open_detections]) + 0", format: "#,0", description: "Detections from the selected dates still OPEN at the last export." },
  ],
  fact_detection: [{ name: "Detection rows", dax: "COUNTROWS(fact_detection) + 0", format: "#,0", description: "Detection detail rows (kept for the retention period)." }],
  fact_technique_daily: [{ name: "Technique detections", dax: "SUM(fact_technique_daily[detections]) + 0", format: "#,0", description: "Detections naming the technique, in the selected dates." }],
  fact_sensor_daily: [{ name: "Sensor detections", dax: "SUM(fact_sensor_daily[detections]) + 0", format: "#,0", description: "Detections from the sensor type, in the selected dates." }],
  fact_endpoint_snapshot: [
    { name: "Endpoints", dax: latest("fact_endpoint_snapshot"), format: "0", description: "Endpoints in the latest snapshot of the selected dates." },
    { name: "Endpoints not in good health", dax: latest("fact_endpoint_snapshot", 'fact_endpoint_snapshot[health_overall] <> "good"'), format: "0", description: "Latest snapshot, overall health not good." },
    { name: "Endpoints not seen 7+ days", dax: latest("fact_endpoint_snapshot", "fact_endpoint_snapshot[days_since_seen] >= 7"), format: "0", description: "Latest snapshot, last seen a week or more before it." },
    { name: "Tamper protection off", dax: latest("fact_endpoint_snapshot", "fact_endpoint_snapshot[tamper_protection_enabled] == FALSE()"), format: "0", description: "Latest snapshot, tamper protection off." },
  ],
  fact_license: [
    { name: "Licensed quantity", dax: "VAR LatestSnapshot = MAX(fact_license[snapshot_date])\nRETURN CALCULATE(SUM(fact_license[quantity]), fact_license[snapshot_date] = LatestSnapshot)", format: "#,0", description: "Licensed quantity in the latest snapshot. Unlimited licenses have none." },
    { name: "Licenses used", dax: "VAR LatestSnapshot = MAX(fact_license[snapshot_date])\nRETURN CALCULATE(SUM(fact_license[used]), fact_license[snapshot_date] = LatestSnapshot)", format: "#,0", description: "Usage Sophos reports, latest snapshot." },
  ],
  fact_health_check_snapshot: [
    { name: "Mean health check score", dax: "VAR LatestSnapshot = MAX(fact_health_check_snapshot[snapshot_date])\nRETURN CALCULATE(AVERAGE(fact_health_check_snapshot[score]), fact_health_check_snapshot[snapshot_date] = LatestSnapshot)", format: "0", description: "Mean Account Health Check score, latest snapshot." },
  ],
  fact_alert: [
    { name: "Alerts", dax: "COUNTROWS(fact_alert) + 0", format: "0", description: "Product alerts raised in the selected dates." },
    { name: "High alerts", dax: "CALCULATE(COUNTROWS(fact_alert), fact_alert[severity] = \"high\") + 0", format: "0", description: "High severity product alerts raised in the selected dates." },
  ],
};

// ---------- the direct path: Power Query reading the Sophos APIs ----------

const helpers = `    Get = (r, path as list) => List.Accumulate(path, r, (s, k) => if s = null then null else if Value.Is(s, type record) then Record.FieldOrDefault(s, k, null) else null),
    Iso = (t) => if t = null then null else DateTimeZone.RemoveZone(DateTimeZone.SwitchZone(DateTimeZone.FromText(t), 0)),
    Epoch = (s) => if s = null then null else #datetime(1970, 1, 1, 0, 0, 0) + #duration(0, 0, 0, s),`;

const typed = (columns) => `{${columns.map(([n, t]) => `{"${n}", ${t}}`).join(", ")}}`;

function directM(body, columns) {
  return [
    "let",
    helpers,
    ...body,
    `    Table = Table.FromRecords(Rows, {${columns.map(([n]) => `"${n}"`).join(", ")}}, MissingField.UseNull),`,
    `    Typed = Table.TransformColumnTypes(Table, ${typed(columns)}, "en-US")`,
    "in",
    "    Typed",
  ];
}

const CASE_COLUMNS = [
  ["tenant_id", "type text"],
  ["case_id", "type text"],
  ["short_id", "type text"],
  ["severity", "Int64.Type"],
  ["severity_label", "type text"],
  ["case_type", "type text"],
  ["primary_status", "type text"],
  ["is_closed", "type logical"],
  ["primary_verdict", "type text"],
  ["managed_by", "type text"],
  ["created_at", "type datetime"],
  ["created_local_date", "type date"],
  ["closed_at", "type datetime"],
  ["closed_local_date", "type date"],
  ["minutes_to_close", "Int64.Type"],
  ["age_days", "type number"],
  ["detections_count", "Int64.Type"],
  ["api_version", "type text"],
];

const DETECTION_COLUMNS = [
  ["tenant_id", "type text"],
  ["detection_id", "type text"],
  ["created_at", "type datetime"],
  ["created_local_date", "type date"],
  ["severity", "type number"],
  ["severity_band", "type text"],
  ["severity_rank", "Int64.Type"],
  ["confidence", "type number"],
  ["status", "type text"],
  ["detector_id", "type text"],
  ["title", "type text"],
  ["technique_count", "Int64.Type"],
];

const ENDPOINT_COLUMNS = [
  ["tenant_id", "type text"],
  ["snapshot_date", "type date"],
  ["endpoint_id", "type text"],
  ["endpoint_type", "type text"],
  ["os_platform", "type text"],
  ["os_name", "type text"],
  ["health_overall", "type text"],
  ["last_seen_at", "type datetime"],
  ["days_since_seen", "type number"],
  ["tamper_protection_enabled", "type logical"],
  ["isolation_status", "type text"],
  ["group_name", "type text"],
];

const ALERT_COLUMNS = [
  ["tenant_id", "type text"],
  ["alert_id", "type text"],
  ["raised_at", "type datetime"],
  ["raised_local_date", "type date"],
  ["severity", "type text"],
  ["category", "type text"],
  ["product", "type text"],
  ["alert_type", "type text"],
];

const LICENSE_COLUMNS = [
  ["tenant_id", "type text"],
  ["snapshot_date", "type date"],
  ["license_id", "type text"],
  ["license_code", "type text"],
  ["product_name", "type text"],
  ["license_type", "type text"],
  ["quantity", "Int64.Type"],
  ["used", "Int64.Type"],
  ["end_date", "type date"],
];

export const DIRECT = [
  {
    table: "fact_case",
    columns: CASE_COLUMNS.map(([n]) => n),
    m: directM(
      [
        "    Fetch = (cursor) => FusionQuery(DocCases, [arguments = [query = \"\", pagination = [cursor = if cursor = null then [first = 100] else [first = 100, after = cursor]]]])[cases],",
        "    Pages = List.Generate(() => [page = Fetch(null), n = 1], each [page] <> null, each if [page][pageInfo][hasNextPage] and [n] < 200 then [page = Fetch([page][pageInfo][endCursor]), n = [n] + 1] else [page = null, n = [n]], each [page][cases]),",
        "    Now = DateTimeZone.RemoveZone(DateTimeZone.UtcNow()),",
        "    Rows = List.Transform(List.Combine(Pages), (c) => [",
        "        tenant_id = SophosTenantId,",
        "        case_id = c[id],",
        "        short_id = Get(c, {\"shortId\"}),",
        "        severity = Get(c, {\"severity\"}),",
        "        severity_label = if severity = 10 then \"Critical\" else if severity = 8 then \"High\" else if severity = 6 then \"Medium\" else if severity = 4 then \"Low\" else if severity = 2 then \"Informational\" else \"Not set\",",
        "        case_type = Get(c, {\"type\", \"title\"}),",
        "        primary_status = Get(c, {\"primaryStatus\", \"title\"}),",
        "        is_closed = Get(c, {\"primaryStatus\", \"isClosed\"}),",
        "        primary_verdict = Get(c, {\"primaryVerdict\", \"title\"}),",
        "        managed_by = Get(c, {\"managedBy\"}),",
        "        created_at = Iso(Get(c, {\"createdAt\"})),",
        "        created_local_date = if created_at = null then null else Date.From(created_at),",
        "        closed_at = Iso(Get(c, {\"closedAt\"})),",
        "        closed_local_date = if closed_at = null then null else Date.From(closed_at),",
        "        minutes_to_close = if closed_at = null or created_at = null then null else Number.Round(Duration.TotalMinutes(closed_at - created_at)),",
        "        age_days = if created_at = null then null else Number.Round(Duration.TotalDays((if closed_at = null then Now else closed_at) - created_at), 2),",
        "        detections_count = Get(c, {\"detectionsCount\"}),",
        "        api_version = \"v2\"",
        "    ]),",
      ],
      CASE_COLUMNS
    ),
  },
  {
    table: "fact_detection",
    columns: DETECTION_COLUMNS.map(([n]) => n),
    m: directM(
      [
        "    Days = List.Max({1, List.Min({30, Number.From(DetectionDays)})}),",
        "    Ql = \"FROM alert WHERE severity >= 0 EARLIEST=-\" & Text.From(Days) & \"d\",",
        "    Found = Get(FusionQuery(DocDetections, [in = [cql_query = Ql, limit = 10000, offset = 0]]), {\"detectionSearch\", \"alerts\", \"list\"}),",
        "    Band = (s) => if s = null then \"Info\" else if s >= 0.8 then \"Critical\" else if s >= 0.6 then \"High\" else if s >= 0.4 then \"Medium\" else if s >= 0.2 then \"Low\" else \"Info\",",
        "    Rank = [Critical = 5, High = 4, Medium = 3, Low = 2, Info = 1],",
        "    Rows = List.Transform(if Found = null then {} else Found, (d) => [",
        "        tenant_id = SophosTenantId,",
        "        detection_id = d[id],",
        "        created_at = Epoch(Get(d, {\"metadata\", \"created_at\", \"seconds\"})),",
        "        created_local_date = if created_at = null then null else Date.From(created_at),",
        "        severity = Get(d, {\"metadata\", \"severity\"}),",
        "        severity_band = Band(severity),",
        "        severity_rank = Record.Field(Rank, severity_band),",
        "        confidence = Get(d, {\"metadata\", \"confidence\"}),",
        "        status = Get(d, {\"status\"}),",
        "        detector_id = Get(d, {\"metadata\", \"creator\", \"detector\", \"detector_id\"}),",
        "        title = Get(d, {\"metadata\", \"title\"}),",
        "        technique_count = List.Count(List.RemoveNulls(if Get(d, {\"attack_technique_ids\"}) = null then {} else d[attack_technique_ids]))",
        "    ]),",
      ],
      DETECTION_COLUMNS
    ),
  },
  {
    table: "fact_endpoint_snapshot",
    columns: ENDPOINT_COLUMNS.map(([n]) => n),
    m: directM(
      [
        "    Fetch = (key) => SophosGet(\"endpoint/v1/endpoints\", if key = null then [pageSize = \"500\"] else [pageSize = \"500\", pageFromKey = key]),",
        "    Pages = List.Generate(() => [p = Fetch(null), n = 1], each [p] <> null, each let next = Get([p], {\"pages\", \"nextKey\"}) in if next <> null and [n] < 200 then [p = Fetch(next), n = [n] + 1] else [p = null, n = [n]], each Get([p], {\"items\"})),",
        "    Now = DateTimeZone.RemoveZone(DateTimeZone.UtcNow()),",
        "    Rows = List.Transform(List.Combine(List.RemoveNulls(Pages)), (e) => [",
        "        tenant_id = SophosTenantId,",
        "        snapshot_date = Date.From(Now),",
        "        endpoint_id = e[id],",
        "        endpoint_type = Get(e, {\"type\"}),",
        "        os_platform = Get(e, {\"os\", \"platform\"}),",
        "        os_name = let n = Get(e, {\"os\", \"name\"}) in if n = null then null else Text.Trim(n),",
        "        health_overall = Get(e, {\"health\", \"overall\"}),",
        "        last_seen_at = Iso(Get(e, {\"lastSeenAt\"})),",
        "        days_since_seen = if last_seen_at = null then null else Number.Round(Duration.TotalDays(Now - last_seen_at), 2),",
        "        tamper_protection_enabled = Get(e, {\"tamperProtectionEnabled\"}),",
        "        isolation_status = Get(e, {\"isolation\", \"status\"}),",
        "        group_name = Get(e, {\"group\", \"name\"})",
        "    ]),",
      ],
      ENDPOINT_COLUMNS
    ),
  },
  {
    table: "fact_alert",
    columns: ALERT_COLUMNS.map(([n]) => n),
    m: directM(
      [
        "    Fetch = (key) => SophosGet(\"common/v1/alerts\", if key = null then [pageSize = \"1000\"] else [pageSize = \"1000\", pageFromKey = key]),",
        "    Pages = List.Generate(() => [p = Fetch(null), n = 1], each [p] <> null, each let next = Get([p], {\"pages\", \"nextKey\"}) in if next <> null and [n] < 100 then [p = Fetch(next), n = [n] + 1] else [p = null, n = [n]], each Get([p], {\"items\"})),",
        "    Rows = List.Transform(List.Combine(List.RemoveNulls(Pages)), (a) => [",
        "        tenant_id = SophosTenantId,",
        "        alert_id = a[id],",
        "        raised_at = Iso(Get(a, {\"raisedAt\"})),",
        "        raised_local_date = if raised_at = null then null else Date.From(raised_at),",
        "        severity = Get(a, {\"severity\"}),",
        "        category = Get(a, {\"category\"}),",
        "        product = Get(a, {\"product\"}),",
        "        alert_type = Get(a, {\"type\"})",
        "    ]),",
      ],
      ALERT_COLUMNS
    ),
  },
  {
    table: "fact_license",
    columns: LICENSE_COLUMNS.map(([n]) => n),
    m: directM(
      [
        "    Body = Json.Document(Web.Contents(\"https://api.central.sophos.com\", [RelativePath = \"licenses/v1/licenses\", Headers = [Authorization = \"Bearer \" & SophosToken, #\"X-Tenant-ID\" = SophosTenantId]])),",
        "    Today = Date.From(DateTimeZone.UtcNow()),",
        "    Rows = List.Transform(List.Select(if Get(Body, {\"licenses\"}) = null then {} else Body[licenses], each Get(_, {\"product\", \"code\"}) <> null), (l) => [",
        "        tenant_id = SophosTenantId,",
        "        snapshot_date = Today,",
        "        license_id = Get(l, {\"id\"}),",
        "        license_code = Get(l, {\"product\", \"code\"}),",
        "        product_name = Get(l, {\"product\", \"name\"}),",
        "        license_type = Get(l, {\"type\"}),",
        "        quantity = if Get(l, {\"unlimited\"}) = true then null else Get(l, {\"quantity\"}),",
        "        used = Get(l, {\"usage\", \"current\", \"count\"}),",
        "        end_date = let d = Get(l, {\"endDate\"}) in if d = null or Get(l, {\"perpetual\"}) = true then null else Date.FromText(d, [Format = \"yyyy-MM-dd\"])",
        "    ]),",
      ],
      LICENSE_COLUMNS
    ),
  },
];

// ---------- report pages ----------

const card = (id, x, y, measure, title) => ({ id, type: "card", x, y, w: 152, h: 96, title, roles: { Values: [measure] } });
const slicer = (id, x, y, w = 304) => ({ id, type: "slicer", x, y, w, h: 96, title: "Dates", roles: { Values: ["Date.Date"] } });

export const PAGES_CSV = [
  {
    id: "overview",
    name: "Overview",
    visuals: [
      card("ovCases", 16, 56, "fact_case.[Open cases]", "Open cases"),
      card("ovDet", 176, 56, "fact_detection_daily.[Total detections]", "Detections"),
      card("ovHigh", 336, 56, "fact_detection_daily.[High and critical detections]", "High and critical"),
      card("ovEp", 496, 56, "fact_endpoint_snapshot.[Endpoints]", "Endpoints"),
      card("ovUnh", 656, 56, "fact_endpoint_snapshot.[Endpoints not in good health]", "Not in good health"),
      card("ovStale", 816, 56, "fact_endpoint_snapshot.[Endpoints not seen 7+ days]", "Not seen 7+ days"),
      slicer("ovDates", 976, 56, 288),
      { id: "ovDetChart", type: "columnChart", x: 16, y: 168, w: 824, h: 264, title: "Detections per day by severity", roles: { Category: ["Date.Date"], Series: ["fact_detection_daily.severity_band as Severity"], Y: ["fact_detection_daily.[Total detections]"] } },
      { id: "ovCaseSev", type: "barChart", x: 856, y: 168, w: 408, h: 264, title: "Open cases by severity", roles: { Category: ["fact_case.severity_label as Severity"], Y: ["fact_case.[Open cases]"] } },
      { id: "ovTactic", type: "barChart", x: 16, y: 448, w: 624, h: 256, title: "Detections by ATT&CK tactic", roles: { Category: ["fact_technique_daily.tactic as Tactic"], Y: ["fact_technique_daily.[Technique detections]"] }, sort: { field: "fact_technique_daily.[Technique detections]", desc: true } },
      { id: "ovHealth", type: "donutChart", x: 656, y: 448, w: 296, h: 256, title: "Endpoint health", roles: { Category: ["fact_endpoint_snapshot.health_overall as Health"], Y: ["fact_endpoint_snapshot.[Endpoints]"] } },
      { id: "ovManaged", type: "donutChart", x: 968, y: 448, w: 296, h: 256, title: "Cases by who manages them", roles: { Category: ["fact_case.managed_by as Managed by"], Y: ["fact_case.[Cases]"] } },
    ],
  },
  {
    id: "cases",
    name: "Cases",
    visuals: [
      card("caOpen", 16, 56, "fact_case.[Open cases]", "Open cases"),
      card("caNew", 176, 56, "fact_case.[Cases]", "Opened"),
      card("caClosed", 336, 56, "fact_case.[Closed cases]", "Closed"),
      card("caMean", 496, 56, "fact_case.[Mean hours to close]", "Mean hours to close"),
      card("caMedian", 656, 56, "fact_case.[Median hours to close]", "Median hours to close"),
      card("caAge", 816, 56, "fact_case.[Mean open case age (days)]", "Mean open case age (days)"),
      slicer("caDates", 976, 56, 288),
      { id: "caPerDay", type: "columnChart", x: 16, y: 168, w: 824, h: 248, title: "Cases opened per day by severity", roles: { Category: ["Date.Date"], Series: ["fact_case.severity_label as Severity"], Y: ["fact_case.[Cases]"] } },
      { id: "caStatus", type: "barChart", x: 856, y: 168, w: 408, h: 248, title: "Open cases by status", roles: { Category: ["fact_case.primary_status as Status"], Y: ["fact_case.[Open cases]"] }, sort: { field: "fact_case.[Open cases]", desc: true } },
      { id: "caTable", type: "tableEx", x: 16, y: 432, w: 1248, h: 272, title: "Cases", roles: { Values: ["fact_case.short_id as Case", "fact_case.severity_label as Severity", "fact_case.case_type as Type", "fact_case.primary_status as Status", "fact_case.primary_verdict as Verdict", "fact_case.managed_by as Managed by", "fact_case.created_local_date as Created", "fact_case.age_days as Age (days)", "fact_case.detections_count as Detections"] }, sort: { field: "fact_case.created_local_date", desc: true } },
    ],
  },
  {
    id: "detections",
    name: "Detections and ATT&CK",
    visuals: [
      card("deTotal", 16, 56, "fact_detection_daily.[Total detections]", "Detections"),
      card("deHigh", 176, 56, "fact_detection_daily.[High and critical detections]", "High and critical"),
      card("deOpen", 336, 56, "fact_detection_daily.[Open detections]", "Still open"),
      slicer("deDates", 496, 56, 768),
      { id: "deChart", type: "columnChart", x: 16, y: 168, w: 1248, h: 232, title: "Detections per day by severity", roles: { Category: ["Date.Date"], Series: ["fact_detection_daily.severity_band as Severity"], Y: ["fact_detection_daily.[Total detections]"] } },
      { id: "deDetectors", type: "barChart", x: 16, y: 416, w: 408, h: 288, title: "Top detectors", roles: { Category: ["dim_detector.detector_name as Detector"], Y: ["fact_detection_daily.[Total detections]"] }, sort: { field: "fact_detection_daily.[Total detections]", desc: true } },
      { id: "deTactics", type: "barChart", x: 440, y: 416, w: 408, h: 288, title: "Detections by ATT&CK tactic", roles: { Category: ["fact_technique_daily.tactic as Tactic"], Y: ["fact_technique_daily.[Technique detections]"] }, sort: { field: "fact_technique_daily.[Technique detections]", desc: true } },
      { id: "deSources", type: "barChart", x: 864, y: 416, w: 400, h: 288, title: "Detections by source", roles: { Category: ["dim_sensor_type.label as Source"], Y: ["fact_sensor_daily.[Sensor detections]"] }, sort: { field: "fact_sensor_daily.[Sensor detections]", desc: true } },
    ],
  },
  {
    id: "endpoints",
    name: "Endpoints and licenses",
    visuals: [
      card("epTotal", 16, 56, "fact_endpoint_snapshot.[Endpoints]", "Endpoints"),
      card("epUnh", 176, 56, "fact_endpoint_snapshot.[Endpoints not in good health]", "Not in good health"),
      card("epStale", 336, 56, "fact_endpoint_snapshot.[Endpoints not seen 7+ days]", "Not seen 7+ days"),
      card("epTamper", 496, 56, "fact_endpoint_snapshot.[Tamper protection off]", "Tamper protection off"),
      card("epScore", 656, 56, "fact_health_check_snapshot.[Mean health check score]", "Health check score"),
      slicer("epDates", 816, 56, 448),
      { id: "epOs", type: "barChart", x: 16, y: 168, w: 408, h: 256, title: "Operating systems", roles: { Category: ["fact_endpoint_snapshot.os_name as Operating system"], Y: ["fact_endpoint_snapshot.[Endpoints]"] }, sort: { field: "fact_endpoint_snapshot.[Endpoints]", desc: true } },
      { id: "epAgent", type: "barChart", x: 440, y: 168, w: 408, h: 256, title: "Core agent versions", roles: { Category: ["fact_endpoint_snapshot.core_agent_version as Core agent"], Y: ["fact_endpoint_snapshot.[Endpoints]"] }, sort: { field: "fact_endpoint_snapshot.[Endpoints]", desc: true } },
      { id: "epHealth", type: "donutChart", x: 864, y: 168, w: 400, h: 256, title: "Health", roles: { Category: ["fact_endpoint_snapshot.health_overall as Health"], Y: ["fact_endpoint_snapshot.[Endpoints]"] } },
      { id: "epLic", type: "tableEx", x: 16, y: 440, w: 1248, h: 264, title: "Licenses, latest snapshot", roles: { Values: ["fact_license.product_name as Product", "fact_license.license_code as Code", "fact_license.license_type as Type", "fact_license.end_date as Ends", "fact_license.[Licensed quantity]", "fact_license.[Licenses used]"] }, sort: { field: "fact_license.end_date", desc: false } },
    ],
  },
  {
    id: "alerts",
    name: "Alerts",
    visuals: [
      card("alTotal", 16, 56, "fact_alert.[Alerts]", "Alerts"),
      card("alHigh", 176, 56, "fact_alert.[High alerts]", "High alerts"),
      slicer("alDates", 336, 56, 928),
      { id: "alChart", type: "columnChart", x: 16, y: 168, w: 824, h: 248, title: "Alerts per day by severity", roles: { Category: ["Date.Date"], Series: ["fact_alert.severity as Severity"], Y: ["fact_alert.[Alerts]"] } },
      { id: "alCat", type: "barChart", x: 856, y: 168, w: 408, h: 248, title: "Alerts by category", roles: { Category: ["fact_alert.category as Category"], Y: ["fact_alert.[Alerts]"] }, sort: { field: "fact_alert.[Alerts]", desc: true } },
      { id: "alTable", type: "tableEx", x: 16, y: 432, w: 1248, h: 272, title: "Alerts", roles: { Values: ["fact_alert.raised_at as Raised (UTC)", "fact_alert.severity as Severity", "fact_alert.category as Category", "fact_alert.product as Product", "fact_alert.alert_type as Type"] }, sort: { field: "fact_alert.raised_at", desc: true } },
    ],
  },
];

export const PAGES_DIRECT = [
  {
    id: "overview",
    name: "Overview",
    visuals: [
      card("dOpen", 16, 56, "fact_case.[Open cases]", "Open cases"),
      card("dRows", 176, 56, "fact_detection.[Detection rows]", "Detections read"),
      card("dEp", 336, 56, "fact_endpoint_snapshot.[Endpoints]", "Endpoints"),
      card("dUnh", 496, 56, "fact_endpoint_snapshot.[Endpoints not in good health]", "Not in good health"),
      card("dAlerts", 656, 56, "fact_alert.[Alerts]", "Alerts"),
      { id: "dDetChart", type: "columnChart", x: 16, y: 168, w: 824, h: 264, title: "Detections per day by severity", roles: { Category: ["Date.Date"], Series: ["fact_detection.severity_band as Severity"], Y: ["fact_detection.[Detection rows]"] } },
      { id: "dCaseSev", type: "barChart", x: 856, y: 168, w: 408, h: 264, title: "Open cases by severity", roles: { Category: ["fact_case.severity_label as Severity"], Y: ["fact_case.[Open cases]"] } },
      { id: "dCases", type: "tableEx", x: 16, y: 448, w: 824, h: 256, title: "Cases", roles: { Values: ["fact_case.short_id as Case", "fact_case.severity_label as Severity", "fact_case.case_type as Type", "fact_case.primary_status as Status", "fact_case.managed_by as Managed by", "fact_case.created_local_date as Created", "fact_case.age_days as Age (days)"] }, sort: { field: "fact_case.created_local_date", desc: true } },
      { id: "dHealth", type: "donutChart", x: 856, y: 448, w: 408, h: 256, title: "Endpoint health", roles: { Category: ["fact_endpoint_snapshot.health_overall as Health"], Y: ["fact_endpoint_snapshot.[Endpoints]"] } },
    ],
  },
  {
    id: "licenses",
    name: "Licenses and alerts",
    visuals: [
      { id: "dLic", type: "tableEx", x: 16, y: 56, w: 1248, h: 320, title: "Licenses", roles: { Values: ["fact_license.product_name as Product", "fact_license.license_code as Code", "fact_license.license_type as Type", "fact_license.end_date as Ends", "fact_license.[Licensed quantity]", "fact_license.[Licenses used]"] }, sort: { field: "fact_license.end_date", desc: false } },
      { id: "dAl", type: "tableEx", x: 16, y: 392, w: 1248, h: 312, title: "Alerts", roles: { Values: ["fact_alert.raised_at as Raised (UTC)", "fact_alert.severity as Severity", "fact_alert.category as Category", "fact_alert.product as Product", "fact_alert.alert_type as Type"] }, sort: { field: "fact_alert.raised_at", desc: true } },
    ],
  },
];
