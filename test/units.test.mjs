// CSV, time zones, config and the SharePoint sink.
import { test } from "node:test";
import assert from "node:assert/strict";
import { toCsv, parseCsv, escapeField } from "../dist/store/csv.js";
import { localDate, startOfLocalDay, isoSeconds, localDaysAgo, toDate } from "../dist/time.js";
import { buildConfig, ConfigError } from "../dist/config.js";
import { parseArgs } from "../dist/cli.js";
import { SharePointSink, assertGraphHost, siteReference, sha256, SharePointError } from "../dist/sinks/sharepoint.js";
import { dataDictionary } from "../dist/schema/dictionary.js";
import { TABLES } from "../dist/schema/tables.js";

test("CSV: quoting, line breaks, types and a round trip", () => {
  const cols = [
    { name: "s", type: "string" },
    { name: "i", type: "integer" },
    { name: "n", type: "number" },
    { name: "b", type: "boolean" },
  ];
  const text = toCsv(cols, [
    { s: 'a, "quoted"\nvalue', i: 3.9, n: 0.1 + 0.2, b: true },
    { s: " padded", i: null, n: Number.NaN, b: "false" },
    { s: "", i: "", n: undefined, b: null },
  ]);
  assert.equal(text, 's,i,n,b\n"a, ""quoted"" value",3,0.3,true\n" padded",,,false\n,,,\n');
  const { header, rows } = parseCsv(text);
  assert.deepEqual(header, ["s", "i", "n", "b"]);
  assert.equal(rows[0].s, 'a, "quoted" value');
  assert.equal(rows[2].s, "");
  assert.equal(parseCsv("﻿a,b\r\n1,2\r\n").rows[0].b, "2");
  assert.equal(escapeField("plain"), "plain");
});

test("time: local dates follow the zone's daylight saving", () => {
  // Sydney moves to UTC+11 on 4 October 2026 at 02:00 local.
  assert.equal(localDate("2026-10-03T13:59:59Z", "Australia/Sydney"), "2026-10-03");
  assert.equal(localDate("2026-10-03T14:00:00Z", "Australia/Sydney"), "2026-10-04");
  assert.equal(startOfLocalDay("2026-10-04", "Australia/Sydney").toISOString(), "2026-10-03T14:00:00.000Z");
  assert.equal(startOfLocalDay("2026-10-05", "Australia/Sydney").toISOString(), "2026-10-04T13:00:00.000Z");
  assert.equal(startOfLocalDay("2026-11-21", "UTC").toISOString(), "2026-11-21T00:00:00.000Z");
  assert.equal(startOfLocalDay("2026-03-08", "America/New_York").toISOString(), "2026-03-08T05:00:00.000Z");
  assert.equal(localDaysAgo(new Date("2026-11-21T08:00:00Z"), 7, "Australia/Sydney"), "2026-11-14");
  assert.equal(isoSeconds("2026-11-19T11:50:57.174548Z"), "2026-11-19T11:50:57Z");
  assert.equal(isoSeconds(1795241267), "2026-11-21T06:07:47Z");
  assert.equal(toDate("not a date"), null);
});

test("config: defaults, limits, and no secrets in the file", () => {
  const c = buildConfig({});
  assert.equal(c.rate.perMinute, 60);
  assert.equal(c.personalData, false);
  assert.equal(c.detections.trailingDays, 7);
  assert.throws(() => buildConfig({ rate: { perMinute: 150 } }), ConfigError);
  assert.throws(() => buildConfig({ reportTimezone: "Mars/Olympus" }), /time zone/);
  assert.throws(() => buildConfig({ sharepoint: { siteUrl: "https://x.sharepoint.com/sites/a", clientSecret: "x" } }), /sharepoint.clientSecret/);
  assert.throws(() => buildConfig({ SOPHOS_CLIENT_SECRET: "x" }), ConfigError);
  assert.throws(() => buildConfig({ datasets: ["cases", "nope"] }), ConfigError);
  assert.deepEqual(buildConfig({ datasets: ["alerts", "cases"] }).datasets, ["cases", "alerts"]);
  assert.throws(() => buildConfig({ detections: { trailingDays: 30, retentionDays: 7 } }), ConfigError);
});

