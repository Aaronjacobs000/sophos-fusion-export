# Data dictionary

Schema version 1.0. Generated from `src/schema/tables.ts` by `fusion-export schema`; do not edit by hand.

Every file is UTF-8 CSV with a header row. Every row starts with `tenant_id`. Timestamps are UTC ISO 8601 with `Z`; `*_local_date` and `snapshot_date` are dates in the configured report time zone. Empty means no value. Columns marked personal are empty unless the personal data switch is on.

## dim_tenant

The tenant this credential reads. One row per tenant.

Key: `tenant_id`. Upsert on the key. Rows are replaced, never removed.

| Column | Type | Description |
| --- | --- | --- |
| `tenant_id` | string | Sophos Central tenant ID (a UUID). |
| `tenant_name` | string | Display name: the configured tenantName, else the name Sophos returns on alerts, else the tenant ID. |
| `fusion_tenant_id` | string | The tenant's ID in Sophos Fusion GraphQL, as cases report it. Empty for a Classic tenant. |
| `partner_id` | string | Partner that manages the tenant, from the Licenses API. Empty when none. |
| `organization_id` | string | Organization the tenant belongs to, from the Licenses API. Empty when none. |
| `data_region` | string | Sophos Central data region host, for example https://api-eu01.central.sophos.com. |
| `platform` | string | fusion when the tenant answers Sophos Fusion Cases v2, classic when it is still on cases v1. |
| `report_timezone` | string | IANA time zone the *_local_date columns use. |
| `license_codes` | string | License codes the tenant holds, joined with \|. |
| `exported_at` | datetime | When this row was last written. |

## fact_license

Licenses held by the tenant, one snapshot a day.

Key: `tenant_id`, `snapshot_date`, `license_id`. One snapshot a day. A rerun the same day replaces that day's rows.

| Column | Type | Description |
| --- | --- | --- |
| `tenant_id` | string | Sophos Central tenant ID (a UUID). |
| `snapshot_date` | date | Day of the snapshot in the report time zone. |
| `license_id` | string | Sophos license record ID. |
| `license_code` | string | License code, for example XDR-MSP or CIXAXDR. |
| `generic_code` | string | Sophos generic product code, when sent. |
| `product_name` | string | Product name Sophos gives the license. |
| `license_type` | string | term, trial, usage (MSP monthly) or another value Sophos sends. |
| `quantity` | integer | Licensed quantity. Empty when unlimited. |
| `used` | integer | Current usage count Sophos reports. Empty when it sends none. |
| `unlimited` | boolean | True for an unlimited license. |
| `perpetual` | boolean | True for a perpetual license. |
| `start_date` | date | License start date. |
| `end_date` | date | License end date. Empty for a perpetual license. |
| `days_to_end` | integer | Days from the snapshot date to the end date. Negative once expired. |

## fact_case

Cases, current state, one row per case (Sophos Fusion Cases v2, or cases v1 for a Classic tenant).

Key: `tenant_id`, `case_id`. Upsert on the key. Rows are replaced, never removed.

| Column | Type | Description |
| --- | --- | --- |
| `tenant_id` | string | Sophos Central tenant ID (a UUID). |
| `case_id` | string | Case ID. |
| `short_id` | string | Human readable case ID, for example G-01560. |
| `title` | string | Case title. Often names a host or user, so it is personal data. Personal. |
| `severity` | integer | 2 informational, 4 low, 6 medium, 8 high, 10 critical. 0 when not set. |
| `severity_label` | string | Informational, Low, Medium, High, Critical, or Not set. |
| `case_type_id` | string | Case type ID (dim_case_type). |
| `case_type` | string | Case type title. |
| `primary_status_id` | string | Primary status ID (dim_case_status). |
| `primary_status` | string | Primary status title. |
| `secondary_status` | string | Secondary status title, when set. |
| `is_closed` | boolean | True when the primary status is a closed one. |
| `primary_verdict` | string | Primary verdict title, when set. |
| `secondary_verdict` | string | Secondary verdict title, when set. |
| `close_reason` | string | Free text the closer typed, so it is personal data. Personal. |
| `managed_by` | string | PROVIDER (Sophos MDR or the partner), CUSTOMER, or empty when not yet claimed. |
| `created_by_mdr` | boolean | True when the tenant's MDR provider created the case. |
| `created_by_partner` | boolean | True when the tenant's partner created the case. |
| `assignee_id` | string | ID of the assigned user, client or group, or a mention such as @sophos. |
| `created_at` | datetime | When the case was created. |
| `created_local_date` | date | created_at as a date in the report time zone. |
| `created_date_key` | integer | created_local_date as a number, YYYYMMDD, for tools that filter dates numerically. |
| `updated_at` | datetime | When the case last changed. |
| `closed_at` | datetime | When the case was closed. Empty while open. |
| `closed_local_date` | date | closed_at as a date in the report time zone. |
| `closed_date_key` | integer | closed_local_date as a number, YYYYMMDD. |
| `archived_at` | datetime | When the case was archived, if it was. |
| `minutes_to_close` | integer | closed_at minus created_at in minutes. Empty while open. |
| `age_days` | number | Days from created_at to closed_at, or to the export time while open. |
| `risk_score` | number | Case risk score. |
| `source` | string | How the case was generated, when Sophos says. |
| `tags` | string | Case tags joined with \|. |
| `detections_count` | integer | Detections attached to the case. |
| `events_count` | integer | Events attached to the case. |
| `assets_count` | integer | Assets attached to the case. |
| `api_version` | string | v2 (Sophos Fusion) or v1 (cases v1, Classic). |
| `exported_at` | datetime | When this row was last written. |

