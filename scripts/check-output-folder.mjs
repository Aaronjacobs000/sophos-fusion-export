#!/usr/bin/env node
/**
 * Checks that a folder works as the exporter's output folder: a backfill, a
 * rerun and an incremental run against the fake Sophos from the tests,
 * written into a new subfolder of the folder you name. Every write is a
 * temporary file renamed over the last one, so this proves that rename over
 * an existing file works there, for example on an Azure Files or Samba SMB
 * mount. CI runs it in the container image against a Samba share mounted
 * with the Azure template's mount options.
 *
 *   npm run build && node scripts/check-output-folder.mjs /mnt/share
 *
 * Only the subfolder it creates is written to, and it is removed at the
 * end. No Sophos tenant is contacted.
 */

import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildConfig } from "../dist/config.js";
import { runExport } from "../dist/runner.js";
import { TABLES } from "../dist/schema/tables.js";
import { SophosSession } from "../dist/sophos/session.js";
import { fakeSophos } from "../test/helpers/fake-sophos.mjs";

const target = process.argv[2];
if (!target) {
  console.error("Usage: node scripts/check-output-folder.mjs <folder>");
  process.exit(2);
}
const dir = join(resolve(target), `fusion-export-check-${process.pid}-${Date.now()}`);
const NOW = new Date("2026-11-21T08:00:00Z");

async function exportOnce(mode) {
  const config = buildConfig({ outputDir: dir, reportTimezone: "Australia/Sydney", tenantName: "Example Tenant" });
  const session = await SophosSession.open({ clientId: "id", clientSecret: "secret", baseFetch: fakeSophos().fetch, perMinute: 100 });
  const summary = await runExport({ config, mode, backfillDays: 3, credentials: { clientId: "", clientSecret: "" }, now: NOW, session });
  assert.equal(summary.ok, true, JSON.stringify(summary.datasets));
  const files = {};
  for (const t of TABLES) files[t.name] = await readFile(join(dir, `${t.name}.csv`), "utf8");
  return files;
}

await mkdir(dir);
const first = await exportOnce("backfill");
assert.deepEqual(await exportOnce("backfill"), first, "a rerun over existing files writes the same bytes");
assert.deepEqual(await exportOnce("run"), first, "an incremental run over existing files writes the same bytes");
const left = (await readdir(dir)).concat((await readdir(join(dir, "_state"))).map((f) => `_state/${f}`)).filter((f) => f.endsWith(".tmp"));
assert.deepEqual(left, [], "no temporary files are left behind");
const runs = (await readFile(join(dir, "_state", "runs.jsonl"), "utf8")).trim().split("\n");
assert.equal(runs.length, 3, "each run appends one line to _state/runs.jsonl");
const rows = Object.values(first).reduce((n, text) => n + text.trim().split("\n").length - 1, 0);
await rm(dir, { recursive: true, force: true });
console.log(`ok: ${TABLES.length} tables and _state written three times in ${dir}, ${rows} rows, files replaced in place, nothing left behind`);
