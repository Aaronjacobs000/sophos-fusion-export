// Every column the Grafana dashboards and the Power BI templates read must
// exist in the CSV schema, so a schema change can't silently break a report.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { TABLES } from "../dist/schema/tables.js";
import { CASES_PAGE, DETECTION_SEARCH } from "../dist/sophos/documents.js";

const root = new URL("../", import.meta.url);
const columnsOf = new Map(TABLES.map((t) => [`${t.name}.csv`, new Set(t.columns.map((c) => c.name))]));
// The name of the assistant that helped build this, spelled out so the word itself stays out of the repository.
const ASSISTANT = new RegExp(String.fromCharCode(99, 108, 97, 117, 100, 101), "i");
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
    assert.ok(!ASSISTANT.test(JSON.stringify(dashboard)));
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

const models = semanticModels();

test("both Power BI paths ship a semantic model and a report", () => {
  assert.deepEqual(models.map((m) => m.variant).sort(), ["csv", "direct"]);
});

for (const { variant, path } of models) {
  const bim = JSON.parse(readFileSync(path, "utf8"));
  const tables = new Map(bim.model.tables.map((t) => [t.name, t]));
  const columnsIn = (table) => new Set((tables.get(table)?.columns ?? []).map((c) => c.name));
  const measuresIn = (table) => new Set((tables.get(table)?.measures ?? []).map((m) => m.name));

  test(`Power BI ${variant}: every model column exists in the CSV schema with the same type`, () => {
    const types = { string: "string", integer: "int64", number: "double", boolean: "boolean", datetime: "dateTime", date: "dateTime" };
    for (const t of bim.model.tables) {
      if (t.name === "Date") continue;
      const schema = TABLES.find((x) => x.name === t.name);
      assert.ok(schema, `${variant}: model table ${t.name} is not an exporter table`);
      for (const c of t.columns) {
        const sc = schema.columns.find((x) => x.name === c.name);
        assert.ok(sc, `${variant}: ${t.name}.${c.name} is not in the CSV schema`);
        assert.equal(c.dataType, types[sc.type], `${variant}: ${t.name}.${c.name} type`);
      }
      if (variant === "csv") {
        const m = t.partitions[0].source.expression.join("\n");
        assert.match(m, new RegExp(`FusionTable\\("${t.name}\\.csv"`), `${t.name} reads its own file`);
        for (const sc of schema.columns) assert.ok(m.includes(`{"${sc.name}", "`), `${variant}: ${t.name} M reads ${sc.name}`);
      }
    }
  });

  test(`Power BI ${variant}: relationships, measures and report fields point at real columns`, () => {
    for (const r of bim.model.relationships) {
      assert.ok(columnsIn(r.fromTable).has(r.fromColumn), `${r.fromTable}.${r.fromColumn}`);
      assert.ok(columnsIn(r.toTable).has(r.toColumn), `${r.toTable}.${r.toColumn}`);
    }
    for (const t of bim.model.tables) {
      for (const m of t.measures ?? []) {
        for (const [, table, col] of m.expression.matchAll(/'?([A-Za-z_][A-Za-z0-9_ ]*)'?\[([^\]]+)\]/g)) {
          const name = table.trim();
          if (!tables.has(name)) continue;
          assert.ok(columnsIn(name).has(col) || measuresIn(name).has(col), `${variant} measure ${m.name}: ${name}[${col}]`);
        }
        assert.ok(!columnsIn(t.name).has(m.name.toLowerCase()), `measure ${m.name} clashes with a column`);
      }
    }
    const reportDir = new URL(`powerbi/${variant}/${path.pathname.split("/").at(-2).replace(".SemanticModel", ".Report")}/definition/pages/`, root);
    let fields = 0;
    for (const page of readdirSync(reportDir).filter((p) => !p.endsWith(".json"))) {
      for (const v of readdirSync(new URL(`${page}/visuals/`, reportDir))) {
        const visual = JSON.parse(readFileSync(new URL(`${page}/visuals/${v}/visual.json`, reportDir), "utf8"));
        for (const role of Object.values(visual.visual.query?.queryState ?? {})) {
          for (const p of role.projections) {
            const ref = p.field.Column ?? p.field.Measure;
            const entity = ref.Expression.SourceRef.Entity;
            const set = p.field.Column ? columnsIn(entity) : measuresIn(entity);
            assert.ok(set.has(ref.Property), `${variant} ${page}/${v}: ${entity}.${ref.Property}`);
            fields++;
          }
        }
      }
    }
    assert.ok(fields > 10);
  });

  test(`Power BI ${variant}: every Power Query expression parses`, async () => {
    const pq = await import("@microsoft/powerquery-parser");
    const texts = [
      ...bim.model.expressions.map((e) => [e.name, Array.isArray(e.expression) ? e.expression.join("\n") : e.expression]),
      ...bim.model.tables.flatMap((t) => t.partitions.filter((p) => p.source.type === "m").map((p) => [t.name, p.source.expression.join("\n")])),
    ];
    for (const [name, text] of texts) {
      const result = await pq.TaskUtils.tryLexParse(pq.DefaultSettings, text);
      assert.ok(pq.TaskUtils.isParseStageOk(result), `${variant} ${name}: ${result.error?.message ?? result.stage}`);
    }
  });
}

test("the direct path sends the exporter's own GraphQL documents, unchanged", () => {
  const bim = JSON.parse(readFileSync(models.find((m) => m.variant === "direct").path, "utf8"));
  const docs = Object.fromEntries(bim.model.expressions.filter((e) => e.name.startsWith("Doc")).map((e) => [e.name, e.expression]));
  const unquote = (m) => m.slice(1, -1).replace(/""/g, '"');
  assert.equal(unquote(docs.DocCases), CASES_PAGE);
  assert.equal(unquote(docs.DocDetections), DETECTION_SEARCH);
  const secret = bim.model.expressions.find((e) => e.name === "SophosClientSecret");
  assert.match(secret.expression, /^"" meta/, "the template ships with an empty secret");
});

test("no template names an AI assistant or points at a real site", () => {
  for (const { path } of models) {
    const text = readFileSync(path, "utf8");
    assert.ok(!ASSISTANT.test(text));
    for (const [, host] of text.matchAll(/https:\/\/([a-z0-9-]+)\.sharepoint\.com/g)) assert.equal(host, "contoso", "templates ship with placeholder sites only");
  }
});
