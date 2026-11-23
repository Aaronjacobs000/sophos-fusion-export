#!/usr/bin/env node
/**
 * Checks that each Power BI template (.pbit) under powerbi/ matches the PBIP
 * project next to it: the tables, each column's name and data type, each
 * measure's name and expression, the Power Query of every query, the
 * parameters and the report page names. The templates are exported by hand
 * from Power BI Desktop on Windows, so a model change leaves them stale until
 * someone exports them again. This says when.
 *
 *   npm run check:pbit                      the templates in this repository
 *   node scripts/check-pbit.mjs <folder>    the templates under <folder>/powerbi
 *
 * Prints "in step" or the differences for each template. Exits 0 when every
 * template is in step, 1 when one has drifted, 2 when a file can't be read,
 * 3 when a parameter holds a value. When several apply, the highest wins.
 *
 * What Desktop changes on export is ignored: line endings and other
 * whitespace, the order of tables, columns, measures and queries, lineage
 * tags and other ids, annotations, culture and linguistic metadata,
 * parameter values, and the row number columns and auto date tables Desktop
 * adds.
 *
 * Every parameter must ship blank (null or ""), in the model and in the
 * Power Query edits not yet applied to it: a typed value can be a client
 * secret, a client id or a customer's site, and a template pushed here is
 * public. A parameter that holds a value is named, never printed.
 *
 * A template is read as data: the zip is unpacked in memory and only its JSON
 * parts are parsed. Nothing in it is run.
 */

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, inflateRawSync } from "node:zlib";

const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const DESKTOP_TABLE = /^(LocalDateTable|DateTableTemplate)_[0-9a-f-]{36}$/i;
const PARAMETER = /\bmeta\s*\[[^\]]*\bIsParameterQuery\s*=\s*true/i;
const BLANK = /^(null|"")$/;

// ---------- reading a .pbit ----------

/** The entries of a zip file, unpacked on demand: name to a function returning the bytes. */
export function readZip(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const fail = (why) => {
    throw new Error(`not a readable zip file: ${why}`);
  };
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) fail("no end of central directory");
  const count = buf.readUInt16LE(end + 10);
  const dirOffset = buf.readUInt32LE(end + 16);
  if (count === 0xffff || dirOffset === 0xffffffff) fail("zip64 is not supported");
  const entries = new Map();
  let p = dirOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) fail("bad central directory entry");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const packed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLength = buf.readUInt16LE(p + 28);
    const skip = nameLength + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString(flags & 0x800 ? "utf8" : "latin1", p + 46, p + 46 + nameLength).replace(/\\/g, "/");
    p += 46 + skip;
    if (flags & 1) fail(`${name} is encrypted`);
    if (size > MAX_ENTRY_BYTES) fail(`${name} is larger than ${MAX_ENTRY_BYTES} bytes`);
    entries.set(name, () => {
      if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) fail(`bad local header for ${name}`);
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      if (start + packed > buf.length) fail(`${name} runs past the end of the file`);
      const raw = buf.subarray(start, start + packed);
      let data;
      if (method === 0) data = raw;
      else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
      else fail(`${name} uses compression method ${method}`);
      if (data.length !== size || crc32(data) !== crc) fail(`${name} is corrupt`);
      return data;
    });
  }
  return entries;
}

/** Text in the encodings Desktop writes: UTF-16 LE with or without a BOM, or UTF-8 with or without one. */
export function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2)).swap16().toString("utf16le");
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString("utf8");
  if (buf.length >= 2 && buf[0] !== 0 && buf[1] === 0) return buf.toString("utf16le");
  return buf.toString("utf8");
}

function parseJson(buf, where) {
  try {
    return JSON.parse(decodeText(buf).replace(/^﻿/, ""));
  } catch (error) {
    throw new Error(`${where} is not JSON: ${error.message}`);
  }
}

/** Page display names in report order, from a PBIR definition or a legacy report layout. */
function pagesFrom(read, pbirPrefix, legacyFiles) {
  const pagesJson = read(`${pbirPrefix}pages/pages.json`);
  if (pagesJson) {
    const order = parseJson(pagesJson, "pages.json").pageOrder ?? [];
    return order.map((id) => {
      const page = read(`${pbirPrefix}pages/${id}/page.json`);
      if (!page) throw new Error(`page ${id} is in pages.json but has no page.json`);
      return parseJson(page, `page ${id}`).displayName ?? id;
    });
  }
  for (const file of legacyFiles) {
    const layout = read(file);
    if (layout) {
      const sections = parseJson(layout, file).sections ?? [];
      return [...sections].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0)).map((s) => s.displayName ?? s.name);
    }
  }
  throw new Error("no report pages found");
}

