#!/usr/bin/env node
/**
 * Writes demo/: a synthetic export for trying the Grafana dashboards and the
 * Power BI template without a Sophos tenant. Every name, ID, host and number
 * in it is made up. It runs the real exporter against a fake Sophos built
 * here, so the files have exactly the shape a real export has.
 *
 *   npm run build && node scripts/make-demo.mjs [--out demo] [--days 45]
 */

import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { buildConfig } from "../dist/config.js";
import { runExport } from "../dist/runner.js";
import { SophosSession } from "../dist/sophos/session.js";

const argv = process.argv.slice(2);
const opt = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const out = resolve(opt("out", "demo"));
const DAYS = Number(opt("days", "45"));
const NOW = new Date("2026-11-20T22:00:00Z");
const TENANT = "00000000-0000-4000-8000-00000000d3e0";

// Seeded PRNG, so the demo is the same on every machine.
let seed = 20261121;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (list) => list[Math.floor(rand() * list.length)];
const id = (prefix, n) => `${prefix}${String(n).padStart(12, "0")}`;
const uuid = (n) => `d3e00000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const DETECTORS = [
  ["app:demo:watchlist", "Endpoint Watchlist", 0.45],
  ["app:demo:email", "Email Watchlist", 0.3],
  ["app:demo:tactic", "Tactic Graphs Detector", 0.62],
  ["app:demo:identity", "Identity Risk", 0.7],
  ["app:demo:custom", "Custom Alerts", 0.5],
  ["app:demo:ndr", "Network Anomaly", 0.84],
];
const TECHNIQUES = [
  ["T1059.001", "PowerShell", ["execution"]],
  ["T1078.002", "Domain Accounts", ["persistence", "initial-access"]],
  ["T1021.002", "SMB/Windows Admin Shares", ["lateral-movement"]],
  ["T1566.001", "Spearphishing Attachment", ["initial-access"]],
  ["T1003.001", "LSASS Memory", ["credential-access"]],
  ["T1071.001", "Web Protocols", ["command-and-control"]],
  ["T1082", "System Information Discovery", ["discovery"]],
  ["T1486", "Data Encrypted for Impact", ["impact"]],
];
const SENSORS = ["ENDPOINT_SOPHOS", "SOPHOS_EMAIL", "SOPHOS_SFOS", "MICROSOFT_GRAPH_SIGN_IN", "SOPHOS_NDR"];
const STATUSES = ["OPEN", "OPEN", "OPEN", "OPEN", "TRUE_POSITIVE_BENIGN", "FALSE_POSITIVE", "NOT_ACTIONABLE"];

const detections = [];
for (let d = DAYS; d >= 0; d--) {
  const perDay = 40 + Math.floor(rand() * 60) + (d % 7 === 2 ? 120 : 0);
  for (let i = 0; i < perDay; i++) {
    const created = Math.floor((NOW.getTime() - d * 86_400_000 - rand() * 86_400_000) / 1000);
    if (created * 1000 > NOW.getTime()) continue;
    const [detectorId, detectorName, base] = pick(DETECTORS);
    const severity = Math.max(0.01, Math.min(0.99, base + (rand() - 0.5) * 0.5));
    const techniques = rand() < 0.6 ? [pick(TECHNIQUES)] : rand() < 0.5 ? [pick(TECHNIQUES), pick(TECHNIQUES)] : [];
    detections.push({
      id: `alert://priv:demo:100000:${created}000:${uuid(detections.length)}`,
      status: pick(STATUSES),
      resolution_reason: "",
      attack_technique_ids: techniques.map((t) => t[0]),
      sensor_types: [pick(SENSORS)],
      threat_score: Math.round(rand() * 100) / 10,
      metadata: {
        title: `${detectorName}: demo activity`,
        description: "Synthetic detection for the demo export.",
        severity: Math.round(severity * 100) / 100,
        confidence: Math.round(rand() * 100) / 100,
        created_at: { seconds: created },
        first_seen_at: null,
        creator: { detector: { detector_id: detectorId, detector_name: detectorName } },
      },
      enrichment_details: techniques.map(([technique_id, technique, tactics]) => ({ mitre_attack_info: { technique_id, technique, tactics } })),
      investigation_ids: [],
      source_entities: [{ display_name: `DEMO-PC-${String(Math.floor(rand() * 25)).padStart(2, "0")}`, subtype: "Endpoint" }],
      target_entities: [],
    });
  }
}

