#!/usr/bin/env node
/**
 * Writes the Power BI templates in powerbi/ as PBIP projects (Power BI
 * Desktop's folder format, which also deploys through the Fabric REST API):
 *
 *   powerbi/csv     the recommended path: a semantic model over the exporter's
 *                   CSV files in a SharePoint or OneDrive folder, and a report.
 *   powerbi/direct  the alternative path: Power Query calls the Sophos APIs
 *                   itself. Read the README's warnings before using it.
 *
 * Both models are generated from the exporter's schema (src/schema/tables.ts),
 * so a column the exporter writes and the model reads can't drift apart.
 * Run after `npm run build`: node scripts/build-powerbi.mjs
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { TABLES } from "../dist/schema/tables.js";
import { DOCUMENTS } from "../dist/sophos/documents.js";
import { MEASURES, RELATIONSHIPS, CSV_TABLES, DIRECT, PAGES_CSV, PAGES_DIRECT } from "./powerbi-spec.mjs";

const out = new URL("../powerbi/", import.meta.url);

function write(url, value) {
  mkdirSync(new URL(".", url), { recursive: true });
  writeFileSync(url, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
}

const TYPE = {
  string: { dataType: "string", m: "text" },
  integer: { dataType: "int64", m: "integer" },
  number: { dataType: "double", m: "number" },
  boolean: { dataType: "boolean", m: "boolean" },
  datetime: { dataType: "dateTime", m: "datetime", format: "yyyy-mm-dd hh:nn:ss" },
  date: { dataType: "dateTime", m: "date", format: "yyyy-mm-dd" },
};

/** Stable pseudo GUIDs so regenerating doesn't churn the files. */
function lineage(text) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const ch of text) {
    h1 = Math.imul(h1 ^ ch.charCodeAt(0), 16777619) >>> 0;
    h2 = Math.imul(h2 ^ ch.charCodeAt(0), 2246822519) >>> 0;
  }
  const hex = (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).repeat(2);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function mText(text) {
  return `"${text.replace(/"/g, '""')}"`;
}

function column(table, c) {
  const t = TYPE[c.type];
  const isKey = /(_id|_ids|_key)$/.test(c.name) || c.type === "string" || c.type === "boolean";
  return {
    name: c.name,
    dataType: t.dataType,
    sourceColumn: c.name,
    ...(t.format ? { formatString: t.format } : {}),
    ...(c.type === "integer" || c.type === "number" ? (isKey ? { summarizeBy: "none" } : { summarizeBy: "sum" }) : { summarizeBy: "none" }),
    ...(c.name === "tenant_id" ? { isHidden: false } : {}),
    description: c.description,
    lineageTag: lineage(`${table}.${c.name}`),
  };
}

function dateTable(seenDates) {
  return {
    name: "Date",
    description: "Calendar from the first month with data to today, in the report time zone.",
    lineageTag: lineage("Date"),
    dataCategory: "Time",
    columns: [
      { name: "Date", dataType: "dateTime", sourceColumn: "Date", formatString: "yyyy-mm-dd", isKey: true, summarizeBy: "none", lineageTag: lineage("Date.Date") },
      { name: "Year", dataType: "int64", sourceColumn: "Year", summarizeBy: "none", lineageTag: lineage("Date.Year") },
      { name: "Month", dataType: "string", sourceColumn: "Month", summarizeBy: "none", sortByColumn: "Month start", lineageTag: lineage("Date.Month") },
      { name: "Month start", dataType: "dateTime", sourceColumn: "Month start", formatString: "yyyy-mm-dd", summarizeBy: "none", lineageTag: lineage("Date.Month start") },
      { name: "Week start", dataType: "dateTime", sourceColumn: "Week start", formatString: "yyyy-mm-dd", summarizeBy: "none", lineageTag: lineage("Date.Week start") },
    ],
    partitions: [
      {
        name: "Date",
        mode: "import",
        source: {
          type: "m",
          expression: [
            "let",
            "    Today = Date.From(DateTime.LocalNow()),",
            `    Seen = ${seenDates},`,
            "    Start = Date.StartOfMonth(if List.IsEmpty(Seen) then Date.AddDays(Today, -90) else List.Min(Seen)),",
            "    End = Today,",
            "    Days = List.Dates(Start, Duration.Days(End - Start) + 1, #duration(1, 0, 0, 0)),",
            '    Base = Table.FromList(Days, Splitter.SplitByNothing(), type table [Date = date]),',
            '    WithYear = Table.AddColumn(Base, "Year", each Date.Year([Date]), Int64.Type),',
            '    WithMonth = Table.AddColumn(WithYear, "Month", each Date.ToText([Date], [Format = "yyyy-MM", Culture = "en-US"]), type text),',
            '    WithMonthStart = Table.AddColumn(WithMonth, "Month start", each Date.StartOfMonth([Date]), type date),',
            '    WithWeekStart = Table.AddColumn(WithMonthStart, "Week start", each Date.StartOfWeek([Date], Day.Monday), type date)',
            "in",
            "    WithWeekStart",
          ],
        },
      },
    ],
  };
}

