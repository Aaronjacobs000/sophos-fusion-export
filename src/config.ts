/**
 * Settings: defaults, then a JSON config file (or the same JSON in
 * FUSION_EXPORT_CONFIG_JSON, for a container), then command line flags.
 * Credentials never sit in the config; they come from the environment (or an
 * env file passed with --env-file, or Key Vault), and a config holding a
 * secret is refused.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_PER_HOUR, DEFAULT_PER_MINUTE, MAX_PER_MINUTE } from "./sophos/limiter.js";
import { assertTimeZone } from "./time.js";

export const DATASETS = ["licenses", "cases", "detections", "endpoints", "alerts", "aiDefense"] as const;
export type DatasetName = (typeof DATASETS)[number];

export interface SharePointSettings {
  siteUrl: string;
  library?: string;
  folder?: string;
  tenantId?: string;
  clientId?: string;
  /** clientSecret (default) or managedIdentity. */
  auth?: "clientSecret" | "managedIdentity";
}

export const SHAREPOINT_AUTH = ["clientSecret", "managedIdentity"] as const;

export interface ExportConfig {
  outputDir: string;
  reportTimezone: string;
  tenantName?: string;
  personalData: boolean;
  rate: { perMinute: number; perHour: number };
  maxCallsPerRun: number;
  backfillDays: number;
  detections: { trailingDays: number; retentionDays: number; pageSize: number };
  cases: { overlapMinutes: number };
  aiDefense: { trailingDays: number; retentionDays: number; backfillDays: number; inventoryDays: number };
  datasets: DatasetName[];
  sharepoint?: SharePointSettings;
}

export const DEFAULTS: ExportConfig = {
  outputDir: "./export",
  reportTimezone: "UTC",
  personalData: false,
  rate: { perMinute: DEFAULT_PER_MINUTE, perHour: DEFAULT_PER_HOUR },
  maxCallsPerRun: 2000,
  backfillDays: 90,
  detections: { trailingDays: 7, retentionDays: 90, pageSize: 10_000 },
  cases: { overlapMinutes: 15 },
  aiDefense: { trailingDays: 3, retentionDays: 90, backfillDays: 30, inventoryDays: 30 },
  datasets: [...DATASETS],
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const SECRET_KEY = /secret|password|token|apikey|api_key/i;

function findSecretKeys(value: unknown, path: string[] = []): string[] {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, v]) =>
    SECRET_KEY.test(key) ? [[...path, key].join(".")] : findSecretKeys(v, [...path, key])
  );
}

function positiveInt(value: unknown, name: string, max = Number.MAX_SAFE_INTEGER): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new ConfigError(`${name} must be a whole number from 1 to ${max}.`);
  return n;
}

