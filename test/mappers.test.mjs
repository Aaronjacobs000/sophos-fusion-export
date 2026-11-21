// Every mapper, on sanitized fixtures shaped like live Sophos answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/fake-sophos.mjs";
import { mapLicenses, licenseOwners } from "../dist/datasets/licenses.js";
import { mapFusionCase, mapLegacyCase, mapReferenceData, legacyReferenceData, casesFilter, severityLabel } from "../dist/datasets/cases.js";
import { mapDetection, dailyCounts, breakdownCounts, severityBand, detectionQuery, uniqueDetections } from "../dist/datasets/detections.js";
import { mapEndpoint, flattenHealthCheck } from "../dist/datasets/endpoints.js";
import { mapAlert } from "../dist/datasets/alerts.js";
import { sensorLabel } from "../dist/datasets/sensor-labels.js";
import { mapAiActivity, aiActivityDaily, mapAiApp, mapAiUser, mapAiPolicy, mapAiDefenseSnapshot, sanctioningByApp, uniqueActivities, riskRank, userKey } from "../dist/datasets/ai-defense.js";
import { TABLES, table } from "../dist/schema/tables.js";

const T = "11111111-2222-4333-8444-555555555555";
const TZ = "Australia/Sydney";
const NOW = new Date("2026-11-21T08:00:00Z");

/** Every key a mapper sets is a column of its table, and every column is set. */
function matchesTable(row, name) {
  assert.deepEqual(Object.keys(row).sort(), table(name).columns.map((c) => c.name).sort(), `${name} columns`);
}

test("licenses: codes, quantities, dates and the partner and organization", () => {
  const rows = mapLicenses(fixture("licenses.json"), T, "2026-11-21");
  assert.equal(rows.length, 2, "a license without a code is skipped");
  rows.forEach((r) => matchesTable(r, "fact_license"));
  const phish = rows.find((r) => r.license_code === "CPHISH");
  assert.equal(phish.generic_code, "PHT");
  assert.equal(phish.quantity, 100);
  assert.equal(phish.days_to_end, 10);
  const xdr = rows.find((r) => r.license_code === "XDR-MSP");
  assert.equal(xdr.product_name, "Sophos XDR - User");
  assert.equal(xdr.quantity, null);
  assert.equal(xdr.used, 42);
  assert.equal(xdr.end_date, null);
  assert.deepEqual(licenseOwners(fixture("licenses.json")), { partnerId: "99999999-0000-4000-8000-000000000001", organizationId: "99999999-0000-4000-8000-000000000002" });
});

test("Fusion cases: timing, labels, flags and local dates", () => {
  const [closed, open] = fixture("cases-page.json").data.cases.cases.map((c) => mapFusionCase(c, T, TZ, NOW));
  matchesTable(closed, "fact_case");
  assert.equal(closed.severity_label, "High");
  assert.equal(closed.is_closed, true);
  assert.equal(closed.minutes_to_close, 60);
  assert.equal(closed.age_days, 0.04);
  assert.equal(closed.created_at, "2026-11-19T11:50:57Z");
  assert.equal(closed.created_local_date, "2026-11-19");
  assert.equal(closed.primary_verdict, "False Positive");
  assert.equal(closed.tags, "Auto-Resolve|lab");
  assert.equal(closed.api_version, "v2");
  assert.equal(open.is_closed, false);
  assert.equal(open.minutes_to_close, null);
  assert.equal(open.age_days, 1.33);
  assert.equal(open.secondary_status, "Triage");
  assert.equal(open.source, "Automatic");
  assert.equal(open.tags, null);
  assert.equal(open.created_local_date, "2026-11-20");
  assert.equal(severityLabel(0), "Not set");
});

test("cases v1: mapped onto the same columns, tagged v1", () => {
  const [resolved, onHold] = fixture("legacy-cases-page.json").items.map((c) => mapLegacyCase(c, T, TZ, NOW));
  matchesTable(resolved, "fact_case");
  assert.equal(resolved.severity, 8);
  assert.equal(resolved.is_closed, true);
  assert.equal(resolved.minutes_to_close, 150);
  assert.equal(resolved.managed_by, "PROVIDER");
  assert.equal(resolved.primary_verdict, "True positive, benign");
  assert.equal(resolved.api_version, "v1");
  assert.equal(onHold.is_closed, false);
  assert.equal(onHold.primary_status, "On hold");
  assert.equal(onHold.managed_by, "CUSTOMER");
  assert.equal(onHold.severity_label, "Not set");
  const ref = legacyReferenceData(T);
  assert.equal(ref.statuses.find((s) => s.status_id === "resolved").is_closed, true);
});

