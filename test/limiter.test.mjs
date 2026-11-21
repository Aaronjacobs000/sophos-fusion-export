// The rate limiter on a fake clock: no 60 seconds ever hold more than the
// per-minute budget, the hourly budget holds, and a 429 pauses everything.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter, MAX_PER_MINUTE, DEFAULT_PER_MINUTE } from "../dist/sophos/limiter.js";

function fakeClock() {
  let now = 1_000_000;
  const timers = [];
  return {
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { at: now + ms, fn };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      const i = timers.indexOf(t);
      if (i >= 0) timers.splice(i, 1);
    },
    /** Runs timers in time order until the queue drains or `until` is reached. */
    async run(until = Infinity) {
      for (;;) {
        await new Promise((r) => setImmediate(r));
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > until) return;
        timers.shift();
        now = Math.max(now, next.at);
        next.fn();
      }
    },
    advance(ms) {
      now += ms;
    },
  };
}

test("defaults sit well under Sophos's 100 a minute, and no setting can pass it", () => {
  assert.equal(new RateLimiter().perMinute, DEFAULT_PER_MINUTE);
  assert.ok(DEFAULT_PER_MINUTE < 100);
  assert.equal(new RateLimiter({ perMinute: 500 }).perMinute, MAX_PER_MINUTE);
  assert.equal(new RateLimiter({ perMinute: Number.NaN }).perMinute, DEFAULT_PER_MINUTE);
  assert.equal(new RateLimiter({ perMinute: 0 }).perMinute, 1);
});

test("250 calls never put more than the budget in any 60 seconds", async () => {
  const clock = fakeClock();
  const limiter = new RateLimiter({ perMinute: 60, perHour: 900, ...clock, random: () => 0 });
  const done = Array.from({ length: 250 }, () => limiter.acquire());
  await clock.run();
  await Promise.all(done);
  assert.equal(limiter.total, 250);
  assert.equal(limiter.peakPerMinute(), 60);
  assert.ok(limiter.throttled > 0);
});

test("the hourly budget holds", async () => {
  const clock = fakeClock();
  const limiter = new RateLimiter({ perMinute: 100, perHour: 120, ...clock, random: () => 0 });
  const start = clock.now();
  const done = Array.from({ length: 121 }, () => limiter.acquire());
  let finished = 0;
  done.forEach((p) => p.then(() => finished++));
  await clock.run(start + 30 * 60_000);
  assert.equal(finished, 120);
  await clock.run();
  await Promise.all(done);
  assert.ok(clock.now() - start >= 3_600_000);
});

test("a 429 pauses every waiting call for Retry-After", async () => {
  const clock = fakeClock();
  const limiter = new RateLimiter({ perMinute: 100, ...clock, random: () => 0 });
  await Promise.all([limiter.acquire()].concat([]));
  await clock.run();
  limiter.backoff(10);
  const before = clock.now();
  const next = limiter.acquire();
  await clock.run();
  await next;
  assert.ok(clock.now() - before >= 10_000);
});

test("a 429 with no Retry-After waits 30 seconds", async () => {
  const clock = fakeClock();
  const limiter = new RateLimiter({ perMinute: 100, ...clock, random: () => 0 });
  limiter.backoff(null);
  const before = clock.now();
  const next = limiter.acquire();
  await clock.run();
  await next;
  assert.ok(clock.now() - before >= 30_000);
});
