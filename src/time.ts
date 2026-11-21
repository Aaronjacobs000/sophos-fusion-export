/**
 * Time handling. Every timestamp the exporter writes is UTC ISO 8601 with Z at
 * second precision. Local dates use one IANA report time zone with its own
 * daylight saving rules, so "a day" is the reader's day.
 */

const DAY = 86_400_000;

/** Parses an ISO timestamp (any fraction length), epoch seconds or a Date. Null when unusable. */
export function toDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") return Number.isFinite(value) ? new Date(value * 1000) : null;
  if (typeof value !== "string") return null;
  // Trim fractions longer than milliseconds, which some engines refuse.
  const text = value.trim().replace(/(\.\d{3})\d+/, "$1");
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** UTC ISO 8601 with Z, second precision, or null. */
export function isoSeconds(value: unknown): string | null {
  const date = toDate(value);
  return date ? `${date.toISOString().slice(0, 19)}Z` : null;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Throws for a time zone Intl doesn't know. */
export function assertTimeZone(timeZone: string): void {
  try {
    formatter(timeZone).format(new Date(0));
  } catch {
    throw new Error(`Unknown time zone ${JSON.stringify(timeZone)}. Use an IANA name such as Australia/Sydney or UTC.`);
  }
}

function parts(date: Date, timeZone: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(date)) if (p.type !== "literal") out[p.type] = Number(p.value);
  return out;
}

/** YYYY-MM-DD of an instant in the time zone, or null. */
export function localDate(value: unknown, timeZone: string): string | null {
  const date = toDate(value);
  if (!date) return null;
  const p = parts(date, timeZone);
  return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** A YYYY-MM-DD date as the number YYYYMMDD, or null. */
export function dateKey(day: string | null | undefined): number | null {
  return day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? Number(day.replace(/-/g, "")) : null;
}

/** Offset of the zone from UTC at an instant, in milliseconds. */
function offsetMs(at: number, timeZone: string): number {
  const p = parts(new Date(at), timeZone);
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** The UTC instant of local midnight starting the given YYYY-MM-DD in the zone. */
export function startOfLocalDay(day: string, timeZone: string): Date {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  let at = guess - offsetMs(guess, timeZone);
  // A second pass settles days where the offset changes near midnight.
  at = guess - offsetMs(at, timeZone);
  return new Date(at);
}

/** The local date `days` days before the local date of `now`. */
export function localDaysAgo(now: Date, days: number, timeZone: string): string {
  const today = localDate(now, timeZone)!;
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) - days * DAY).toISOString().slice(0, 10);
}

/** Days between two instants, to two decimals. */
export function daysBetween(from: Date, to: Date): number {
  return Math.round(((to.getTime() - from.getTime()) / DAY) * 100) / 100;
}

/** Whole days between two YYYY-MM-DD dates (b minus a). */
export function dateDiffDays(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
}