## dim_case_type

Case types the tenant can use. Fusion builds these from licensed services.

Key: `tenant_id`, `case_type_id`. The current list, replaced on every run.

| Column | Type | Description |
| --- | --- | --- |
| `tenant_id` | string | Sophos Central tenant ID (a UUID). |
| `case_type_id` | string | Case type ID. |
| `name` | string | Machine name. |
| `title` | string | Display title. |
| `managed_by` | string | PROVIDER, CUSTOMER or empty. |

## dim_case_status

Primary and secondary case statuses the tenant can use.

Key: `tenant_id`, `status_id`. The current list, replaced on every run.

| Column | Type | Description |
| --- | --- | --- |
| `tenant_id` | string | Sophos Central tenant ID (a UUID). |
| `status_id` | string | Status ID. |
| `level` | string | primary or secondary. |
| `name` | string | Machine name. |
| `title` | string | Display title. |
| `is_closed` | boolean | For a primary status: true when it closes the case. |

## dim_case_verdict

Primary and secondary case verdicts the tenant can use.

Key: `tenant_id`, `verdict_id`. The current list, replaced on every run.

| Column | Type | Description |
| --- | --- | --- |
| `tenant_id` | string | Sophos Central tenant ID (a UUID). |
| `verdict_id` | string | Verdict ID. |
| `level` | string | primary or secondary. |
| `name` | string | Machine name. |
| `title` | string | Display title. |

## fact_detection

Detections (Sophos Fusion Detections v2), one row per detection. The last detectionTrailingDays are pulled again on every run because status changes after creation.

Key: `tenant_id`, `detection_id`. The re-read window is replaced on every run. Rows before it are settled.