const TYPES = [["t-inv", "investigation", "Investigation"], ["t-sec", "security_case", "Security Case"], ["t-mr", "managed_risk", "Managed Risk"]];
const PRIMARY = [["s-new", "new", "New", false], ["s-prog", "in_progress", "In Progress", false], ["s-cust", "customer_action_required", "Customer Action Required", false], ["s-closed", "closed", "Closed", true]];
const VERDICTS = [["v-fp", "false_positive", "False Positive"], ["v-tpb", "true_positive_benign", "True Positive - Benign"], ["v-tpm", "true_positive_malicious", "True Positive - Malicious"], ["v-inc", "inconclusive", "Inconclusive"]];
const cases = Array.from({ length: 48 }, (_, n) => {
  const created = new Date(NOW.getTime() - rand() * DAYS * 86_400_000);
  const status = rand() < 0.55 ? PRIMARY[3] : pick(PRIMARY.slice(0, 3));
  const closed = status[3] ? new Date(Math.min(NOW.getTime(), created.getTime() + rand() * 5 * 86_400_000)) : null;
  const type = pick(TYPES);
  const verdict = closed ? pick(VERDICTS) : null;
  return {
    id: uuid(90000 + n),
    shortId: `D-${String(100 + n).padStart(5, "0")}`,
    title: `Demo case ${n + 1}`,
    severity: pick([2, 4, 6, 6, 8, 8, 8, 10]),
    type: { id: type[0], name: type[1], title: type[2] },
    primaryStatus: { id: status[0], name: status[1], title: status[2], isClosed: status[3] },
    secondaryStatus: null,
    primaryVerdict: verdict ? { id: verdict[0], name: verdict[1], title: verdict[2] } : null,
    secondaryVerdict: null,
    closeReason: null,
    managedBy: rand() < 0.35 ? "PROVIDER" : rand() < 0.9 ? "CUSTOMER" : null,
    isCreatedByMDRProvider: rand() < 0.3,
    isCreatedByPartner: false,
    assigneeId: rand() < 0.5 ? "@demo-soc" : null,
    tenantId: "100000",
    createdAt: created.toISOString(),
    updatedAt: (closed ?? created).toISOString(),
    closedAt: closed ? closed.toISOString() : null,
    archivedAt: null,
    riskScore: Math.round(rand() * 100) / 10,
    source: null,
    tags: [],
    detectionsCount: Math.floor(rand() * 12),
    eventsCount: Math.floor(rand() * 30),
    assetsCount: 1 + Math.floor(rand() * 3),
  };
});

const OS = [["windows", "Windows 11 Enterprise", 10, 0, 26100, "computer"], ["windows", "Windows Server 2022 Standard", 10, 0, 20348, "server"], ["macOS", "macOS Tahoe 26.5", 26, 5, undefined, "computer"], ["linux", "Ubuntu 24.04.4 LTS", 24, 4, undefined, "server"]];
const endpoints = Array.from({ length: 28 }, (_, n) => {
  const [platform, name, majorVersion, minorVersion, build, type] = pick(OS);
  const stale = rand() < 0.12;
  return {
    id: uuid(50000 + n),
    type,
    hostname: `DEMO-${type === "server" ? "SRV" : "PC"}-${String(n).padStart(2, "0")}`,
    health: { overall: stale ? "bad" : rand() < 0.1 ? "suspicious" : "good", threats: { status: "good" }, services: { status: stale ? "bad" : "good" } },
    os: { platform, name, majorVersion, minorVersion, build },
    ipv4Addresses: [`10.20.${Math.floor(n / 10)}.${10 + n}`],
    associatedPerson: { viaLogin: `DEMO\\user${n}` },
    tamperProtectionEnabled: rand() > 0.08,
    tamperProtectionSupported: true,
    assignedProducts: [{ code: "coreAgent", version: pick(["2026.3.0.2103", "2026.3.0.2117", "2026.2.2.1"]), status: "installed" }, { code: "endpointProtection", version: "10.8.11", status: "installed" }],
    lastSeenAt: new Date(NOW.getTime() - (stale ? 9 + rand() * 30 : rand()) * 86_400_000).toISOString(),
    online: !stale,
    mdrManaged: true,
    group: { name: type === "server" ? "Servers" : "Workstations" },
    isolation: { status: "notIsolated" },
    lockdown: { status: "notInstalled" },
    packages: { protection: { name: "MDR", assignedId: "MDR" } },
  };
});

const alerts = Array.from({ length: 30 }, (_, n) => ({
  id: uuid(70000 + n),
  raisedAt: new Date(NOW.getTime() - rand() * 20 * 86_400_000).toISOString(),
  severity: pick(["high", "medium", "medium", "low"]),
  category: pick(["malware", "policy", "updating", "wireless", "integrations"]),
  product: pick(["endpoint", "server", "wireless", "other"]),
  type: "Event::Demo::Alert",
  status: "open",
  description: "Synthetic alert for the demo export.",
  eventCount: 1,
  managedAgent: {},
  tenant: { id: TENANT, name: "Example Corp (demo)" },
}));

