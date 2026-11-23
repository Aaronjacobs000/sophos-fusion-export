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
import { crc32 } from "node:zlib";
import { compareTemplate, filledParameters, readProject, readTemplate, readZip, securityBindings } from "../scripts/check-pbit.mjs";

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
  assert.doesNotMatch(result.stdout, /with a value/);
  assert.doesNotMatch(result.stdout, /SecurityBindings/);
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

/** A stored (uncompressed) zip of the given entries, enough for readZip. */
function writeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(33, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x800, 8);
    dir.writeUInt16LE(33, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    central.push(dir, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const dirBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.size, 8);
  end.writeUInt16LE(entries.size, 10);
  end.writeUInt32LE(dirBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dirBytes, end]);
}

/** Rewrites a .pbit in place: change gets its parts as a map of name to bytes. */
function rewriteTemplate(pbit, change) {
  const entries = new Map([...readZip(readFileSync(pbit))].map(([name, read]) => [name, read()]));
  change(entries);
  writeFileSync(pbit, writeZip(entries));
}

/** Rewrites JSON parts of a .pbit in place, keeping Desktop's UTF-16 LE encoding. */
function editTemplate(pbit, edits) {
  rewriteTemplate(pbit, (entries) => {
    for (const [part, edit] of Object.entries(edits)) {
      const json = JSON.parse(entries.get(part).toString("utf16le"));
      edit(json);
      entries.set(part, Buffer.from(JSON.stringify(json), "utf16le"));
    }
  });
}

/** Gives a parameter a new M text, keeping it an array when Desktop wrote one. */
function setText(holder, key, text) {
  holder[key] = Array.isArray(holder[key]) ? [text] : text;
}

test("the committed templates ship every parameter blank, in the model and the unapplied edits", () => {
  for (const { variant, name } of PROJECTS) {
    const template = readTemplate(readFileSync(join(root, "powerbi", variant, `${name}.pbit`)));
    assert.deepEqual(filledParameters(template), []);
    assert.ok(template.unapplied.length > 0);
  }
  const direct = readTemplate(readFileSync(join(root, "powerbi", "direct", "FusionDirect.pbit")));
  for (const parameter of ["SophosClientId", "SophosClientSecret", "SophosRegionHost", "DetectionDays"]) {
    assert.ok(direct.model.expressions.some((e) => e.name === parameter), parameter);
    assert.ok(direct.unapplied.some((q) => q.name === parameter), parameter);
  }
});

test("a parameter holds a value unless it is null or empty, with nothing in its meta record or after it", () => {
  const meta = 'meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=true]';
  const expressions = [
    ["NullValue", `null ${meta}`],
    ["EmptyValue", `"" ${meta}`],
    ["EmptyList", 'null meta [IsParameterQuery=true, List={}, DefaultValue=null, Type="Text", IsParameterQueryRequired=true]'],
    ["TextValue", `"value" ${meta}`],
    ["NumberValue", "7 meta [IsParameterQuery=true, Type=\"Number\", IsParameterQueryRequired=true]"],
    ["ListValue", 'null meta [IsParameterQuery=true, List={"value"}, Type="Text", IsParameterQueryRequired=true]'],
    ["DefaultValue", 'null meta [IsParameterQuery=true, DefaultValue="value", Type="Text", IsParameterQueryRequired=true]'],
    ["Appended", `null ${meta} & "value"`],
    ["NotAParameter", 'let Source = "value" in Source'],
  ].map(([name, expression]) => ({ name, expression }));
  const unapplied = [{ name: "PendingValue", expression: [`"value" ${meta}`] }];
  assert.deepEqual(filledParameters({ model: { expressions }, unapplied }), ["Appended", "DefaultValue", "ListValue", "NumberValue", "PendingValue", "TextValue"]);
});

