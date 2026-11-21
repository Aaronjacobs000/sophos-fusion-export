/**
 * The CSV schema: every table the exporter writes, its columns in order, the
 * key that makes a rerun replace rather than duplicate, and how each table is
 * loaded. `_schema.json` and the data dictionary are generated from this, and
 * the template tests check every column the Power BI and Grafana templates
 * read against it.
 *
 * Rules every table follows:
 *   - tenant_id (the Sophos Central tenant ID) is the first column of every row,
 *     so a partner model can roll tenants up and apply row-level security;
 *   - timestamps are UTC ISO 8601 with Z; *_local_date columns are the date in
 *     the configured report time zone, and *_date_key the same date as YYYYMMDD;
 *   - a minor schema version only adds columns, at the end.
 */

export type ColumnType = "string" | "integer" | "number" | "boolean" | "datetime" | "date";

export interface Column {
  name: string;
  type: ColumnType;
  description: string;
  /** Left empty unless the personal data switch is on. */
  personal?: boolean;
}

/**
 * How a run loads the table:
 *   upsert:   rows replace earlier rows with the same key; nothing is removed.
 *   snapshot: one set of rows per snapshot_date; a rerun the same day replaces that day.
 *   window:   rows inside the re-pulled time window are replaced; older rows stay.
 *   reference: the current list, replaced on every run.
 */
export type LoadMode = "upsert" | "snapshot" | "window" | "reference";

export interface TableDef {
  name: string;
  description: string;
  version: string;
  load: LoadMode;
  key: string[];
  columns: Column[];
  /** Written only when the personal data switch is on. */
  personalOnly?: boolean;
}

const tenant: Column = { name: "tenant_id", type: "string", description: "Sophos Central tenant ID (a UUID)." };
const snapshotDate: Column = { name: "snapshot_date", type: "date", description: "Day of the snapshot in the report time zone." };

const col = (name: string, type: ColumnType, description: string, personal?: boolean): Column =>
  personal ? { name, type, description, personal } : { name, type, description };