function measuresFor(table, variant) {
  return (MEASURES[table] ?? [])
    .filter((m) => !m.only || m.only === variant)
    .map((m) => ({
      name: m.name,
      expression: m.dax,
      ...(m.format ? { formatString: m.format } : {}),
      description: m.description,
      lineageTag: lineage(`${table}.measure.${m.name}`),
    }));
}

function relationships(tables) {
  const has = (table, col) => tables.some((t) => t.name === table && t.columns.some((c) => c.name === col));
  return RELATIONSHIPS.filter((r) => has(...r.from) && has(...r.to)).map((r) => ({
    name: lineage(`rel.${r.from.join(".")}.${r.to.join(".")}`),
    fromTable: r.from[0],
    fromColumn: r.from[1],
    toTable: r.to[0],
    toColumn: r.to[1],
    ...(r.inactive ? { isActive: false } : {}),
  }));
}

function model(name, description, tables, expressions, variant, seen) {
  return {
    compatibilityLevel: 1567,
    model: {
      name,
      description,
      culture: "en-US",
      defaultPowerBIDataSourceVersion: "powerBI_V3",
      sourceQueryCulture: "en-US",
      // The direct path sends the token from id.sophos.com to the other Sophos hosts, which Power Query's
      // privacy firewall blocks unless privacy levels are ignored for the file ("fastCombine").
      dataAccessOptions: { legacyRedirects: true, returnErrorValuesAsNull: true, ...(variant === "direct" ? { fastCombine: true } : {}) },
      queryGroups: [...new Set(expressions.map((e) => e.queryGroup).filter(Boolean))].map((folder) => ({ folder })),
      expressions,
      tables: [...tables, dateTable(seen)].map((t) => ({ ...t, measures: [...(t.measures ?? []), ...measuresFor(t.name, variant)] })),
      relationships: relationships([...tables, dateTable(seen)]),
      annotations: [
        { name: "PBI_QueryOrder", value: JSON.stringify(expressions.map((e) => e.name).concat(tables.map((t) => t.name))) },
        { name: "__PBI_TimeIntelligenceEnabled", value: "0" },
      ],
    },
  };
}

function parameter(name, value, description) {
  return {
    name,
    kind: "m",
    expression: `${mText(value)} meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=true]`,
    description,
    lineageTag: lineage(`param.${name}`),
    queryGroup: "Parameters",
    annotations: [{ name: "PBI_ResultType", value: "Text" }],
  };
}

// ---------- the CSV path ----------

const csvExpressions = [
  parameter("SharePointSiteUrl", "https://contoso.sharepoint.com/sites/reporting", "The SharePoint site (or OneDrive for Business URL) that holds the exporter's CSV folder, for example https://contoso.sharepoint.com/sites/reporting."),
  parameter("ExportFolder", "FusionExport", "The folder path inside the site's Documents library, as the exporter's sharepoint.folder setting names it, for example FusionExport/acme."),
  {
    name: "FusionFiles",
    kind: "m",
    description: "The CSV files in the export folder. Every table reads its file from here.",
    lineageTag: lineage("FusionFiles"),
    queryGroup: "Helpers",
    expression: [
      "let",
      "    Files = SharePoint.Files(SharePointSiteUrl, [ApiVersion = 15]),",
      '    Folder = "/" & Text.Trim(ExportFolder, "/") & "/",',
      '    InFolder = Table.SelectRows(Files, each Text.EndsWith([Folder Path], Folder) and Text.EndsWith([Name], ".csv"))',
      "in",
      "    InFolder",
    ],
  },
  {
    name: "FusionTable",
    kind: "m",
    description: "Reads one exporter CSV with its schema types: empty cells become null, UTC timestamps become date/time values, and missing columns read as null.",
    lineageTag: lineage("FusionTable"),
    queryGroup: "Helpers",
    expression: [
      "(fileName as text, columns as list) as table =>",
      "let",
      "    Match = Table.SelectRows(FusionFiles, each [Name] = fileName),",
      '    Content = if Table.RowCount(Match) = 1 then Match{0}[Content] else error Error.Record("Fusion Export", fileName & " was not found in the export folder, or found more than once.", Table.RowCount(Match)),',
      '    Csv = Csv.Document(Content, [Delimiter = ",", Encoding = 65001, QuoteStyle = QuoteStyle.Csv]),',
      "    Promoted = Table.PromoteHeaders(Csv, [PromoteAllScalars = true]),",
      "    Names = List.Transform(columns, each _{0}),",
      "    Selected = Table.SelectColumns(Promoted, Names, MissingField.UseNull),",
      '    Blanked = Table.ReplaceValue(Selected, "", null, Replacer.ReplaceValue, Names),',
      '    TypeOf = [text = type text, integer = Int64.Type, number = type number, boolean = type logical, date = type date, datetime = type datetimezone],',
      "    Typed = Table.TransformColumnTypes(Blanked, List.Transform(columns, each {_{0}, Record.Field(TypeOf, _{1})}), \"en-US\"),",
      '    Zoned = List.Select(columns, each _{1} = "datetime"),',
      "    Utc = Table.TransformColumns(Typed, List.Transform(Zoned, each {_{0}, DateTimeZone.RemoveZone, type datetime}))",
      "in",
      "    Utc",
    ],
  },
];

