/**
 * CSV in the one shape every consumer here reads: UTF-8 with no byte order
 * mark, a header row, comma separated, LF line ends, fields quoted only when
 * they hold a comma, a quote or leading or trailing space. Line breaks inside
 * a value become spaces, because Looker Studio and some Grafana parsers
 * reject a quoted value that spans lines.
 */

import type { ColumnType } from "../schema/tables.js";

export type Cell = string | number | boolean | null | undefined;
export type Row = Record<string, Cell>;

function formatCell(value: Cell, type: ColumnType): string {
  if (value === null || value === undefined || value === "") return "";
  switch (type) {
    case "boolean":
      return value === true || value === "true" ? "true" : value === false || value === "false" ? "false" : "";
    case "integer": {
      const n = typeof value === "number" ? value : Number(value);
      return Number.isFinite(n) ? String(Math.trunc(n)) : "";
    }
    case "number": {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n)) return "";
      // At most six decimals, without trailing zeros or exponent notation.
      return String(Math.round(n * 1e6) / 1e6);
    }
    default:
      return String(value);
  }
}

export function escapeField(text: string): string {
  const flat = text.replace(/\r\n|\r|\n/g, " ");
  return /[",]|^\s|\s$/.test(flat) ? `"${flat.replace(/"/g, '""')}"` : flat;
}

export function toCsv(columns: ReadonlyArray<{ name: string; type: ColumnType }>, rows: readonly Row[]): string {
  const lines = [columns.map((c) => escapeField(c.name)).join(",")];
  for (const row of rows) lines.push(columns.map((c) => escapeField(formatCell(row[c.name], c.type))).join(","));
  return `${lines.join("\n")}\n`;
}

/** Parses CSV text into rows of strings keyed by the header. Accepts LF or CRLF and quoted fields. */
export function parseCsv(text: string): { header: string[]; rows: Array<Record<string, string>> } {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  let i = 0;
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  while (i < body.length) {
    const ch = body[i]!;
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      i++;
      continue;
    }
    if (ch === ",") {
      record.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      i += ch === "\r" && body[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== "" || record.length) {
    record.push(field);
    records.push(record);
  }
  const [header = [], ...data] = records;
  return {
    header,
    rows: data
      .filter((r) => !(r.length === 1 && r[0] === ""))
      .map((r) => Object.fromEntries(header.map((h, idx) => [h, r[idx] ?? ""]))),
  };
}
