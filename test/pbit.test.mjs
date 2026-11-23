// The .pbit templates are exported by hand from Power BI Desktop, so
// scripts/check-pbit.mjs compares them with the PBIP projects. It must pass
// the committed templates, ignore what Desktop changes on export, and report
// a model change.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareTemplate, readProject, readTemplate } from "../scripts/check-pbit.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = join(root, "scripts", "check-pbit.mjs");
const PROJECTS = [
  { variant: "csv", name: "FusionExport" },
  { variant: "direct", name: "FusionDirect" },
];

function run(...args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

/** A scratch root holding a copy of one template and its PBIP project. */
function copyProject(variant, name) {
  const dir = mkdtempSync(join(tmpdir(), "fusion-export-pbit-"));
  for (const part of [`${name}.pbit`, `${name}.SemanticModel`, `${name}.Report`]) {
    cpSync(join(root, "powerbi", variant, part), join(dir, "powerbi", variant, part), { recursive: true });
  }
  return dir;
}

test("the committed templates are in step with their PBIP projects", () => {
  const result = run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const { variant, name } of PROJECTS) assert.match(result.stdout, new RegExp(`powerbi/${variant}/${name}\\.pbit: in step`));
});

test("a template is read from its zip: the model, and the page names in report order", () => {
  for (const { variant, name } of PROJECTS) {
    const template = readTemplate(readFileSync(join(root, "powerbi", variant, `${name}.pbit`)));
    const project = readProject(join(root, "powerbi", variant), name);
    assert.equal(template.model.name, name);
    assert.deepEqual(template.model.tables.map((t) => t.name).sort(), project.model.tables.map((t) => t.name).sort());
    assert.deepEqual(template.pages, project.pages);
    assert.ok(template.pages.length >= 2);
  }
});

test("what Desktop changes on export is not drift", () => {
  const project = readProject(join(root, "powerbi", "csv"), "FusionExport");
  const model = structuredClone(project.model);
  const tag = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
  let i = 0;
  model.name = tag(i++);
  model.tables.reverse();
  for (const t of model.tables) {
    t.lineageTag = tag(i++);
    t.annotations = [{ name: "PBI_ResultType", value: "Table" }];
    t.columns.reverse();
    for (const c of t.columns) c.lineageTag = tag(i++);
    t.columns.push({ type: "rowNumber", name: `RowNumber-${tag(i++)}`, dataType: "int64", isHidden: true });
    for (const m of t.measures ?? []) m.expression = `\r\n${normalizeToLines(m.expression).join("\r\n    ")}  `;
    for (const p of t.partitions) {
      p.name = `${t.name}-${tag(i++)}`;
      p.source.expression = normalizeToLines(p.source.expression).flatMap((line) => line.split("\n")).map((line) => `${line}\t`);
    }
  }
  model.tables.push({ name: `LocalDateTable_${tag(i++)}`, columns: [{ name: "Date", dataType: "dateTime" }], partitions: [] });
  for (const e of model.expressions) {
    e.expression = normalizeToLines(e.expression).join("\r\n");
    e.expression = e.expression.replace(/^".*?" meta \[IsParameterQuery=true, /, "null meta [IsParameterQueryRequired=true, IsParameterQuery=true, ").replace(/, IsParameterQueryRequired=true\]$/, "]");
  }
  model.expressions.reverse();
  model.annotations = [];
  model.cultures = [{ name: "en-US", linguisticMetadata: { content: { Version: "2.0.0", Language: "en-US", Entities: {} } } }];
  assert.deepEqual(compareTemplate({ model, pages: project.pages }, project), []);
});

function normalizeToLines(expression) {
  return Array.isArray(expression) ? expression : [expression];
}

test("a changed measure, column, query, parameter or page in the project is drift", () => {
  const dir = copyProject("csv", "FusionExport");
  try {
    const bimPath = join(dir, "powerbi", "csv", "FusionExport.SemanticModel", "model.bim");
    const bim = JSON.parse(readFileSync(bimPath, "utf8"));
    const withMeasure = bim.model.tables.find((t) => t.measures?.length);
    const measure = withMeasure.measures[0];
    measure.expression = `${normalizeToLines(measure.expression).join("\n")} + 1`;
    const table = bim.model.tables[0];
    table.columns[1].dataType = "int64";
    table.columns.push({ name: "added_column", dataType: "string", sourceColumn: "added_column" });
    const helper = bim.model.expressions.find((e) => e.name === "FusionFiles");
    helper.expression = normalizeToLines(helper.expression).join("\n").replace('".csv"', '".tsv"');
    const parameter = bim.model.expressions.find((e) => e.name === "ExportFolder");
    parameter.expression = parameter.expression.replace("IsParameterQueryRequired=true", "IsParameterQueryRequired=false");
    writeFileSync(bimPath, JSON.stringify(bim, null, 2));
    const pagePath = join(dir, "powerbi", "csv", "FusionExport.Report", "definition", "pages", "alerts", "page.json");
    const page = JSON.parse(readFileSync(pagePath, "utf8"));
    writeFileSync(pagePath, JSON.stringify({ ...page, displayName: "Product alerts" }));

    const result = run(dir);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const out = result.stdout;
    assert.match(out, /powerbi\/csv\/FusionExport\.pbit: 7 differences/);
    assert.ok(out.includes(`measure ${withMeasure.name}[${measure.name}]: expression differs`), out);
    assert.ok(out.includes(`column ${table.name}[${table.columns[1].name}]: data type string in the template, int64 in the project`), out);
    assert.ok(out.includes(`column ${table.name}[added_column]: only in the project`), out);
    assert.ok(out.includes("query FusionFiles: Power Query differs"), out);
    assert.ok(out.includes("parameter ExportFolder: settings differ"), out);
    assert.ok(out.includes('page "Alerts": only in the template'), out);
    assert.ok(out.includes('page "Product alerts": only in the project'), out);
    assert.match(out, /File > Export > Power BI template/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a template that can't be read is an error, not drift", () => {
  const dir = copyProject("direct", "FusionDirect");
  try {
    const pbit = join(dir, "powerbi", "direct", "FusionDirect.pbit");
    const bytes = readFileSync(pbit);
    bytes[bytes.indexOf("DataModelSchema") + 200] ^= 0xff;
    writeFileSync(pbit, bytes);
    let result = run(dir);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /FusionDirect\.pbit: can't check: /);
    writeFileSync(pbit, "not a zip file");
    result = run(dir);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /FusionDirect\.pbit: can't check: not a readable zip file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no templates at all is an error", () => {
  const dir = mkdtempSync(join(tmpdir(), "fusion-export-pbit-"));
  try {
    assert.equal(run(dir).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
