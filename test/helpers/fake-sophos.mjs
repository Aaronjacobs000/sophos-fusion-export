// A fake Sophos for tests: token, whoami and the documented APIs the exporter
// reads, answered from the sanitized fixtures. Every request is recorded.
import { readFileSync } from "node:fs";

export function fixture(name) {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

/**
 * options.overrides: { [operationOrPath]: (request) => body | Response }
 * options.notOnFusion: answer every GraphQL call with the 503 a Classic tenant gets
 */
export function fakeSophos(options = {}) {
  const requests = [];
  const overrides = options.overrides ?? {};
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const method = (init.method ?? "GET").toUpperCase();
    const record = { method, host: url.hostname, path: url.pathname, search: url.search, headers: init.headers ?? {}, body: init.body };
    requests.push(record);
    if (url.hostname === "id.sophos.com") return json({ access_token: "fake-token", token_type: "bearer", expires_in: 3600, errorCode: "success" });
    if (url.hostname === "api.taegis.sophos.com") {
      if (options.notOnFusion) return json({ errors: [{ message: "tenant 1 not found or not accessible" }] }, 503);
      const body = JSON.parse(init.body);
      const op = /query\s+(\w+)/.exec(body.query)[1];
      record.operation = op;
      record.variables = body.variables;
      if (overrides[op]) {
        const answer = overrides[op](record);
        return answer instanceof Response ? answer : json(answer);
      }
      switch (op) {
        case "ExportCasesPage": return json(fixture("cases-page.json"));
        case "ExportCaseReferenceData": return json(fixture("case-reference.json"));
        case "ExportDetectionCount": return json({ data: { detectionCountByTenant: { items: [{ count: fixture("detections-page.json").data.detectionSearch.alerts.list.length, tenant: { id: "100001" } }] } } });
        case "ExportDetectionSearch": return json(fixture("detections-page.json"));
        case "ExportAiDefenseOverview": return json(fixture("ai-defense-overview.json"));
        case "ExportAiActivities": return json(fixture(body.variables.after === "cursor-1" ? "ai-activities-page-2.json" : "ai-activities-page.json"));
        case "ExportAiAppInventory": return json(fixture("ai-app-inventory.json"));
        case "ExportAiUserInventory": return json(fixture("ai-user-inventory.json"));
        case "ExportAiAppSanctioning": return json(fixture("ai-app-sanctioning.json"));
        case "ExportAiPolicies": return json(fixture("ai-policies.json"));
        default: return json({ errors: [{ message: `unknown operation ${op}` }] });
      }
    }
    if (overrides[url.pathname]) {
      const answer = overrides[url.pathname](record);
      return answer instanceof Response ? answer : json(answer);
    }
    switch (url.pathname) {
      case "/whoami/v1": return json(fixture("whoami.json"));
      case "/licenses/v1/licenses": return json(fixture("licenses.json"));
      case "/endpoint/v1/endpoints": return json(fixture("endpoints-page.json"));
      case "/account-health-check/v1/health-check": return json(fixture("health-check.json"));
      case "/common/v1/alerts": return json(fixture("alerts-page.json"));
      case "/cases/v1/cases": return json(fixture("legacy-cases-page.json"));
      default: return json({ error: "NotFound", message: `no fake for ${url.pathname}` }, 404);
    }
  };
  return { fetch, requests };
}
