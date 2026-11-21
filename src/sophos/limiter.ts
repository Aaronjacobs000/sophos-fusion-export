/**
 * One rate limiter per credential, shared by every call a run makes.
 *
 * Sophos enforces 100 calls a minute per credential (bursts to 300) and
 * recommends no more than 1,000 an hour, and that budget is shared with every
 * other integration on the same credential. The exporter aims well under
 * both: 60 a minute and 900 an hour by default, counted over sliding windows,
 * so no 60 seconds ever hold more than the budget however the calls bunch up.
 * A 429 pauses the whole credential for Retry-After seconds (30 s when Sophos
 * sends none), with jitter, rather than letting every caller retry on its own.
 *
 * Adapted from the SecOps Toolkit's rate limiter (MIT, same author), without
 * the on-screen priorities a batch job has no use for.
 */

export interface RateLimiterOptions {
  perMinute?: number;
  perHour?: number;
  now?: () => number;
  /** Timer hooks, replaced by tests to drive a fake clock. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  random?: () => number;
}

const MINUTE = 60_000;
const HOUR = 3_600_000;

/** The most a run may ask for: Sophos enforces 100 a minute per credential. */
export const MAX_PER_MINUTE = 100;
export const DEFAULT_PER_MINUTE = 60;
export const DEFAULT_PER_HOUR = 900;

export class RateLimiter {
  readonly perMinute: number;
  readonly perHour: number;
  private stamps: number[] = [];
  private queue: Array<() => void> = [];
  private timer: unknown = null;
  private pausedUntil = 0;
  private now: () => number;
  private setTimer: (fn: () => void, ms: number) => unknown;
  private clearTimer: (handle: unknown) => void;
  private random: () => number;
  /** Calls let through. */
  total = 0;
  /** Times a call had to wait. */
  throttled = 0;

  constructor(options: RateLimiterOptions = {}) {
    const perMinute = options.perMinute ?? DEFAULT_PER_MINUTE;
    const perHour = options.perHour ?? DEFAULT_PER_HOUR;
    this.perMinute = Math.max(1, Math.min(MAX_PER_MINUTE, Number.isFinite(perMinute) ? Math.floor(perMinute) : DEFAULT_PER_MINUTE));
    this.perHour = Math.max(1, Number.isFinite(perHour) ? Math.floor(perHour) : DEFAULT_PER_HOUR);
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.random = options.random ?? Math.random;
  }

  /** How long until a call may go, or 0 now. Pure apart from trimming old stamps. */
  waitMs(at = this.now()): number {
    while (this.stamps.length && this.stamps[0]! <= at - HOUR) this.stamps.shift();
    let wait = Math.max(0, this.pausedUntil - at);
    if (this.stamps.length >= this.perHour) {
      wait = Math.max(wait, this.stamps[this.stamps.length - this.perHour]! + HOUR - at);
    }
    let inMinute = 0;
    for (let i = this.stamps.length - 1; i >= 0 && this.stamps[i]! > at - MINUTE; i--) inMinute++;
    if (inMinute >= this.perMinute) {
      wait = Math.max(wait, this.stamps[this.stamps.length - this.perMinute]! + MINUTE - at);
    }
    return wait;
  }

  /** Resolves when this call may go, in arrival order. */
  acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
      this.pump();
    });
  }

  private pump(): void {
    if (this.timer !== null) return;
    while (this.queue.length) {
      const at = this.now();
      const wait = this.waitMs(at);
      if (wait > 0) {
        this.throttled++;
        this.timer = this.setTimer(() => {
          this.timer = null;
          this.pump();
        }, wait + 5);
        return;
      }
      const next = this.queue.shift()!;
      this.stamps.push(at);
      this.total++;
      next();
    }
  }

  /** Sophos said 429: hold every call on this credential for Retry-After (default 30 s), plus jitter. */
  backoff(retryAfterSeconds?: number | null): void {
    const base = retryAfterSeconds && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 30_000;
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + base + Math.round(this.random() * 2000));
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.pump();
  }

  /** The most calls in any 60-second window so far. */
  peakPerMinute(): number {
    let peak = 0;
    let start = 0;
    for (let end = 0; end < this.stamps.length; end++) {
      while (this.stamps[end]! - this.stamps[start]! >= MINUTE) start++;
      peak = Math.max(peak, end - start + 1);
    }
    return peak;
  }
}