test("case reference data: types, both status levels and both verdict levels", () => {
  const ref = mapReferenceData(fixture("case-reference.json").data, T);
  ref.types.forEach((r) => matchesTable(r, "dim_case_type"));
  ref.statuses.forEach((r) => matchesTable(r, "dim_case_status"));
  ref.verdicts.forEach((r) => matchesTable(r, "dim_case_verdict"));
  assert.equal(ref.types.length, 2);
  assert.deepEqual(ref.statuses.map((s) => s.level), ["primary", "primary", "secondary"]);
  assert.equal(ref.statuses[2].title, "triage", "a missing title falls back to the name");
});

test("incremental case filter: watermark minus the overlap, or a full read", () => {
  assert.equal(casesFilter("2026-11-20T10:00:00Z", 15), "updatedAt >= '2026-11-20T09:45:00Z'");
  assert.equal(casesFilter(undefined, 15), "");
});

test("detections: severity band, techniques with tactics, sensors, cases and entities", () => {
  const list = fixture("detections-page.json").data.detectionSearch.alerts.list;
  const [lateral, ai, cmd] = list.map((d) => mapDetection(d, T, TZ, NOW));
  matchesTable(lateral.detection, "fact_detection");
  assert.equal(lateral.detection.severity_band, "Info");
  assert.equal(lateral.detection.created_at, "2026-11-21T06:07:47Z");
  assert.equal(lateral.detection.created_local_date, "2026-11-21");
  assert.equal(lateral.detection.technique_count, 2);
  assert.deepEqual(
    lateral.techniques.map((t) => `${t.technique_id}/${t.tactic}`),
    ["T1021.002/lateral-movement", "T1078.002/initial-access", "T1078.002/persistence"]
  );
  lateral.techniques.forEach((r) => matchesTable(r, "bridge_detection_technique"));
  assert.equal(lateral.entities.length, 4, "HOST-A as source and as target, plus the IP and the user");
  lateral.entities.forEach((r) => matchesTable(r, "bridge_detection_entity"));
  assert.equal(lateral.detector.detector_name, "Tactic Graphs Detector");

  assert.equal(ai.detection.severity_band, "High");
  assert.equal(ai.detection.status, "TRUE_POSITIVE_BENIGN");
  assert.equal(ai.detection.case_count, 1);
  assert.equal(ai.detection.first_seen_at, "2026-11-21T05:46:40Z");
  assert.equal(cmd.detection.created_at, "2026-11-20T18:40:00Z");
  assert.equal(cmd.detection.created_local_date, "2026-11-21", "UTC evening is the next morning in Sydney");
  assert.deepEqual(ai.sensors.map((s) => s.sensor_type), ["ENDPOINT_SOPHOS", "PALOALTO_FIREWALL"]);
  assert.equal(ai.techniques.length, 0);

  assert.equal(cmd.detection.severity_band, "Critical");
  assert.equal(cmd.detection.resolution_reason, null);
  assert.deepEqual(cmd.techniques, [{ tenant_id: T, detection_id: cmd.detection.detection_id, technique_id: "T1059", tactic: "" }]);
});

test("severity bands use the 0.2, 0.4, 0.6 and 0.8 cut points", () => {
  assert.deepEqual([0, 0.19, 0.2, 0.4, 0.59, 0.6, 0.8, 1, null].map((s) => severityBand(s).band), ["Info", "Info", "Low", "Medium", "Medium", "High", "Critical", "Critical", "Info"]);
});

test("daily, technique and sensor counts", () => {
  const mapped = fixture("detections-page.json").data.detectionSearch.alerts.list.map((d) => mapDetection(d, T, TZ, NOW));
  const daily = dailyCounts(mapped.map((m) => m.detection), T);
  daily.forEach((r) => matchesTable(r, "fact_detection_daily"));
  assert.equal(daily.reduce((n, r) => n + r.detections, 0), 3);
  assert.equal(daily.reduce((n, r) => n + r.open_detections, 0), 2);
  const { techniques, sensors } = breakdownCounts(mapped, T);
  techniques.forEach((r) => matchesTable(r, "fact_technique_daily"));
  sensors.forEach((r) => matchesTable(r, "fact_sensor_daily"));
  assert.equal(sensors.find((s) => s.sensor_type === "ENDPOINT_SOPHOS" && s.local_date === "2026-11-21").detections, 3);
  assert.equal(techniques.find((t) => t.technique_id === "T1078.002" && t.tactic === "persistence").detections, 1);
});

