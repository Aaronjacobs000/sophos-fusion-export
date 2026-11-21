#!/usr/bin/env node
/**
 * fusion-export: the command line.
 *
 *   fusion-export doctor   [--config file] [--env-file file]...
 *   fusion-export backfill [--days 90] [--config file] [--env-file file]... [--out dir]
 *   fusion-export run      [--config file] [--env-file file]... [--out dir]
 *   fusion-export schema   [--json]
 *
 * Credentials come from the environment: SOPHOS_CLIENT_ID and
 * SOPHOS_CLIENT_SECRET, plus GRAPH_TENANT_ID, GRAPH_CLIENT_ID and
 * GRAPH_CLIENT_SECRET for the SharePoint upload. --env-file loads a file of
 * those into the environment first (it can be given more than once).
 */

import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { buildConfig, ConfigError, loadConfig, type ExportConfig } from "./config.js";
import { runDoctor } from "./doctor.js";
import { runExport } from "./runner.js";
import { dataDictionary } from "./schema/dictionary.js";
import { schemaDocument } from "./schema/tables.js";
import type { SharePointConfig } from "./sinks/sharepoint.js";

const HELP = `Unofficial Sophos Fusion Data Exporter (not a Sophos product)

Usage: fusion-export <command> [options]

Commands:
  doctor     Check the credential, the tenant's APIs, the output folder and SharePoint
  backfill   First load: cases in full, detections for --days (default 90), today's snapshots
  run        Incremental load: changed cases, the last 7 days of detections, today's snapshots
  schema     Print the data dictionary (Markdown), or _schema.json with --json

Options:
  --config <file>     JSON config (see fusion-export.config.example.json)
  --env-file <file>   Load credentials from an env file; repeatable
  --out <dir>         Output folder (overrides outputDir)
  --days <n>          Days of detections a backfill reads (1 to 400)
  --timezone <iana>   Report time zone, for example Australia/Sydney
  --personal-data     Export hostnames, users, titles and descriptions (off by default)
  --no-upload         Skip the SharePoint upload even when it is configured
  --json              Machine readable output
  --quiet             Only print the summary
  --help, --version
`;

interface Args {
  command: string;
  config?: string;
  envFiles: string[];
  out?: string;
  days?: number;
  timezone?: string;
  personalData: boolean;
  noUpload: boolean;
  json: boolean;
  quiet: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { command: "", envFiles: [], personalData: false, noUpload: false, json: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new ConfigError(`${a} needs a value.`);
      return v;
    };
    switch (a) {
      case "--config": args.config = value(); break;
      case "--env-file": args.envFiles.push(value()); break;
      case "--out": args.out = value(); break;
      case "--days": {
        const n = Number(value());
        if (!Number.isInteger(n) || n < 1 || n > 400) throw new ConfigError("--days must be a whole number from 1 to 400.");
        args.days = n;
        break;
      }
      case "--timezone": args.timezone = value(); break;
      case "--personal-data": args.personalData = true; break;
      case "--no-upload": args.noUpload = true; break;
      case "--json": args.json = true; break;
      case "--quiet": args.quiet = true; break;
      case "--help": case "-h": args.command = "help"; break;
      case "--version": case "-v": args.command = "version"; break;
      default:
        if (a.startsWith("-")) throw new ConfigError(`Unknown option ${a}. See fusion-export --help.`);
        if (args.command) throw new ConfigError(`Unexpected argument ${a}.`);
        args.command = a;
    }
  }
  return args;
}

function settings(args: Args): ExportConfig {
  const base = args.config ? loadConfig(args.config) : buildConfig({});
  const overrides: Partial<ExportConfig> = {};
  if (args.out) overrides.outputDir = buildConfig({ outputDir: args.out }).outputDir;
  if (args.timezone) overrides.reportTimezone = buildConfig({ reportTimezone: args.timezone }).reportTimezone;
  if (args.personalData) overrides.personalData = true;
  const merged = { ...base, ...overrides };
  if (args.noUpload) delete merged.sharepoint;
  return merged;
}

function sharepointConfig(config: ExportConfig): SharePointConfig | null {
  if (!config.sharepoint) return null;
  const tenantId = config.sharepoint.tenantId ?? process.env.GRAPH_TENANT_ID ?? "";
  const clientId = config.sharepoint.clientId ?? process.env.GRAPH_CLIENT_ID ?? "";
  const clientSecret = process.env.GRAPH_CLIENT_SECRET ?? "";
  if (!tenantId || !clientId || !clientSecret) {
    throw new ConfigError("SharePoint upload is configured but GRAPH_TENANT_ID, GRAPH_CLIENT_ID or GRAPH_CLIENT_SECRET is missing from the environment.");
  }
  return { ...config.sharepoint, tenantId, clientId, clientSecret };
}

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}

export async function main(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (!args.command || args.command === "help") {
    console.log(HELP);
    return args.command ? 0 : 2;
  }
  if (args.command === "version") {
    console.log(version());
    return 0;
  }
  if (args.command === "schema") {
    console.log(args.json ? JSON.stringify(schemaDocument(), null, 2) : dataDictionary());
    return 0;
  }
  if (!["doctor", "run", "backfill"].includes(args.command)) {
    console.error(`Unknown command ${args.command}. See fusion-export --help.`);
    return 2;
  }
  try {
    for (const file of args.envFiles) process.loadEnvFile(file);
    const config = settings(args);
    const credentials = { clientId: process.env.SOPHOS_CLIENT_ID ?? "", clientSecret: process.env.SOPHOS_CLIENT_SECRET ?? "" };
    const sharepoint = sharepointConfig(config);
    const log = args.quiet || args.json ? () => {} : (m: string) => console.log(m);

    if (args.command === "doctor") {
      const report = await runDoctor({ config, credentials, sharepoint });
      if (args.json) console.log(JSON.stringify(report, null, 2));
      else {
        for (const c of report.checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);
        console.log(`${report.calls} Sophos API calls.`);
      }
      return report.ok ? 0 : 1;
    }

    const summary = await runExport({
      config,
      mode: args.command === "backfill" ? "backfill" : "run",
      ...(args.days ? { backfillDays: args.days } : {}),
      credentials,
      sharepoint,
      log,
    });
    if (args.json) console.log(JSON.stringify(summary, null, 2));
    else if (args.quiet) console.log(`${summary.ok ? "ok" : "errors"}: ${summary.calls} calls, ${Object.values(summary.tables).reduce((a, b) => a + b, 0)} rows across ${Object.keys(summary.tables).length} tables`);
    return summary.ok ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function invokedDirectly(): boolean {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}
if (invokedDirectly()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