/** The model, page names and unapplied Power Query edits (name and M text) of a .pbit file's bytes. */
export function readTemplate(bytes) {
  const zip = readZip(bytes);
  const read = (name) => zip.get(name)?.();
  const schema = read("DataModelSchema");
  if (!schema) throw new Error("the template has no DataModelSchema");
  const pending = read("UnappliedChanges");
  const unapplied = pending ? (parseJson(pending, "UnappliedChanges").queries ?? []).map((q) => ({ name: q.name, expression: q.text })) : [];
  return { model: parseJson(schema, "DataModelSchema").model, pages: pagesFrom(read, "Report/definition/", ["Report/Layout"]), unapplied };
}

/** The model and page names of the PBIP project <name> in a folder. */
export function readProject(dir, name) {
  const bim = join(dir, `${name}.SemanticModel`, "model.bim");
  if (!existsSync(bim)) {
    const tmdl = existsSync(join(dir, `${name}.SemanticModel`, "definition"));
    throw new Error(tmdl ? `${name}.SemanticModel is TMDL, which this check does not read` : `${name}.SemanticModel/model.bim is missing`);
  }
  const report = join(dir, `${name}.Report`);
  const read = (path) => (existsSync(join(report, path)) ? readFileSync(join(report, path)) : undefined);
  return { model: parseJson(readFileSync(bim), "model.bim").model, pages: pagesFrom(read, "definition/", ["report.json"]) };
}

// ---------- normalizing ----------

/** Expression text with whitespace runs, line endings included, collapsed: Desktop rewraps M and DAX. */
export function normText(expression) {
  const text = Array.isArray(expression) ? expression.join("\n") : String(expression ?? "");
  return text.replace(/^﻿/, "").replace(/\s+/g, " ").trim();
}

/** Splits on commas outside quotes, brackets and braces. */
function splitFields(text) {
  const out = [];
  let depth = 0;
  let quoted = false;
  let field = "";
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && "[{(".includes(ch)) depth++;
    else if (!quoted && "]})".includes(ch)) depth--;
    if (ch === "," && depth === 0 && !quoted) {
      out.push(field);
      field = "";
    } else field += ch;
  }
  out.push(field);
  return out;
}