test("detection reads: QL window and de-duplication", () => {
  assert.equal(detectionQuery(new Date("2026-11-14T13:00:00Z"), new Date("2026-11-21T08:00:00.500Z")), "FROM alert WHERE severity >= 0 EARLIEST='2026-11-14T13:00:00Z' LATEST='2026-11-21T08:00:00Z'");
  assert.equal(uniqueDetections([{ id: "a" }, { id: "b" }, { id: "a", status: "OPEN" }]).length, 2);
});

test("endpoints: health, versions, days since seen and the personal columns", () => {
  const [dc, laptop] = fixture("endpoints-page.json").items.map((e) => mapEndpoint(e, T, "2026-11-21", NOW));
  matchesTable(dc, "fact_endpoint_snapshot");
  assert.equal(dc.os_build, "10.0.20348");
  assert.equal(dc.os_name, "Windows Server 2022 Standard");
  assert.equal(dc.core_agent_version, "2026.3.0.2117");
  assert.equal(dc.products, "coreAgent|endpointProtection");
  assert.equal(dc.protection_package, "XDR");
  assert.equal(dc.group_name, "Domain Controllers");
  assert.equal(dc.hostname, "DC1");
  assert.equal(laptop.health_overall, "bad");
  assert.equal(laptop.days_since_seen, 20.33);
  assert.equal(laptop.tamper_protection_enabled, false);
  assert.equal(laptop.associated_person, "EXAMPLE\\alice");
  assert.equal(laptop.isolation_status, "isolated");
  assert.equal(laptop.mdr_managed, null);
});

test("Account Health Check: one row per scored check, named by its path", () => {
  const rows = flattenHealthCheck(fixture("health-check.json"), T, "2026-11-21");
  rows.forEach((r) => matchesTable(r, "fact_health_check_snapshot"));
  assert.deepEqual(
    rows.map((r) => `${r.area}:${r.scope}:${r.score}:${r.issue_count}`),
    [
      "protection:computer:100:0",
      "protection:server:90:1",
      "policy:computer.threat-protection:50:1",
      "exclusions:policy.computer:50:1",
      "exclusions:global:40:3",
      "tamperProtection:computer:100:0",
      "tamperProtection:globalDetail:100:null",
    ]
  );
  assert.deepEqual(flattenHealthCheck({}, T, "2026-11-21"), []);
});

test("alerts: raised time, local date and the device", () => {
  const [wifi, malware] = fixture("alerts-page.json").items.map((a) => mapAlert(a, T, TZ, NOW));
  matchesTable(wifi, "fact_alert");
  assert.equal(wifi.raised_at, "2026-11-17T14:51:19Z");
  assert.equal(wifi.raised_local_date, "2026-11-18");
  assert.equal(wifi.managed_agent_id, null);
  assert.equal(malware.managed_agent_type, "computer");
  assert.equal(malware.last_seen_open_at, "2026-11-21T08:00:00Z");
});

test("AI Defense activity: times, risk, the hashed user key and empty policy fields", () => {
  const list = [...fixture("ai-activities-page.json").data.activities.activities, ...fixture("ai-activities-page-2.json").data.activities.activities];
  const [copilot, blocked, firewall, unsanctioned] = list.map((a) => mapAiActivity(a, T, TZ, NOW));
  matchesTable(copilot, "fact_ai_activity");
  assert.equal(copilot.start_time, "2026-11-19T01:15:02Z");
  assert.equal(copilot.start_local_date, "2026-11-19");
  assert.equal(copilot.start_date_key, 20261119);
  assert.equal(copilot.records, 12);
  assert.equal(copilot.sensor_types, "ENDPOINT");
  assert.equal(copilot.policy_name, "Example standard");
  assert.match(copilot.user_key, /^[0-9a-f]{32}$/);
  assert.equal(copilot.user_key, userKey(T, "S-1-5-21-1000000001-1000000002-1000000003-1104"));
  assert.notEqual(copilot.user_key, userKey("another-tenant", "S-1-5-21-1000000001-1000000002-1000000003-1104"), "the key depends on the tenant");
  assert.equal(blocked.start_time, "2026-11-19T22:05:11Z", "fractions are dropped");
  assert.equal(blocked.start_local_date, "2026-11-20", "the local date is Sydney's");
  assert.equal(blocked.risk_rank, 5);
  assert.equal(firewall.action, null, "a null action stays empty");
  assert.equal(firewall.policy_id, null, "an empty policyId is empty, not a blank string");
  assert.equal(firewall.records, 48, "Int64 as a string");
  assert.equal(firewall.actor_type, "NETWORK_ENTITY");
  assert.equal(firewall.device_id, "C01000EXAMPLE01");
  assert.equal(unsanctioned.unsanctioned, true);
  assert.equal(unsanctioned.sensor_types, "ENDPOINT|FIREWALL");
  assert.equal(unsanctioned.model, null);
  assert.equal(uniqueActivities([...list, list[0]]).length, list.length);
  assert.equal(userKey(T, ""), null);
});