function csvTable(def) {
  const spec = def.columns.map((c) => `{${mText(c.name)}, ${mText(TYPE[c.type].m)}}`).join(", ");
  return {
    name: def.name,
    description: def.description,
    lineageTag: lineage(def.name),
    columns: def.columns.map((c) => column(def.name, c)),
    partitions: [
      {
        name: def.name,
        mode: "import",
        source: { type: "m", expression: [`let`, `    Source = FusionTable(${mText(`${def.name}.csv`)}, {${spec}})`, `in`, `    Source`] },
      },
    ],
  };
}

const csvTables = TABLES.filter((t) => CSV_TABLES.includes(t.name)).map(csvTable);

// ---------- the direct path ----------

const directExpressions = [
  parameter("SophosClientId", "", "Sophos API client ID (a tenant credential). Anyone who can open this file or edit the model can read it."),
  parameter("SophosClientSecret", "", "Sophos API client secret. Stored in the file and the published model in plain text: see the README before using the direct path."),
  parameter("SophosRegionHost", "https://api-eu01.central.sophos.com", "The tenant's Sophos Central data region host, as fusion-export doctor or GET /whoami/v1 reports it, for example https://api-au01.central.sophos.com. A parameter, not looked up, so the Power BI service can refresh it."),
  parameter("DetectionDays", "7", "Days of detections to read, 1 to 30. One search returns at most 10,000 detections."),
  {
    name: "SophosToken",
    kind: "m",
    description: "An access token from id.sophos.com. A POST, so the source must use Anonymous credentials.",
    lineageTag: lineage("SophosToken"),
    queryGroup: "Helpers",
    expression: [
      "let",
      '    Body = Uri.BuildQueryString([grant_type = "client_credentials", client_id = SophosClientId, client_secret = SophosClientSecret, scope = "token"]),',
      '    Response = Json.Document(Web.Contents("https://id.sophos.com", [RelativePath = "api/v2/oauth2/token", Headers = [#"Content-Type" = "application/x-www-form-urlencoded"], Content = Text.ToBinary(Body)])),',
      "    Token = Response[access_token]",
      "in",
      "    Token",
    ],
  },
  {
    name: "SophosTenantId",
    kind: "m",
    description: "The tenant ID, from GET /whoami/v1.",
    lineageTag: lineage("SophosTenantId"),
    queryGroup: "Helpers",
    expression: [
      "let",
      '    Whoami = Json.Document(Web.Contents("https://api.central.sophos.com", [RelativePath = "whoami/v1", Headers = [Authorization = "Bearer " & SophosToken]])),',
      '    Id = if Whoami[idType] = "tenant" then Whoami[id] else error "The direct path needs a tenant credential."',
      "in",
      "    Id",
    ],
  },
  {
    name: "SophosGet",
    kind: "m",
    description: "A GET on the tenant's regional Sophos Central host.",
    lineageTag: lineage("SophosGet"),
    queryGroup: "Helpers",
    expression: [
      "(path as text, query as record) as record =>",
      '    Json.Document(Web.Contents(SophosRegionHost, [RelativePath = path, Query = query, Headers = [Authorization = "Bearer " & SophosToken, #"X-Tenant-ID" = SophosTenantId]]))',
    ],
  },
  {
    name: "FusionQuery",
    kind: "m",
    description: "A Sophos Fusion GraphQL query. A POST, so the source must use Anonymous credentials.",
    lineageTag: lineage("FusionQuery"),
    queryGroup: "Helpers",
    expression: [
      "(document as text, variables as record) as record =>",
      "let",
      '    Response = Json.Document(Web.Contents("https://api.taegis.sophos.com", [RelativePath = "graphql", Headers = [Authorization = "Bearer " & SophosToken, #"X-Tenant-ID" = SophosTenantId, #"Content-Type" = "application/json"], Content = Json.FromValue([query = document, variables = variables])])),',
      '    Data = if Record.HasFields(Response, "errors") and (not Record.HasFields(Response, "data") or Response[data] = null) then error Error.Record("Sophos Fusion", Text.Combine(List.Transform(Response[errors], each _[message]), "; ")) else Response[data]',
      "in",
      "    Data",
    ],
  },
  ...Object.entries({ DocCases: DOCUMENTS.get("ExportCasesPage"), DocDetections: DOCUMENTS.get("ExportDetectionSearch") }).map(([name, document]) => ({
    name,
    kind: "m",
    description: "A GraphQL document from the exporter's src/sophos/documents.ts, kept identical.",
    lineageTag: lineage(name),
    queryGroup: "Helpers",
    expression: mText(document),
  })),
];