/** A parameter's settings (its meta record) without its value, which the templates ship blank. */
function parameterSettings(text) {
  const at = text.search(/\bmeta\s*\[/i);
  const record = text.slice(text.indexOf("[", at) + 1, text.lastIndexOf("]"));
  return `[${splitFields(record)
    .map((f) => f.replace(/\s+/g, ""))
    .filter(Boolean)
    .sort()
    .join(", ")}]`;
}

/**
 * The names of the parameters that hold a value, in the model or the
 * unapplied edits: anything but null or "" before the meta record, a
 * DefaultValue or List in it, or anything after it.
 */
export function filledParameters({ model, unapplied = [] }) {
  const filled = new Set();
  for (const e of [...(model.expressions ?? []), ...unapplied]) {
    const text = normText(e.expression);
    if (!PARAMETER.test(text)) continue;
    const at = text.search(/\bmeta\s*\[/i);
    const close = text.lastIndexOf("]");
    const listed = splitFields(text.slice(text.indexOf("[", at) + 1, close)).some(
      (f) => /^\s*(DefaultValue|List)\s*=/i.test(f) && !/=\s*(null|""|\{\s*\})\s*$/i.test(f),
    );
    if (!BLANK.test(text.slice(0, at).trim()) || text.slice(close + 1).trim() || listed) filled.add(e.name);
  }
  return [...filled].sort();
}

/** What the check compares, keyed by name so that order and ids don't matter. */
export function summarize({ model, pages }) {
  const tables = new Map();
  const queries = new Map();
  const parameters = new Map();
  for (const t of model.tables ?? []) {
    if (DESKTOP_TABLE.test(t.name)) continue;
    const columns = new Map((t.columns ?? []).filter((c) => c.type !== "rowNumber").map((c) => [c.name, String(c.dataType ?? "").toLowerCase()]));
    const measures = new Map((t.measures ?? []).map((m) => [m.name, normText(m.expression)]));
    tables.set(t.name, { columns, measures });
    const sources = (t.partitions ?? []).map((p) => p.source?.expression).filter((e) => e !== undefined);
    if (sources.length) queries.set(t.name, sources.map(normText).sort().join(" | "));
  }
  for (const e of model.expressions ?? []) {
    const text = normText(e.expression);
    if (PARAMETER.test(text)) parameters.set(e.name, parameterSettings(text));
    else queries.set(e.name, text);
  }
  return { tables, queries, parameters, pages: [...pages] };
}

// ---------- comparing ----------

/** Where two texts first differ, with a little context from each. */
function excerpt(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const from = Math.max(0, i - 20);
  const cut = (s) => `${from > 0 ? "..." : ""}${s.slice(from, i + 40)}${s.length > i + 40 ? "..." : ""}`;
  return `template "${cut(a)}", project "${cut(b)}"`;
}

function compareMaps(label, template, project, describe, out) {
  for (const name of template.keys()) if (!project.has(name)) out.push(`${label(name)}: only in the template`);
  for (const [name, value] of project) {
    if (!template.has(name)) out.push(`${label(name)}: only in the project`);
    else if (template.get(name) !== value) out.push(`${label(name)}: ${describe(template.get(name), value, name)}`);
  }
}

/** The differences between a template and its project, as short lines. Empty when in step. */
export function compareTemplate(template, project) {
  const t = summarize(template);
  const p = summarize(project);
  const out = [];
  for (const name of t.tables.keys()) if (!p.tables.has(name)) out.push(`table ${name}: only in the template`);
  for (const [name, pt] of p.tables) {
    const tt = t.tables.get(name);
    if (!tt) {
      out.push(`table ${name}: only in the project`);
      continue;
    }
    compareMaps((c) => `column ${name}[${c}]`, tt.columns, pt.columns, (a, b) => `data type ${a} in the template, ${b} in the project`, out);
    compareMaps((m) => `measure ${name}[${m}]`, tt.measures, pt.measures, (a, b) => `expression differs: ${excerpt(a, b)}`, out);
  }
  compareMaps((q) => `query ${q}`, t.queries, p.queries, (a, b) => `Power Query differs: ${excerpt(a, b)}`, out);
  const filled = new Set(filledParameters(template));
  const settings = (a, b, name) => (filled.has(name) ? "settings differ (not shown: it holds a value)" : `settings differ: template ${a}, project ${b}`);
  compareMaps((q) => `parameter ${q}`, t.parameters, p.parameters, settings, out);
  const tPages = new Set(t.pages);
  const pPages = new Set(p.pages);
  for (const page of t.pages) if (!pPages.has(page)) out.push(`page "${page}": only in the template`);
  for (const page of p.pages) if (!tPages.has(page)) out.push(`page "${page}": only in the project`);
  if (!out.some((d) => d.startsWith("page ")) && t.pages.join("\n") !== p.pages.join("\n")) {
    out.push(`page order: template ${t.pages.join(", ")}; project ${p.pages.join(", ")}`);
  }
  return out;
}

// ---------- the command ----------

/** Every powerbi/<path>/<Name>.pbit under a root folder, with the folder its PBIP project sits in. */
export function findTemplates(root) {
  const base = join(root, "powerbi");
  if (!existsSync(base)) return [];
  const out = [];
  for (const variant of readdirSync(base, { withFileTypes: true })) {
    if (!variant.isDirectory()) continue;
    for (const file of readdirSync(join(base, variant.name))) {
      if (file.toLowerCase().endsWith(".pbit")) out.push({ path: join(base, variant.name, file), dir: join(base, variant.name), name: file.slice(0, -5) });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Checks every template under root. Returns the exit code and the lines to print. */
export function checkAll(root) {
  const templates = findTemplates(root);
  if (!templates.length) return { code: 2, lines: [`no .pbit templates under ${join(root, "powerbi")}`] };
  const lines = [];
  let code = 0;
  let drifted = false;
  let anyFilled = false;
  for (const t of templates) {
    const shown = relative(root, t.path).replace(/\\/g, "/");
    try {
      const template = readTemplate(readFileSync(t.path));
      const filled = filledParameters(template);
      if (filled.length) {
        lines.push(`${shown}: ${filled.length} parameter${filled.length === 1 ? "" : "s"} with a value`, ...filled.map((name) => `  parameter ${name}: holds a value; templates ship every parameter blank`));
        anyFilled = true;
        code = Math.max(code, 3);
      }
      const diffs = compareTemplate(template, readProject(t.dir, t.name));
      if (diffs.length) {
        lines.push(`${shown}: ${diffs.length} difference${diffs.length === 1 ? "" : "s"}`, ...diffs.map((d) => `  ${d}`));
        drifted = true;
        code = Math.max(code, 1);
      } else if (!filled.length) lines.push(`${shown}: in step`);
    } catch (error) {
      lines.push(`${shown}: can't check: ${error.message}`);
      code = Math.max(code, 2);
    }
  }
  if (drifted) {
    lines.push("To fix: open the .pbip in Power BI Desktop on Windows, choose File > Export > Power BI template, then remove SecurityBindings as the README says.");
  }
  if (anyFilled) {
    lines.push("To fix a parameter with a value: export the template again from the .pbip with nothing typed into its parameters. If a pushed template held a client secret or client id, treat that credential as exposed and replace it.");
  }
  return { code, lines };
}

function isMain() {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const root = resolve(process.argv[2] ?? fileURLToPath(new URL("../", import.meta.url)));
  const { code, lines } = checkAll(root);
  console.log(lines.join("\n"));
  process.exit(code);
}