test("command line: options and their checks", () => {
  const a = parseArgs(["backfill", "--days", "30", "--env-file", "a.env", "--env-file", "b.env", "--personal-data", "--no-upload"]);
  assert.equal(a.command, "backfill");
  assert.equal(a.days, 30);
  assert.deepEqual(a.envFiles, ["a.env", "b.env"]);
  assert.ok(a.personalData && a.noUpload);
  assert.throws(() => parseArgs(["backfill", "--days", "0"]), ConfigError);
  assert.throws(() => parseArgs(["run", "--bogus"]), ConfigError);
  assert.throws(() => parseArgs(["run", "--config"]), ConfigError);
});

test("SharePoint: hosts, site references and the setup checks", () => {
  assertGraphHost("https://graph.microsoft.com/v1.0/sites");
  assertGraphHost("https://login.microsoftonline.com/x/oauth2/v2.0/token");
  assertGraphHost("https://contoso.sharepoint.com/_api/upload");
  assertGraphHost("https://contoso-my.sharepoint.com/personal/x");
  assert.throws(() => assertGraphHost("http://graph.microsoft.com/v1.0"), SharePointError);
  assert.throws(() => assertGraphHost("https://graph.microsoft.com.evil.test/"), SharePointError);
  assert.deepEqual(siteReference("https://contoso.sharepoint.com/sites/reporting/"), { host: "contoso.sharepoint.com", path: "/sites/reporting" });
  assert.throws(() => siteReference("https://evil.test/sites/x"), SharePointError);
  assert.throws(() => new SharePointSink({ tenantId: "t", clientId: "c", clientSecret: "", siteUrl: "https://x.sharepoint.com" }), /clientSecret/);
});

test("SharePoint: uploads only changed files, into the configured folder", async () => {
  const calls = [];
  const fetch = async (input, init = {}) => {
    calls.push(`${init.method ?? "GET"} ${new URL(input).pathname}`);
    if (input.includes("/oauth2/v2.0/token")) return Response.json({ access_token: "t", expires_in: 3600 });
    if (input.includes("/drives?")) return Response.json({ value: [{ id: "drive1", name: "Documents" }] });
    if (input.includes("/sites/")) return Response.json({ id: "site1", webUrl: "https://contoso.sharepoint.com/sites/reporting" });
    if (init.method === "PUT") return Response.json({ webUrl: "https://contoso.sharepoint.com/x.csv" });
    return new Response("{}", { status: 404 });
  };
  const sink = new SharePointSink({ tenantId: "t", clientId: "c", clientSecret: "s", siteUrl: "https://contoso.sharepoint.com/sites/reporting", folder: "/FusionExport/acme/" }, fetch);
  const files = new Map([["a.csv", "x\n1\n"], ["b.csv", "y\n2\n"]]);
  const first = await sink.sync(files, {});
  assert.deepEqual(first.sent, ["a.csv", "b.csv"]);
  assert.ok(calls.includes("PUT /v1.0/drives/drive1/root:/FusionExport/acme/a.csv:/content"));
  const second = await sink.sync(new Map([["a.csv", "x\n1\n"], ["b.csv", "y\n3\n"]]), first.hashes);
  assert.deepEqual(second.sent, ["b.csv"]);
  assert.equal(second.hashes["b.csv"], sha256("y\n3\n"));
  assert.equal(calls.filter((c) => c.includes("oauth2")).length, 1, "the token is reused");
});

test("SharePoint: a missing library is named plainly", async () => {
  const fetch = async (input) => {
    if (input.includes("/oauth2/")) return Response.json({ access_token: "t", expires_in: 3600 });
    if (input.includes("/drives?")) return Response.json({ value: [{ id: "d", name: "Site Assets" }] });
    return Response.json({ id: "site1", webUrl: "https://contoso.sharepoint.com/sites/reporting" });
  };
  const sink = new SharePointSink({ tenantId: "t", clientId: "c", clientSecret: "s", siteUrl: "https://contoso.sharepoint.com/sites/reporting" }, fetch);
  await assert.rejects(sink.resolve(), /no library named Documents. Libraries: Site Assets/);
});

test("the data dictionary covers every table and column", () => {
  const md = dataDictionary();
  for (const t of TABLES) {
    assert.ok(md.includes(`## ${t.name}`), t.name);
    for (const c of t.columns) assert.ok(md.includes(`\`${c.name}\``), `${t.name}.${c.name}`);
  }
  assert.ok(!/[\u2013\u2014]/.test(md), "no en or em dashes");
});

test("docs/data-dictionary.md matches the schema (run npm run docs after a schema change)", async () => {
  const { readFile } = await import("node:fs/promises");
  const onDisk = await readFile(new URL("../docs/data-dictionary.md", import.meta.url), "utf8");
  assert.equal(onDisk, `${dataDictionary()}\n`);
});