function directTable(spec) {
  const def = TABLES.find((t) => t.name === spec.table);
  const cols = spec.columns.map((name) => {
    const c = def.columns.find((x) => x.name === name);
    if (!c) throw new Error(`${spec.table} has no column ${name}`);
    return c;
  });
  return {
    name: spec.table,
    description: `${def.description} Read live by Power Query (direct path).`,
    lineageTag: lineage(`direct.${spec.table}`),
    columns: cols.map((c) => column(spec.table, c)),
    partitions: [{ name: spec.table, mode: "import", source: { type: "m", expression: spec.m } }],
  };
}

const directTables = DIRECT.map(directTable);

// ---------- reports (PBIR) ----------

const SCHEMAS = {
  pbir: "https://developer.microsoft.com/json-schemas/fabric/item/report/definitionProperties/2.0.0/schema.json",
  pbism: "https://developer.microsoft.com/json-schemas/fabric/item/semanticModel/definitionProperties/1.0.0/schema.json",
  pbip: "https://developer.microsoft.com/json-schemas/fabric/pbip/pbipProperties/1.0.0/schema.json",
  report: "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/report/1.2.0/schema.json",
  version: "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/versionMetadata/1.0.0/schema.json",
  pages: "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/pagesMetadata/1.0.0/schema.json",
  page: "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/page/2.0.0/schema.json",
  visual: "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.0.0/schema.json",
};

function fieldRef(full) {
  const [ref, display] = full.split(" as ");
  const projection = fieldRefBare(ref);
  return display ? { ...projection, displayName: display } : projection;
}

function fieldRefBare(ref) {
  const [entity, property] = ref.split(".");
  if (property.startsWith("[")) {
    const name = property.slice(1, -1);
    return { field: { Measure: { Expression: { SourceRef: { Entity: entity } }, Property: name } }, queryRef: `${entity}.${name}`, nativeQueryRef: name };
  }
  return { field: { Column: { Expression: { SourceRef: { Entity: entity } }, Property: property } }, queryRef: `${entity}.${property}`, nativeQueryRef: property };
}

function visualJson(v, i) {
  const queryState = {};
  for (const [role, refs] of Object.entries(v.roles)) queryState[role] = { projections: refs.map(fieldRef) };
  const sortDefinition = v.sort ? { sort: [{ field: fieldRefBare(v.sort.field).field, direction: v.sort.desc ? "Descending" : "Ascending" }], isDefaultSort: true } : undefined;
  return {
    $schema: SCHEMAS.visual,
    name: v.id,
    position: { x: v.x, y: v.y, z: (i + 1) * 1000, width: v.w, height: v.h, tabOrder: (i + 1) * 1000 },
    visual: {
      visualType: v.type,
      query: { queryState, ...(sortDefinition ? { sortDefinition } : {}) },
      ...(v.type === "card" ? { objects: { categoryLabels: [{ properties: { show: { expr: { Literal: { Value: "false" } } } } }] } } : {}),
      visualContainerObjects: {
        title: [{ properties: { show: { expr: { Literal: { Value: "true" } } }, text: { expr: { Literal: { Value: `'${v.title.replace(/'/g, "''")}'` } } } } }],
      },
      drillFilterOtherVisuals: true,
    },
  };
}

