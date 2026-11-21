// Every column the Grafana dashboards and the Power BI templates read must
// exist in the CSV schema, so a schema change can't silently break a report.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { TABLES } from "../dist/schema/tables.js";

const root = new URL("../", import.meta.url);
const columnsOf = new Map(TABLES.map((t) => [`${t.name}.csv`, new Set(t.columns.map((c) => c.name))]));
const KEYWORDS = new Set(["true", "false", "nil", "null", "and", "or", "not", "in"]);

function infinityTargets(dashboard) {
  const out = [];
  for (const panel of dashboard.panels ?? []) for (const t of panel.targets ?? []) out.push({ where: panel.title, target: t });
  for (const v of dashboard.templating?.list ?? []) if (v.query?.infinityQuery) out.push({ where: `variable ${v.name}`, target: v.query.infinityQuery });
  return out;
}

/** Identifiers an Infinity backend expression uses, leaving out quoted text, macros and numbers. */
function identifiers(expression) {
  const bare = expression
    .replace(/\$\{[^}]*\}/g, " ")
    .replace(/'[^']*'|"[^"]*"/g, " ");
  return [...bare.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].map((m) => m[0]).filter((w) => !KEYWORDS.has(w));
}

const dashboards = readdirSync(new URL("grafana/dashboards/", root)).filter((f) => f.endsWith(".json"));

test("there are Grafana dashboards to check", () => {
  assert.deepEqual(dashboards.sort(), ["cases.json", "detections.json", "endpoints.json", "overview.json"]);
});

for (const file of dashboards) {
  test(`Grafana ${file}: every table and column it reads exists`, () => {
    const dashboard = JSON.parse(readFileSync(new URL(`grafana/dashboards/${file}`, root), "utf8"));
    assert.match(dashboard.title, /^Fusion Export: /);
    assert.ok(!/claude/i.test(JSON.stringify(dashboard)));
    for (const { where, target } of infinityTargets(dashboard)) {
      assert.equal(target.datasource.uid, "fusion-export-csv", where);
      assert.equal(target.parser, "backend", `${where} runs server side`);
      const table = target.url.replace(/^\//, "");
      const columns = columnsOf.get(table);
      assert.ok(columns, `${where}: ${table} is not a table the exporter writes`);
      for (const c of target.columns) assert.ok(columns.has(c.selector), `${where}: ${table} has no column ${c.selector}`);
      const selected = new Set(target.columns.map((c) => c.selector));
      const computed = new Set((target.computed_columns ?? []).map((c) => c.text));
      for (const c of target.computed_columns ?? []) for (const id of identifiers(c.selector)) assert.ok(selected.has(id), `${where}: computed column uses ${id}, which the query does not select`);
      for (const expr of [target.filterExpression, target.summarizeExpression]) {
        for (const id of identifiers(expr ?? "")) {
          if (["sum", "count", "mean", "min", "max", "first", "last"].includes(id)) continue;
          assert.ok(selected.has(id) || computed.has(id), `${where}: expression uses ${id}, which the query does not select`);
        }
      }
      if (target.summarizeBy) assert.ok(selected.has(target.summarizeBy) || computed.has(target.summarizeBy), `${where}: summarize by ${target.summarizeBy}`);
    }
  });
}

test("Grafana provisioning points at the CSV data source the dashboards use", () => {
  const ds = readFileSync(new URL("grafana/provisioning/datasources/fusion-export.yaml", root), "utf8");
  assert.match(ds, /uid: fusion-export-csv/);
  assert.match(ds, /type: yesoreyeram-infinity-datasource/);
  assert.match(ds, /\$\{FUSION_EXPORT_CSV_URL\}/);
});

// ---------- Power BI ----------

function semanticModels() {
  const dir = new URL("powerbi/", root);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const variant of readdirSync(dir)) {
    const base = new URL(`powerbi/${variant}/`, root);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) if (entry.endsWith(".SemanticModel")) out.push({ variant, path: new URL(`powerbi/${variant}/${entry}/model.bim`, root) });
  }
  return out;
}

export { semanticModels, columnsOf };
