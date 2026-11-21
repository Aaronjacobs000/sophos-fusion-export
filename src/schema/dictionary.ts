/** The data dictionary, generated from the schema, as Markdown. */

import { SCHEMA_VERSION, TABLES } from "./tables.js";

const LOAD_TEXT: Record<string, string> = {
  upsert: "Upsert on the key. Rows are replaced, never removed.",
  snapshot: "One snapshot a day. A rerun the same day replaces that day's rows.",
  window: "The re-read window is replaced on every run. Rows before it are settled.",
  reference: "The current list, replaced on every run.",
};

function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

export function dataDictionary(): string {
  const lines = [
    "# Data dictionary",
    "",
    `Schema version ${SCHEMA_VERSION}. Generated from \`src/schema/tables.ts\` by \`fusion-export schema\`; do not edit by hand.`,
    "",
    "Every file is UTF-8 CSV with a header row. Every row starts with `tenant_id`. Timestamps are UTC ISO 8601 with `Z`; `*_local_date` and `snapshot_date` are dates in the configured report time zone. Empty means no value. Columns marked personal are empty unless the personal data switch is on.",
    "",
  ];
  for (const t of TABLES) {
    lines.push(`## ${t.name}`, "", t.description, "", `Key: ${t.key.map((k) => `\`${k}\``).join(", ")}. ${LOAD_TEXT[t.load]}${t.personalOnly ? " Written only with the personal data switch on." : ""}`, "");
    lines.push("| Column | Type | Description |", "| --- | --- | --- |");
    for (const c of t.columns) lines.push(`| \`${c.name}\` | ${c.type} | ${cell(c.description)}${c.personal ? " Personal." : ""} |`);
    lines.push("");
  }
  return lines.join("\n");
}