test("a template with a filled parameter fails with exit 3 and names the parameter, never its value", () => {
  const dir = copyProject("direct", "FusionDirect");
  const secret = "fake-secret-c8f1e2d4b7a9";
  const clientId = "fake-client-id-5d3e9a71";
  const host = "fake-host-a1b2c3.example";
  try {
    const pbit = join(dir, "powerbi", "direct", "FusionDirect.pbit");
    editTemplate(pbit, {
      DataModelSchema: (schema) => {
        const expressions = schema.model.expressions;
        const secretParameter = expressions.find((e) => e.name === "SophosClientSecret");
        setText(secretParameter, "expression", normalizeToLines(secretParameter.expression).join("\n").replace(/^null/, `"${secret}"`));
        const hostParameter = expressions.find((e) => e.name === "SophosRegionHost");
        setText(hostParameter, "expression", normalizeToLines(hostParameter.expression).join("\n").replace("IsParameterQuery=true,", `IsParameterQuery=true, DefaultValue="${host}",`));
      },
      UnappliedChanges: (pending) => {
        const idParameter = pending.queries.find((q) => q.name === "SophosClientId");
        setText(idParameter, "text", normalizeToLines(idParameter.text).join("\n").replace(/^null/, `"${clientId}"`));
      },
    });

    const result = run(dir);
    assert.equal(result.status, 3, result.stdout + result.stderr);
    const out = result.stdout;
    assert.match(out, /powerbi\/direct\/FusionDirect\.pbit: 3 parameters with a value/);
    for (const name of ["SophosClientId", "SophosClientSecret", "SophosRegionHost"]) {
      assert.ok(out.includes(`  parameter ${name}: holds a value; templates ship every parameter blank`), out);
    }
    assert.ok(!out.includes("parameter DetectionDays: holds a value"), out);
    assert.ok(out.includes("parameter SophosRegionHost: settings differ (not shown: it holds a value)"), out);
    assert.doesNotMatch(out, /FusionDirect\.pbit: in step/);
    assert.match(out, /File > Export > Power BI template/);
    assert.match(out, /treat that credential as exposed and replace it/);
    for (const value of [secret, clientId, host]) assert.ok(!(result.stdout + result.stderr).includes(value), "a parameter value was printed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the committed templates carry no SecurityBindings part and no [Content_Types].xml line for one", () => {
  for (const { variant, name } of PROJECTS) {
    const zip = readZip(readFileSync(join(root, "powerbi", variant, `${name}.pbit`)));
    assert.ok(zip.has("[Content_Types].xml"), name);
    assert.deepEqual(securityBindings(zip), [], name);
  }
});

test("SecurityBindings is found as a part in any case, and as an Override or Default in [Content_Types].xml", () => {
  const zipOf = (parts) => new Map(Object.entries(parts).map(([name, text]) => [name, () => Buffer.from(text, "utf8")]));
  const clean = '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="" /><Override PartName="/DataModelSchema" ContentType="" /></Types>';
  assert.deepEqual(securityBindings(zipOf({ "[Content_Types].xml": clean, DataModelSchema: "{}" })), []);
  const named = clean.replace(
    "</Types>",
    '<Override PartName="/SecurityBindings" ContentType="" /><ct:Default Extension="securitybindings" ContentType="" /></Types>',
  );
  assert.deepEqual(securityBindings(zipOf({ "[Content_Types].xml": named, securitybindings: "x" })), [
    "part securitybindings: tied to the Windows sign-in that exported the template",
    "[Content_Types].xml: an Override that names SecurityBindings",
    "[Content_Types].xml: a Default that names SecurityBindings",
  ]);
  const utf16 = new Map([["[content_types].xml", () => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(named, "utf16le")])]]);
  assert.equal(securityBindings(utf16).length, 2);
});

test("a template that still carries the SecurityBindings part fails with exit 3 and names it, never its bytes", () => {
  const dir = copyProject("direct", "FusionDirect");
  const marker = "fake-binding-3e7c91d0a5b2";
  try {
    const pbit = join(dir, "powerbi", "direct", "FusionDirect.pbit");
    rewriteTemplate(pbit, (entries) => entries.set("SecurityBindings", Buffer.concat([Buffer.from([0x01, 0x00, 0x00, 0x00, 0xd0, 0x8c]), Buffer.from(marker)])));

    const result = run(dir);
    assert.equal(result.status, 3, result.stdout + result.stderr);
    const out = result.stdout;
    assert.match(out, /powerbi\/direct\/FusionDirect\.pbit: still carries SecurityBindings/);
    assert.ok(out.includes("  part SecurityBindings: tied to the Windows sign-in that exported the template"), out);
    assert.ok(!out.includes("[Content_Types].xml:"), out);
    assert.doesNotMatch(out, /FusionDirect\.pbit: in step/);
    assert.match(out, /To fix SecurityBindings: delete the SecurityBindings part/);
    assert.ok(!(result.stdout + result.stderr).includes(marker), "the part's bytes were printed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a template whose [Content_Types].xml still names SecurityBindings fails with exit 3, with no part left", () => {
  const dir = copyProject("csv", "FusionExport");
  try {
    const pbit = join(dir, "powerbi", "csv", "FusionExport.pbit");
    rewriteTemplate(pbit, (entries) => {
      const types = entries.get("[Content_Types].xml").toString("utf8");
      entries.set("[Content_Types].xml", Buffer.from(types.replace("</Types>", '<Override PartName="/SecurityBindings" ContentType="" /></Types>'), "utf8"));
    });

    const result = run(dir);
    assert.equal(result.status, 3, result.stdout + result.stderr);
    const out = result.stdout;
    assert.match(out, /powerbi\/csv\/FusionExport\.pbit: still carries SecurityBindings/);
    assert.ok(out.includes("  [Content_Types].xml: an Override that names SecurityBindings"), out);
    assert.ok(!out.includes("part SecurityBindings"), out);
    assert.doesNotMatch(out, /FusionExport\.pbit: in step/);
    assert.match(out, /To fix SecurityBindings/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