export const TABLES: readonly TableDef[] = [
  {
    name: "dim_tenant",
    description: "The tenant this credential reads. One row per tenant.",
    version: "1.0",
    load: "upsert",
    key: ["tenant_id"],
    columns: [
      tenant,
      col("tenant_name", "string", "Display name: the configured tenantName, else the name Sophos returns on alerts, else the tenant ID."),
      col("fusion_tenant_id", "string", "The tenant's ID in Sophos Fusion GraphQL, as cases report it. Empty for a Classic tenant."),
      col("partner_id", "string", "Partner that manages the tenant, from the Licenses API. Empty when none."),
      col("organization_id", "string", "Organization the tenant belongs to, from the Licenses API. Empty when none."),
      col("data_region", "string", "Sophos Central data region host, for example https://api-eu01.central.sophos.com."),
      col("platform", "string", "fusion when the tenant answers Sophos Fusion Cases v2, classic when it is still on cases v1."),
      col("report_timezone", "string", "IANA time zone the *_local_date columns use."),
      col("license_codes", "string", "License codes the tenant holds, joined with |."),
      col("exported_at", "datetime", "When this row was last written."),
    ],
  },
  {
    name: "fact_license",
    description: "Licenses held by the tenant, one snapshot a day.",
    version: "1.0",
    load: "snapshot",
    key: ["tenant_id", "snapshot_date", "license_id"],
    columns: [
      tenant,
      snapshotDate,
      col("license_id", "string", "Sophos license record ID."),
      col("license_code", "string", "License code, for example XDR-MSP or CIXAXDR."),
      col("generic_code", "string", "Sophos generic product code, when sent."),
      col("product_name", "string", "Product name Sophos gives the license."),
      col("license_type", "string", "term, trial, usage (MSP monthly) or another value Sophos sends."),
      col("quantity", "integer", "Licensed quantity. Empty when unlimited."),
      col("used", "integer", "Current usage count Sophos reports. Empty when it sends none."),
      col("unlimited", "boolean", "True for an unlimited license."),
      col("perpetual", "boolean", "True for a perpetual license."),
      col("start_date", "date", "License start date."),
      col("end_date", "date", "License end date. Empty for a perpetual license."),
      col("days_to_end", "integer", "Days from the snapshot date to the end date. Negative once expired."),
    ],
  },
  {
    name: "fact_case",
    description: "Cases, current state, one row per case (Sophos Fusion Cases v2, or cases v1 for a Classic tenant).",
    version: "1.0",
    load: "upsert",
    key: ["tenant_id", "case_id"],
    columns: [
      tenant,
      col("case_id", "string", "Case ID."),
      col("short_id", "string", "Human readable case ID, for example G-01560."),
      col("title", "string", "Case title. Often names a host or user, so it is personal data.", true),
      col("severity", "integer", "2 informational, 4 low, 6 medium, 8 high, 10 critical. 0 when not set."),
      col("severity_label", "string", "Informational, Low, Medium, High, Critical, or Not set."),
      col("case_type_id", "string", "Case type ID (dim_case_type)."),
      col("case_type", "string", "Case type title."),
      col("primary_status_id", "string", "Primary status ID (dim_case_status)."),
      col("primary_status", "string", "Primary status title."),
      col("secondary_status", "string", "Secondary status title, when set."),
      col("is_closed", "boolean", "True when the primary status is a closed one."),
      col("primary_verdict", "string", "Primary verdict title, when set."),
      col("secondary_verdict", "string", "Secondary verdict title, when set."),
      col("close_reason", "string", "Free text the closer typed, so it is personal data.", true),
      col("managed_by", "string", "PROVIDER (Sophos MDR or the partner), CUSTOMER, or empty when not yet claimed."),
      col("created_by_mdr", "boolean", "True when the tenant's MDR provider created the case."),
      col("created_by_partner", "boolean", "True when the tenant's partner created the case."),
      col("assignee_id", "string", "ID of the assigned user, client or group, or a mention such as @sophos."),
      col("created_at", "datetime", "When the case was created."),
      col("created_local_date", "date", "created_at as a date in the report time zone."),
      col("created_date_key", "integer", "created_local_date as a number, YYYYMMDD, for tools that filter dates numerically."),
      col("updated_at", "datetime", "When the case last changed."),
      col("closed_at", "datetime", "When the case was closed. Empty while open."),
      col("closed_local_date", "date", "closed_at as a date in the report time zone."),
      col("closed_date_key", "integer", "closed_local_date as a number, YYYYMMDD."),
      col("archived_at", "datetime", "When the case was archived, if it was."),
      col("minutes_to_close", "integer", "closed_at minus created_at in minutes. Empty while open."),
      col("age_days", "number", "Days from created_at to closed_at, or to the export time while open."),
      col("risk_score", "number", "Case risk score."),
      col("source", "string", "How the case was generated, when Sophos says."),
      col("tags", "string", "Case tags joined with |."),
      col("detections_count", "integer", "Detections attached to the case."),
      col("events_count", "integer", "Events attached to the case."),
      col("assets_count", "integer", "Assets attached to the case."),
      col("api_version", "string", "v2 (Sophos Fusion) or v1 (cases v1, Classic)."),
      col("exported_at", "datetime", "When this row was last written."),
    ],
  },
  {
    name: "dim_case_type",
    description: "Case types the tenant can use. Fusion builds these from licensed services.",
    version: "1.0",
    load: "reference",
    key: ["tenant_id", "case_type_id"],
    columns: [tenant, col("case_type_id", "string", "Case type ID."), col("name", "string", "Machine name."), col("title", "string", "Display title."), col("managed_by", "string", "PROVIDER, CUSTOMER or empty.")],
  },
  {
    name: "dim_case_status",
    description: "Primary and secondary case statuses the tenant can use.",
    version: "1.0",
    load: "reference",
    key: ["tenant_id", "status_id"],
    columns: [
      tenant,
      col("status_id", "string", "Status ID."),
      col("level", "string", "primary or secondary."),
      col("name", "string", "Machine name."),
      col("title", "string", "Display title."),
      col("is_closed", "boolean", "For a primary status: true when it closes the case."),
    ],
  },
  {
    name: "dim_case_verdict",
    description: "Primary and secondary case verdicts the tenant can use.",
    version: "1.0",
    load: "reference",
    key: ["tenant_id", "verdict_id"],
    columns: [tenant, col("verdict_id", "string", "Verdict ID."), col("level", "string", "primary or secondary."), col("name", "string", "Machine name."), col("title", "string", "Display title.")],
  },
  {
    name: "fact_detection",
    description: "Detections (Sophos Fusion Detections v2), one row per detection. The last detectionTrailingDays are pulled again on every run because status changes after creation.",
    version: "1.0",
    load: "window",
    key: ["tenant_id", "detection_id"],
    columns: [
      tenant,
      col("detection_id", "string", "Detection resource name (alert://...)."),
      col("created_at", "datetime", "When the detection was created."),
      col("created_local_date", "date", "created_at as a date in the report time zone."),
      col("created_date_key", "integer", "created_local_date as a number, YYYYMMDD, for tools that filter dates numerically."),
      col("first_seen_at", "datetime", "When the activity was first seen, when Sophos says."),
      col("severity", "number", "Severity score, 0 to 1."),
      col("severity_band", "string", "Critical (0.8 and up), High (0.6), Medium (0.4), Low (0.2) or Info."),
      col("severity_rank", "integer", "5 Critical, 4 High, 3 Medium, 2 Low, 1 Info, for sorting."),
      col("confidence", "number", "Confidence, 0 to 1."),
      col("threat_score", "number", "Threat score Sophos assigns."),
      col("status", "string", "OPEN, TRUE_POSITIVE_BENIGN, TRUE_POSITIVE_MALICIOUS, FALSE_POSITIVE, NOT_ACTIONABLE, OTHER, SUPPRESSED, AUTO_CLOSE or DISMISSED."),
      col("resolution_reason", "string", "Resolution reason, when set."),
      col("detector_id", "string", "Detector ID (dim_detector)."),
      col("title", "string", "Detection title."),
      col("description", "string", "Detection description. Can quote command lines, hosts and users, so it is personal data.", true),
      col("technique_count", "integer", "MITRE ATT&CK techniques the detection names."),
      col("sensor_count", "integer", "Sensor types that contributed."),
      col("case_count", "integer", "Cases (investigations) the detection is attached to."),
      col("case_ids", "string", "Those case IDs joined with |."),
      col("exported_at", "datetime", "When this row was last written."),
    ],
  },
  {
    name: "bridge_detection_technique",
    description: "MITRE ATT&CK techniques and tactics per detection. One row per detection, technique and tactic; tactic is empty when no enrichment gives one.",
    version: "1.0",
    load: "window",
    key: ["tenant_id", "detection_id", "technique_id", "tactic"],
    columns: [tenant, col("detection_id", "string", "Detection resource name."), col("technique_id", "string", "ATT&CK technique ID, for example T1078.002."), col("tactic", "string", "ATT&CK tactic short name, for example lateral-movement.")],
  },
  {
    name: "bridge_detection_sensor",
    description: "Sensor types per detection.",
    version: "1.0",
    load: "window",
    key: ["tenant_id", "detection_id", "sensor_type"],
    columns: [tenant, col("detection_id", "string", "Detection resource name."), col("sensor_type", "string", "Sensor type code (dim_sensor_type).")],
  },
  {
    name: "bridge_detection_entity",
    description: "Source and target entities per detection (hosts, users, IP addresses, processes). Written only with the personal data switch on.",
    version: "1.0",
    load: "window",
    personalOnly: true,
    key: ["tenant_id", "detection_id", "role", "subtype", "display_name"],
    columns: [
      tenant,
      col("detection_id", "string", "Detection resource name."),
      col("role", "string", "source or target."),
      col("subtype", "string", "Entity kind, for example Endpoint, User or IpAddress."),
      col("display_name", "string", "Entity name.", true),
    ],
  },
  {
    name: "dim_detector",
    description: "Detectors seen in detections.",
    version: "1.0",
    load: "upsert",
    key: ["tenant_id", "detector_id"],
    columns: [tenant, col("detector_id", "string", "Detector ID."), col("detector_name", "string", "Detector name.")],
  },
  {
    name: "dim_mitre_technique",
    description: "MITRE ATT&CK techniques seen in detections.",
    version: "1.0",
    load: "upsert",
    key: ["tenant_id", "technique_id"],
    columns: [tenant, col("technique_id", "string", "Technique ID."), col("technique_name", "string", "Technique name, when an enrichment gives it."), col("tactics", "string", "Tactics joined with |.")],
  },
  {
    name: "dim_sensor_type",
    description: "Sensor types seen in detections, with a readable label.",
    version: "1.0",
    load: "upsert",
    key: ["tenant_id", "sensor_type"],
    columns: [tenant, col("sensor_type", "string", "Sensor type code, for example ENDPOINT_SOPHOS."), col("label", "string", "Readable label, for example Endpoint.")],
  },
  {
    name: "fact_detection_daily",
    description: "Detection counts by day, severity band and detector. Kept after detection detail is pruned, so long trends survive Sophos's retention.",
    version: "1.0",
    load: "window",
    key: ["tenant_id", "local_date", "severity_band", "detector_id"],
    columns: [
      tenant,
      col("local_date", "date", "Day in the report time zone."),
      col("date_key", "integer", "local_date as a number, YYYYMMDD, for tools that filter dates numerically."),
      col("severity_band", "string", "Critical, High, Medium, Low or Info."),
      col("severity_rank", "integer", "5 Critical down to 1 Info."),
      col("detector_id", "string", "Detector ID."),
      col("detections", "integer", "Detections created that day."),
      col("open_detections", "integer", "Of those, detections still OPEN at export time."),
      col("detector_name", "string", "Detector name, repeated here for tools that can't join to dim_detector."),
    ],
  },
  {
    name: "fact_technique_daily",
    description: "Detection counts by day, MITRE ATT&CK technique and tactic. Kept after detection detail is pruned.",
    version: "1.0",
    load: "window",
    key: ["tenant_id", "local_date", "technique_id", "tactic"],
    columns: [
      tenant,
      col("local_date", "date", "Day in the report time zone."),
      col("date_key", "integer", "local_date as a number, YYYYMMDD, for tools that filter dates numerically."),
      col("technique_id", "string", "ATT&CK technique ID."),
      col("tactic", "string", "ATT&CK tactic short name; empty when no enrichment gives one."),
      col("detections", "integer", "Detections created that day naming the technique."),
      col("technique_name", "string", "Technique name, when an enrichment gives it, repeated for tools that can't join."),
    ],
  },
  {
    name: "fact_sensor_daily",
    description: "Detection counts by day and sensor type. Kept after detection detail is pruned.",
    version: "1.0",
    load: "window",
    key: ["tenant_id", "local_date", "sensor_type"],
    columns: [
      tenant,
      col("local_date", "date", "Day in the report time zone."),
      col("date_key", "integer", "local_date as a number, YYYYMMDD, for tools that filter dates numerically."),
      col("sensor_type", "string", "Sensor type code (dim_sensor_type)."),
      col("detections", "integer", "Detections created that day with this sensor type."),
      col("sensor_label", "string", "Readable sensor label, repeated for tools that can't join to dim_sensor_type."),
    ],
  },
  {
    name: "fact_endpoint_snapshot",
    description: "Endpoint health and coverage, one snapshot a day per endpoint (Endpoint API).",
    version: "1.0",
    load: "snapshot",
    key: ["tenant_id", "snapshot_date", "endpoint_id"],
    columns: [
      tenant,
      snapshotDate,
      col("endpoint_id", "string", "Endpoint ID. Equals host_id in the Sophos Data Lake."),
      col("endpoint_type", "string", "computer, server or securityVm."),
      col("hostname", "string", "Hostname.", true),
      col("os_platform", "string", "windows, macOS or linux."),
      col("os_name", "string", "Operating system name."),
      col("os_build", "string", "major.minor.build."),
      col("health_overall", "string", "good, suspicious, bad or unknown."),
      col("health_threats", "string", "Threat health."),
      col("health_services", "string", "Service health."),
      col("last_seen_at", "datetime", "When the endpoint last checked in."),
      col("days_since_seen", "number", "Days from last_seen_at to the snapshot time."),
      col("online", "boolean", "Online at snapshot time, when Sophos says."),
      col("tamper_protection_enabled", "boolean", "Tamper protection on."),
      col("tamper_protection_supported", "boolean", "Tamper protection supported on this endpoint."),
      col("isolation_status", "string", "isolated or notIsolated."),
      col("lockdown_status", "string", "Server lockdown status."),
      col("group_name", "string", "Endpoint group."),
      col("mdr_managed", "boolean", "Managed by Sophos MDR, when Sophos says."),
      col("protection_package", "string", "Assigned protection package, for example XDR or MDR."),
      col("core_agent_version", "string", "Core agent version."),
      col("products", "string", "Installed product codes joined with |."),
      col("ipv4_addresses", "string", "IPv4 addresses joined with |.", true),
      col("associated_person", "string", "Associated person.", true),
    ],
  },
  {
    name: "fact_health_check_snapshot",
    description: "Account Health Check scores, one snapshot a day per check.",
    version: "1.0",
    load: "snapshot",
    key: ["tenant_id", "snapshot_date", "area", "scope"],
    columns: [
      tenant,
      snapshotDate,
      col("area", "string", "protection, policy, exclusions or tamperProtection."),
      col("scope", "string", "What the score covers, for example computer, server, policy.computer.threat-protection or global."),
      col("score", "number", "Score, 0 to 100."),
      col("total", "integer", "Items checked, when Sophos says."),
      col("issue_count", "integer", "Items failing the check (not fully protected, not on recommended settings, risky exclusions, tamper protection off)."),
      col("snoozed", "boolean", "The check is snoozed."),
    ],
  },
  {
    name: "fact_alert",
    description: "Sophos Central product alerts (Common API), current state per alert. Useful for tenants without XDR or MDR. An alert leaves the API once acknowledged, but stays in this table.",
    version: "1.0",
    load: "upsert",
    key: ["tenant_id", "alert_id"],
    columns: [
      tenant,
      col("alert_id", "string", "Alert ID."),
      col("raised_at", "datetime", "When the alert was raised."),
      col("raised_local_date", "date", "raised_at as a date in the report time zone."),
      col("raised_date_key", "integer", "raised_local_date as a number, YYYYMMDD."),
      col("severity", "string", "high, medium or low."),
      col("category", "string", "Alert category, for example malware or wireless."),
      col("product", "string", "Product that raised the alert."),
      col("alert_type", "string", "Alert type code."),
      col("status", "string", "Alert status Sophos reports."),
      col("managed_agent_id", "string", "Endpoint or device the alert is about, when any."),
      col("managed_agent_type", "string", "Kind of that device."),
      col("event_count", "integer", "Events correlated into the alert."),
      col("description", "string", "Alert text. Often names hosts and users, so it is personal data.", true),
      col("last_seen_open_at", "datetime", "Last export run that still saw the alert in the API."),
    ],
  },
];

export const SCHEMA_VERSION = "1.0";

export function table(name: string): TableDef {
  const found = TABLES.find((t) => t.name === name);
  if (!found) throw new Error(`No table ${name}`);
  return found;
}

/** The _schema.json document. */
export function schemaDocument(): Record<string, unknown> {
  return {
    schemaVersion: SCHEMA_VERSION,
    generator: "sophos-fusion-export",
    conventions: {
      encoding: "UTF-8, no byte order mark",
      delimiter: ",",
      header: true,
      nullValue: "",
      datetime: "ISO 8601 UTC with Z, second precision",
      date: "YYYY-MM-DD in the report time zone",
      boolean: "true or false",
    },
    tables: TABLES.map((t) => ({
      name: t.name,
      file: `${t.name}.csv`,
      version: t.version,
      description: t.description,
      load: t.load,
      key: t.key,
      personalOnly: t.personalOnly ?? false,
      columns: t.columns.map((c) => ({ name: c.name, type: c.type, personal: c.personal ?? false, description: c.description })),
    })),
  };
}