function textbox(id, x, y, w, h, text, z) {
  return {
    $schema: SCHEMAS.visual,
    name: id,
    position: { x, y, z, width: w, height: h, tabOrder: z },
    visual: {
      visualType: "textbox",
      objects: {
        general: [{ properties: { paragraphs: [{ textRuns: [{ value: text, textStyle: { fontSize: "10pt" } }] }] } }],
      },
      drillFilterOtherVisuals: true,
    },
  };
}

function report(dir, name, modelFolder, pages, note) {
  rmSync(new URL(`${name}.Report/`, dir), { recursive: true, force: true });
  const base = new URL(`${name}.Report/`, dir);
  write(new URL("definition.pbir", base), { $schema: SCHEMAS.pbir, version: "4.0", datasetReference: { byPath: { path: `../${modelFolder}` } } });
  write(new URL("definition/version.json", base), { $schema: SCHEMAS.version, version: "2.0.0" });
  write(new URL("definition/report.json", base), {
    $schema: SCHEMAS.report,
    themeCollection: { baseTheme: { name: "CY24SU10", reportVersionAtImport: "5.61", type: "SharedResources" } },
    layoutOptimization: "None",
    settings: { useStylableVisualContainerHeader: true, exportDataMode: "AllowSummarized", defaultDrillFilterOtherVisuals: true, allowChangeFilterTypes: true, useEnhancedTooltips: true, useDefaultAggregateDisplayName: true },
  });
  write(new URL("definition/pages/pages.json", base), { $schema: SCHEMAS.pages, pageOrder: pages.map((p) => p.id), activePageName: pages[0].id });
  for (const page of pages) {
    write(new URL(`definition/pages/${page.id}/page.json`, base), { $schema: SCHEMAS.page, name: page.id, displayName: page.name, displayOption: "FitToPage", height: 720, width: 1280 });
    const visuals = [textbox(`${page.id}note`, 16, 8, 1248, 40, `${page.name}. ${note}`, 0), ...page.visuals.map(visualJson)];
    for (const v of visuals) write(new URL(`definition/pages/${page.id}/visuals/${v.name}/visual.json`, base), v);
  }
}

function project(variant, name, description, tables, expressions, pages, note, seen) {
  const dir = new URL(`${variant}/`, out);
  rmSync(new URL(`${name}.SemanticModel/`, dir), { recursive: true, force: true });
  write(new URL(`${name}.pbip`, dir), { $schema: SCHEMAS.pbip, version: "1.0", artifacts: [{ report: { path: `${name}.Report` } }], settings: { enableAutoRecovery: true } });
  write(new URL(`${name}.SemanticModel/definition.pbism`, dir), { $schema: SCHEMAS.pbism, version: "4.0", settings: {} });
  write(new URL(`${name}.SemanticModel/model.bim`, dir), model(name, description, tables, expressions, variant, seen));
  report(dir, name, `${name}.SemanticModel`, pages, note);
  write(new URL(".gitignore", dir), "**/.pbi/localSettings.json\n**/.pbi/cache.abf\n");
  console.log(`wrote powerbi/${variant}/${name}: ${tables.length + 1} tables, ${pages.length} pages`);
}

project(
  "csv",
  "FusionExport",
  "Unofficial Sophos Fusion Data Exporter: the CSV tables from a SharePoint or OneDrive folder. Not a Sophos product.",
  csvTables,
  csvExpressions,
  PAGES_CSV,
  "Unofficial, built on the Unofficial Sophos Fusion Data Exporter's CSV files. Not a Sophos product.",
  // The calendar starts at the first month with data: these small tables are read again for it.
  "List.RemoveNulls(List.Combine({fact_detection_daily[local_date], fact_case[created_local_date], fact_alert[raised_local_date], fact_endpoint_snapshot[snapshot_date]}))"
);
project(
  "direct",
  "FusionDirect",
  "Unofficial direct path: Power Query reads the Sophos APIs itself. The client secret sits in this file. Not a Sophos product.",
  directTables,
  directExpressions,
  PAGES_DIRECT,
  "Unofficial direct path: Power Query reads the Sophos APIs itself and the client secret sits in this file. Not a Sophos product.",
  // Reading the API tables again for the calendar would spend more calls, so the direct path uses a fixed year back.
  "{Date.AddYears(Today, -1)}"
);