const licenses = {
  licenses: [
    { id: "DEMO-0001", product: { code: "MDR-COMPLETE", name: "Sophos MDR Complete - User" }, type: "term", quantity: 30, startDate: "2026-01-01", endDate: "2027-12-31", usage: { current: { count: 26 } } },
    { id: "DEMO-0002", product: { code: "SVRMDR-COMPLETE", name: "Sophos MDR Complete - Server" }, type: "term", quantity: 10, startDate: "2026-01-01", endDate: "2027-12-31", usage: { current: { count: 7 } } },
    { id: "DEMO-0003", product: { code: "CZTNA", name: "Sophos ZTNA" }, type: "trial", quantity: 25, startDate: "2026-11-01", endDate: "2026-12-01", usage: { current: { count: 3 } } },
  ],
  tenant: { id: TENANT },
};

const health = {
  endpoint: {
    protection: { computer: { score: 95, total: 20, notFullyProtected: 1, snoozed: false }, server: { score: 100, total: 8, notFullyProtected: 0, snoozed: false } },
    policy: { computer: { "threat-protection": { score: 80, total: 3, notOnRecommended: 1, snoozed: false } } },
    exclusions: { global: { score: 60, numberOfSecurityRisks: 2, snoozed: false } },
    tamperProtection: { computer: { score: 90, total: 20, disabled: 2, snoozed: false }, server: { score: 100, total: 8, disabled: 0, snoozed: false } },
  },
};

function window(ql) {
  const m = /EARLIEST='([^']+)' LATEST='([^']+)'/.exec(ql);
  const from = Date.parse(m[1]) / 1000;
  const to = Date.parse(m[2]) / 1000;
  return detections.filter((d) => d.metadata.created_at.seconds >= from && d.metadata.created_at.seconds <= to);
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function fakeFetch(input, init = {}) {
  const url = new URL(input);
  if (url.hostname === "id.sophos.com") return json({ access_token: "demo", token_type: "bearer", expires_in: 3600 });
  if (url.hostname === "api.taegis.sophos.com") {
    const body = JSON.parse(init.body);
    const op = /query\s+(\w+)/.exec(body.query)[1];
    if (op === "ExportCasesPage") return json({ data: { cases: { totalCount: cases.length, pageInfo: { endCursor: null, hasNextPage: false }, cases } } });
    if (op === "ExportCaseReferenceData") {
      return json({ data: {
        caseTypes: { types: TYPES.map(([i, n, t]) => ({ id: i, name: n, title: t, managedBy: null })) },
        casePrimaryStatuses: { primaryStatuses: PRIMARY.map(([i, n, t, c]) => ({ id: i, name: n, title: t, isClosed: c })) },
        caseSecondaryStatuses: { secondaryStatuses: [] },
        casePrimaryVerdicts: { primaryVerdicts: VERDICTS.map(([i, n, t]) => ({ id: i, name: n, title: t })) },
        caseSecondaryVerdicts: { secondaryVerdicts: [] },
      } });
    }
    if (op === "ExportDetectionCount") return json({ data: { detectionCountByTenant: { items: [{ count: window(body.variables.in.ql_query).length, tenant: { id: "100000" } }] } } });
    if (op === "ExportDetectionSearch") {
      const list = window(body.variables.in.cql_query).slice(0, body.variables.in.limit);
      return json({ data: { detectionSearch: { status: "OK", reason: "success", alerts: { total_results: list.length, list } } } });
    }
  }
  switch (url.pathname) {
    case "/whoami/v1": return json({ id: TENANT, idType: "tenant", apiHosts: { global: "https://api.central.sophos.com", dataRegion: "https://api-eu01.central.sophos.com" } });
    case "/licenses/v1/licenses": return json(licenses);
    case "/endpoint/v1/endpoints": return json({ items: endpoints, pages: {} });
    case "/account-health-check/v1/health-check": return json(health);
    case "/common/v1/alerts": return json({ items: alerts, pages: {} });
    default: return json({ error: "NotFound" }, 404);
  }
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const config = buildConfig({ outputDir: out, reportTimezone: "Australia/Sydney", tenantName: "Example Corp (demo)" });
const session = await SophosSession.open({ clientId: "demo", clientSecret: "demo", baseFetch: fakeFetch, perMinute: 100 });
const summary = await runExport({ config, mode: "backfill", backfillDays: DAYS, credentials: { clientId: "", clientSecret: "" }, now: NOW, session });
rmSync(resolve(out, "_state"), { recursive: true, force: true });
console.log(`demo written to ${out}: ${Object.entries(summary.tables).map(([t, n]) => `${t} ${n}`).join(", ")}`);