test("AI Defense daily counts: one row per day, app, action and risk", () => {
  const list = fixture("ai-activities-page.json").data.activities.activities.map((a) => mapAiActivity(a, T, TZ, NOW));
  const daily = aiActivityDaily([...list, list[0]], T);
  daily.forEach((r) => matchesTable(r, "fact_ai_activity_daily"));
  const copilot = daily.find((r) => r.application_id === "microsoft-copilot");
  assert.equal(copilot.activities, 2);
  assert.equal(copilot.records, 24);
  assert.equal(daily.find((r) => r.application_id === "chatgpt").action, null);
  assert.equal(daily.length, 3);
});

test("AI Defense apps, sanctioning, users, policies and the status snapshot", () => {
  const sanctioning = sanctioningByApp(fixture("ai-app-sanctioning.json").data.appSanctioning.entries);
  assert.deepEqual(sanctioning.get("deepseek"), { status: "BLOCKED", policies: "Example standard" });
  const apps = fixture("ai-app-inventory.json").data.appInventory.entries.map((a) => mapAiApp(a, T, "2026-11-21", 30, sanctioning));
  apps.forEach((r) => matchesTable(r, "fact_ai_app_snapshot"));
  const chat = apps.find((r) => r.application_id === "chatgpt");
  assert.equal(chat.activities, 272);
  assert.equal(chat.sanctioning_status, "WARNED");
  assert.equal(chat.last_seen_at, "2026-11-21T02:10:30Z");
  assert.equal(apps.find((r) => r.application_id === "deepseek").last_seen_at, null);
  assert.equal(mapAiApp({ id: "unknown-app", name: "Unknown" }, T, "2026-11-21", 30, sanctioning).sanctioning_status, null);

  const [user] = fixture("ai-user-inventory.json").data.userInventory.entries.map((u) => mapAiUser(u, T, "2026-11-21", 30));
  matchesTable(user, "fact_ai_user_snapshot");
  assert.equal(user.user_key, userKey(T, user.user_id), "the user key matches the activity user key");
  assert.equal(user.policy_violations, 14);
  assert.equal(user.top_app_id, "microsoft-copilot");

  const [standard, education] = fixture("ai-policies.json").data.policies.policies.map((p) => mapAiPolicy(p, T));
  matchesTable(standard, "dim_ai_policy");
  assert.equal(standard.rules, 3);
  assert.equal(standard.block_rules, 1);
  assert.equal(standard.dns_enabled, false, "a sensor Sophos sends as null is off");
  assert.equal(standard.created_at, "2026-07-23T15:56:53Z");
  assert.equal(education.rank, 2);
  assert.equal(education.app_control_category_action, "WARN");

  const overview = fixture("ai-defense-overview.json").data;
  const snap = mapAiDefenseSnapshot(overview.secureAITenantSettings, overview.inventorySummary, T, "2026-11-21", 30);
  matchesTable(snap, "fact_ai_defense_snapshot");
  assert.equal(snap.license_state, "ACTIVE");
  assert.equal(snap.license_expiry_date, "2027-06-30");
  assert.equal(snap.apps_train_on_data, 1);
  assert.equal(snap.users_with_violations, 1);
  const none = mapAiDefenseSnapshot(null, { apps: {}, users: {} }, T, "2026-11-21", 30);
  assert.equal(none.license_state, null);
  assert.equal(none.renewal_pending, null);
  assert.equal(none.apps, 0);
  assert.equal(none.apps_train_on_data, null);
  assert.equal(riskRank("info"), 1);
  assert.equal(riskRank("ERROR"), 0);
});

test("sensor labels", () => {
  assert.equal(sensorLabel("ENDPOINT_SOPHOS"), "Endpoint");
  assert.equal(sensorLabel("PALOALTO_FIREWALL"), "Palo Alto Networks Firewall");
  assert.equal(sensorLabel("SOMETHING_NEW"), "Something New");
});

test("every table has tenant_id first and a key made of its own columns", () => {
  for (const t of TABLES) {
    assert.equal(t.columns[0].name, "tenant_id", t.name);
    assert.ok(t.key[0] === "tenant_id", t.name);
    for (const k of t.key) assert.ok(t.columns.some((c) => c.name === k), `${t.name}.${k}`);
    assert.equal(new Set(t.columns.map((c) => c.name)).size, t.columns.length, `${t.name} has duplicate columns`);
  }
});