| Column | Type | Description |
| --- | --- | --- |
| `tenant_id` | string | Sophos Central tenant ID (a UUID). |
| `detection_id` | string | Detection resource name (alert://...). |
| `created_at` | datetime | When the detection was created. |
| `created_local_date` | date | created_at as a date in the report time zone. |
| `created_date_key` | integer | created_local_date as a number, YYYYMMDD, for tools that filter dates numerically. |
| `first_seen_at` | datetime | When the activity was first seen, when Sophos says. |
| `severity` | number | Severity score, 0 to 1. |
| `severity_band` | string | Critical (0.8 and up), High (0.6), Medium (0.4), Low (0.2) or Info. |
| `severity_rank` | integer | 5 Critical, 4 High, 3 Medium, 2 Low, 1 Info, for sorting. |
| `confidence` | number | Confidence, 0 to 1. |
| `threat_score` | number | Threat score Sophos assigns. |
| `status` | string | OPEN, TRUE_POSITIVE_BENIGN, TRUE_POSITIVE_MALICIOUS, FALSE_POSITIVE, NOT_ACTIONABLE, OTHER, SUPPRESSED, AUTO_CLOSE or DISMISSED. |
| `resolution_reason` | string | Resolution reason, when set. |
| `detector_id` | string | Detector ID (dim_detector). |
| `title` | string | Detection title. |
| `description` | string | Detection description. Can quote command lines, hosts and users, so it is personal data. Personal. |
| `technique_count` | integer | MITRE ATT&CK techniques the detection names. |
| `sensor_count` | integer | Sensor types that contributed. |
| `case_count` | integer | Cases (investigations) the detection is attached to. |
| `case_ids` | string | Those case IDs joined with \|. |
| `exported_at` | datetime | When this row was last written. |

## bridge_detection_technique

MITRE ATT&CK techniques and tactics per detection. One row per detection, technique and tactic; tactic is empty when no enrichment gives one.

Key: `tenant_id`, `detection_id`, `technique_id`, `tactic`. The re-read window is replaced on every run. Rows before it are settled.

| Column | Type | Description |
| --- | --- | --- |
| `tenant_id` | string | Sophos Central tenant ID (a UUID). |
| `detection_id` | string | Detection resource name. |
| `technique_id` | string | ATT&CK technique ID, for example T1078.002. |
| `tactic` | string | ATT&CK tactic short name, for example lateral-movement. |

## bridge_detection_sensor

Sensor types per detection.

Key: `tenant_id`, `detection_id`, `sensor_type`. The re-read window is replaced on every run. Rows before it are settled.

| Column | Type | Description |
| --- | --- | --- |
| `tenant_id` | string | Sophos Central tenant ID (a UUID). |
| `detection_id` | string | Detection resource name. |
| `sensor_type` | string | Sensor type code (dim_sensor_type). |

## bridge_detection_entity

Source and target entities per detection (hosts, users, IP addresses, processes). Written only with the personal data switch on.

Key: `tenant_id`, `detection_id`, `role`, `subtype`, `display_name`. The re-read window is replaced on every run. Rows before it are settled. Written only with the personal data switch on.

| Column | Type | Description |
| --- | --- | --- |
| `tenant_id` | string | Sophos Central tenant ID (a UUID). |
| `detection_id` | string | Detection resource name. |
| `role` | string | source or target. |
| `subtype` | string | Entity kind, for example Endpoint, User or IpAddress. |
| `display_name` | string | Entity name. Personal. |

## dim_detector

Detectors seen in detections.

Key: `tenant_id`, `detector_id`. Upsert on the key. Rows are replaced, never removed.

| Column | Type | Description |
| --- | --- | --- |
| `tenant_id` | string | Sophos Central tenant ID (a UUID). |
| `detector_id` | string | Detector ID. |
| `detector_name` | string | Detector name. |

## dim_mitre_technique

MITRE ATT&CK techniques seen in detections.

Key: `tenant_id`, `technique_id`. Upsert on the key. Rows are replaced, never removed.

| Column | Type | Description |
| --- | --- | --- |
| `tenant_id` | string | Sophos Central tenant ID (a UUID). |
| `technique_id` | string | Technique ID. |
| `technique_name` | string | Technique name, when an enrichment gives it. |
| `tactics` | string | Tactics joined with \|. |

## dim_sensor_type

Sensor types seen in detections, with a readable label.

Key: `tenant_id`, `sensor_type`. Upsert on the key. Rows are replaced, never removed.

| Column | Type | Description |
| --- | --- | --- |
| `tenant_id` | string | Sophos Central tenant ID (a UUID). |
| `sensor_type` | string | Sensor type code, for example ENDPOINT_SOPHOS. |
| `label` | string | Readable label, for example Endpoint. |

## fact_detection_daily

Detection counts by day, severity band and detector. Kept after detection detail is pruned, so long trends survive Sophos's retention.

Key: `tenant_id`, `local_date`, `severity_band`, `detector_id`. The re-read window is replaced on every run. Rows before it are settled.

| Column | Type | Description |
| --- | --- | --- |
| `tenant_id` | string | Sophos Central tenant ID (a UUID). |
| `local_date` | date | Day in the report time zone. |
| `date_key` | integer | local_date as a number, YYYYMMDD, for tools that filter dates numerically. |
| `severity_band` | string | Critical, High, Medium, Low or Info. |
| `severity_rank` | integer | 5 Critical down to 1 Info. |
| `detector_id` | string | Detector ID. |
| `detections` | integer | Detections created that day. |
| `open_detections` | integer | Of those, detections still OPEN at export time. |

## fact_technique_daily

Detection counts by day, MITRE ATT&CK technique and tactic. Kept after detection detail is pruned.

Key: `tenant_id`, `local_date`, `technique_id`, `tactic`. The re-read window is replaced on every run. Rows before it are settled.

| Column | Type | Description |
| --- | --- | --- |
| `tenant_id` | string | Sophos Central tenant ID (a UUID). |
| `local_date` | date | Day in the report time zone. |
| `date_key` | integer | local_date as a number, YYYYMMDD, for tools that filter dates numerically. |
| `technique_id` | string | ATT&CK technique ID. |
| `tactic` | string | ATT&CK tactic short name; empty when no enrichment gives one. |
| `detections` | integer | Detections created that day naming the technique. |

## fact_sensor_daily

Detection counts by day and sensor type. Kept after detection detail is pruned.

Key: `tenant_id`, `local_date`, `sensor_type`. The re-read window is replaced on every run. Rows before it are settled.

| Column | Type | Description |
| --- | --- | --- |
| `tenant_id` | string | Sophos Central tenant ID (a UUID). |
| `local_date` | date | Day in the report time zone. |
| `date_key` | integer | local_date as a number, YYYYMMDD, for tools that filter dates numerically. |
| `sensor_type` | string | Sensor type code (dim_sensor_type). |
| `detections` | integer | Detections created that day with this sensor type. |

## fact_endpoint_snapshot

Endpoint health and coverage, one snapshot a day per endpoint (Endpoint API).

Key: `tenant_id`, `snapshot_date`, `endpoint_id`. One snapshot a day. A rerun the same day replaces that day's rows.

| Column | Type | Description |
| --- | --- | --- |
| `tenant_id` | string | Sophos Central tenant ID (a UUID). |
| `snapshot_date` | date | Day of the snapshot in the report time zone. |
| `endpoint_id` | string | Endpoint ID. Equals host_id in the Sophos Data Lake. |
| `endpoint_type` | string | computer, server or securityVm. |
| `hostname` | string | Hostname. Personal. |
| `os_platform` | string | windows, macOS or linux. |
| `os_name` | string | Operating system name. |
| `os_build` | string | major.minor.build. |
| `health_overall` | string | good, suspicious, bad or unknown. |
| `health_threats` | string | Threat health. |
| `health_services` | string | Service health. |
| `last_seen_at` | datetime | When the endpoint last checked in. |
| `days_since_seen` | number | Days from last_seen_at to the snapshot time. |
| `online` | boolean | Online at snapshot time, when Sophos says. |
| `tamper_protection_enabled` | boolean | Tamper protection on. |
| `tamper_protection_supported` | boolean | Tamper protection supported on this endpoint. |
| `isolation_status` | string | isolated or notIsolated. |
| `lockdown_status` | string | Server lockdown status. |
| `group_name` | string | Endpoint group. |
| `mdr_managed` | boolean | Managed by Sophos MDR, when Sophos says. |
| `protection_package` | string | Assigned protection package, for example XDR or MDR. |
| `core_agent_version` | string | Core agent version. |
| `products` | string | Installed product codes joined with \|. |
| `ipv4_addresses` | string | IPv4 addresses joined with \|. Personal. |
| `associated_person` | string | Associated person. Personal. |

## fact_health_check_snapshot

Account Health Check scores, one snapshot a day per check.

Key: `tenant_id`, `snapshot_date`, `area`, `scope`. One snapshot a day. A rerun the same day replaces that day's rows.

| Column | Type | Description |
| --- | --- | --- |
| `tenant_id` | string | Sophos Central tenant ID (a UUID). |
| `snapshot_date` | date | Day of the snapshot in the report time zone. |
| `area` | string | protection, policy, exclusions or tamperProtection. |
| `scope` | string | What the score covers, for example computer, server, policy.computer.threat-protection or global. |
| `score` | number | Score, 0 to 100. |
| `total` | integer | Items checked, when Sophos says. |
| `issue_count` | integer | Items failing the check (not fully protected, not on recommended settings, risky exclusions, tamper protection off). |
| `snoozed` | boolean | The check is snoozed. |

## fact_alert

Sophos Central product alerts (Common API), current state per alert. Useful for tenants without XDR or MDR. An alert leaves the API once acknowledged, but stays in this table.

Key: `tenant_id`, `alert_id`. Upsert on the key. Rows are replaced, never removed.

| Column | Type | Description |
| --- | --- | --- |
| `tenant_id` | string | Sophos Central tenant ID (a UUID). |
| `alert_id` | string | Alert ID. |
| `raised_at` | datetime | When the alert was raised. |
| `raised_local_date` | date | raised_at as a date in the report time zone. |
| `raised_date_key` | integer | raised_local_date as a number, YYYYMMDD. |
| `severity` | string | high, medium or low. |
| `category` | string | Alert category, for example malware or wireless. |
| `product` | string | Product that raised the alert. |
| `alert_type` | string | Alert type code. |
| `status` | string | Alert status Sophos reports. |
| `managed_agent_id` | string | Endpoint or device the alert is about, when any. |
| `managed_agent_type` | string | Kind of that device. |
| `event_count` | integer | Events correlated into the alert. |
| `description` | string | Alert text. Often names hosts and users, so it is personal data. Personal. |
| `last_seen_open_at` | datetime | Last export run that still saw the alert in the API. |

