/**
 * One table held in memory for a run: the rows already in its CSV, merged with
 * what the run pulled, written back sorted by key so a rerun with the same
 * data writes the same bytes.
 */

import type { TableDef } from "../schema/tables.js";
import { parseCsv, toCsv, type Row } from "./csv.js";

const SEP = "\u0001";

export class TableStore {
  private rows = new Map<string, Row>();

  constructor(
    readonly def: TableDef,
    private readonly personalData: boolean
  ) {}

  keyOf(row: Row): string {
    return this.def.key.map((k) => String(row[k] ?? "")).join(SEP);
  }

  /** Loads the rows of an existing CSV. Columns the file lacks stay empty; columns the schema lacks are dropped. */
  load(text: string | null): void {
    this.rows.clear();
    if (!text) return;
    const { rows } = parseCsv(text);
    for (const raw of rows) {
      const row: Row = {};
      for (const c of this.def.columns) row[c.name] = raw[c.name] ?? "";
      this.rows.set(this.keyOf(row), row);
    }
  }

  upsert(rows: Iterable<Row>): void {
    for (const row of rows) this.rows.set(this.keyOf(row), row);
  }

  /** Removes the rows `where` matches, then upserts `rows`. */
  replace(where: (row: Row) => boolean, rows: Iterable<Row>): void {
    this.remove(where);
    this.upsert(rows);
  }

  remove(where: (row: Row) => boolean): number {
    let removed = 0;
    for (const [key, row] of this.rows) {
      if (where(row)) {
        this.rows.delete(key);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.rows.size;
  }

  all(): Row[] {
    return [...this.rows.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, row]) => row);
  }

  /**
   * The CSV text. With the personal data switch off, personal columns are
   * written empty (old values included) and a personal-only table is written
   * with its header alone.
   */
  toCsv(): string {
    if (this.def.personalOnly && !this.personalData) return toCsv(this.def.columns, []);
    const personal = this.personalData ? [] : this.def.columns.filter((c) => c.personal).map((c) => c.name);
    const rows = personal.length
      ? this.all().map((row) => {
          const copy = { ...row };
          for (const name of personal) copy[name] = null;
          return copy;
        })
      : this.all();
    return toCsv(this.def.columns, rows);
  }
}