/** Merges a parsed config object over the defaults and checks it. Relative paths resolve against baseDir. */
export function buildConfig(raw: Record<string, unknown>, baseDir = process.cwd()): ExportConfig {
  const secrets = findSecretKeys(raw);
  if (secrets.length) {
    throw new ConfigError(`The config file holds ${secrets.join(", ")}. Put credentials in environment variables or an --env-file instead, never in the config file.`);
  }
  const rate = (raw.rate ?? {}) as Record<string, unknown>;
  const detections = (raw.detections ?? {}) as Record<string, unknown>;
  const cases = (raw.cases ?? {}) as Record<string, unknown>;
  const ai = (raw.aiDefense ?? {}) as Record<string, unknown>;
  const aiSetting = (key: "trailingDays" | "retentionDays" | "backfillDays" | "inventoryDays", max: number) =>
    ai[key] === undefined ? DEFAULTS.aiDefense[key] : positiveInt(ai[key], `aiDefense.${key}`, max);
  const config: ExportConfig = {
    outputDir: resolve(baseDir, typeof raw.outputDir === "string" ? raw.outputDir : DEFAULTS.outputDir),
    reportTimezone: typeof raw.reportTimezone === "string" ? raw.reportTimezone : DEFAULTS.reportTimezone,
    ...(typeof raw.tenantName === "string" && raw.tenantName.trim() ? { tenantName: raw.tenantName.trim() } : {}),
    personalData: raw.personalData === true,
    rate: {
      perMinute: rate.perMinute === undefined ? DEFAULTS.rate.perMinute : positiveInt(rate.perMinute, "rate.perMinute", MAX_PER_MINUTE),
      perHour: rate.perHour === undefined ? DEFAULTS.rate.perHour : positiveInt(rate.perHour, "rate.perHour", 10_000),
    },
    maxCallsPerRun: raw.maxCallsPerRun === undefined ? DEFAULTS.maxCallsPerRun : positiveInt(raw.maxCallsPerRun, "maxCallsPerRun", 100_000),
    backfillDays: raw.backfillDays === undefined ? DEFAULTS.backfillDays : positiveInt(raw.backfillDays, "backfillDays", 400),
    detections: {
      trailingDays: detections.trailingDays === undefined ? DEFAULTS.detections.trailingDays : positiveInt(detections.trailingDays, "detections.trailingDays", 90),
      retentionDays: detections.retentionDays === undefined ? DEFAULTS.detections.retentionDays : positiveInt(detections.retentionDays, "detections.retentionDays", 3650),
      pageSize: detections.pageSize === undefined ? DEFAULTS.detections.pageSize : positiveInt(detections.pageSize, "detections.pageSize", 10_000),
    },
    cases: { overlapMinutes: cases.overlapMinutes === undefined ? DEFAULTS.cases.overlapMinutes : positiveInt(cases.overlapMinutes, "cases.overlapMinutes", 1440) },
    aiDefense: {
      trailingDays: aiSetting("trailingDays", 90),
      retentionDays: aiSetting("retentionDays", 3650),
      backfillDays: aiSetting("backfillDays", 400),
      inventoryDays: aiSetting("inventoryDays", 90),
    },
    datasets: DEFAULTS.datasets,
  };
  if (raw.datasets !== undefined) {
    if (!Array.isArray(raw.datasets) || raw.datasets.some((d) => !(DATASETS as readonly string[]).includes(String(d)))) {
      throw new ConfigError(`datasets must be a list drawn from ${DATASETS.join(", ")}.`);
    }
    config.datasets = DATASETS.filter((d) => (raw.datasets as string[]).includes(d));
  }
  if (raw.sharepoint !== undefined) {
    const sp = raw.sharepoint as Record<string, unknown>;
    if (!sp || typeof sp.siteUrl !== "string") throw new ConfigError("sharepoint.siteUrl is required when sharepoint is set.");
    if (sp.auth !== undefined && !(SHAREPOINT_AUTH as readonly unknown[]).includes(sp.auth)) {
      throw new ConfigError(`sharepoint.auth must be ${SHAREPOINT_AUTH.join(" or ")}.`);
    }
    config.sharepoint = {
      siteUrl: sp.siteUrl,
      ...(typeof sp.library === "string" ? { library: sp.library } : {}),
      ...(typeof sp.folder === "string" ? { folder: sp.folder } : {}),
      ...(typeof sp.tenantId === "string" ? { tenantId: sp.tenantId } : {}),
      ...(typeof sp.clientId === "string" ? { clientId: sp.clientId } : {}),
      ...(sp.auth === "managedIdentity" ? { auth: "managedIdentity" as const } : {}),
    };
  }
  if (config.detections.retentionDays < config.detections.trailingDays) {
    throw new ConfigError("detections.retentionDays can't be shorter than detections.trailingDays.");
  }
  if (config.aiDefense.retentionDays < Math.max(config.aiDefense.trailingDays, config.aiDefense.backfillDays)) {
    throw new ConfigError("aiDefense.retentionDays can't be shorter than aiDefense.trailingDays or aiDefense.backfillDays.");
  }
  assertTimeZone(config.reportTimezone);
  return config;
}

/** Parses config JSON from a file or the environment. `source` names it in error messages. */
export function parseConfigJson(text: string, source: string, baseDir: string): ExportConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError(`${source} is not valid JSON.`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError(`${source} must hold a JSON object.`);
  return buildConfig(raw as Record<string, unknown>, baseDir);
}

export function loadConfig(path: string | undefined): ExportConfig {
  if (!path) return buildConfig({});
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ConfigError(`Can't read the config file ${path}.`);
  }
  return parseConfigJson(text, path, resolve(path, ".."));
}

/** The variable that carries the config JSON when there is no config file, as in the Azure Container Apps job. */
export const CONFIG_ENV = "FUSION_EXPORT_CONFIG_JSON";
