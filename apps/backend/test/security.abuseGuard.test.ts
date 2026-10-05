import { describe, it, expect } from "vitest";
import {
  AbuseGuard,
  InMemoryAbuseBackend,
  type AbuseRule,
} from "../src/http/abuseGuard";

/**
 * Pure unit tests for the AbuseGuard primitive (Increment 11). These use an
 * INJECTED clock so sliding-window / penalty-block behaviour is deterministic
 * and never depends on wall-clock timing (no flaky sleeps).
 */

function makeGuard(opts: { maxKeys?: number; enabled?: boolean; now?: () => number } = {}) {
  const backend = new InMemoryAbuseBackend(opts.maxKeys ?? 1000);
  const guard = new AbuseGuard(backend, opts.enabled ?? true, opts.now ?? (() => 0));
  return { backend, guard };
}

const rule: AbuseRule = { limit: 3, windowMs: 10_000 };

describe("AbuseGuard: sliding-window counting", () => {
  it("allows up to the limit, then throttles", () => {
    const { guard } = makeGuard();
    expect(guard.hit("s", "k", rule).allowed).toBe(true);
    expect(guard.hit("s", "k", rule).allowed).toBe(true);
    expect(guard.hit("s", "k", rule).allowed).toBe(true);
    const d = guard.hit("s", "k", rule);
    expect(d.allowed).toBe(false);
    expect(d.remaining).toBe(0);
    expect(d.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("reports decreasing remaining as the window fills", () => {
    const { guard } = makeGuard();
    expect(guard.hit("s", "k", rule).remaining).toBe(2);
    expect(guard.hit("s", "k", rule).remaining).toBe(1);
    expect(guard.hit("s", "k", rule).remaining).toBe(0);
  });

  it("recovers once the window slides past old hits", () => {
    let t = 0;
    const { guard } = makeGuard({ now: () => t });
    expect(guard.hit("s", "k", rule).allowed).toBe(true); // t=0
    expect(guard.hit("s", "k", rule).allowed).toBe(true);
    expect(guard.hit("s", "k", rule).allowed).toBe(true);
    expect(guard.hit("s", "k", rule).allowed).toBe(false); // over limit
    t = 10_001; // all three original hits are now outside the window
    expect(guard.hit("s", "k", rule).allowed).toBe(true);
  });

  it("keeps independent counters per scope and per key", () => {
    const { guard } = makeGuard();
    for (let i = 0; i < 3; i++) guard.hit("a", "k", rule);
    // Different scope, same key: unaffected.
    expect(guard.hit("b", "k", rule).allowed).toBe(true);
    // Same scope, different key: unaffected.
    expect(guard.hit("a", "other", rule).allowed).toBe(true);
    // Same scope+key: throttled.
    expect(guard.hit("a", "k", rule).allowed).toBe(false);
  });

  it("computes retryAfterSeconds from the oldest hit in the window", () => {
    let t = 0;
    const { guard } = makeGuard({ now: () => t });
    guard.hit("s", "k", rule); // oldest at t=0
    t = 2_000;
    guard.hit("s", "k", rule);
    t = 4_000;
    guard.hit("s", "k", rule);
    t = 5_000;
    const d = guard.hit("s", "k", rule);
    expect(d.allowed).toBe(false);
    // oldest(0) + window(10000) - now(5000) = 5000ms => 5s
    expect(d.retryAfterSeconds).toBe(5);
  });
});

describe("AbuseGuard: penalty blocks", () => {
  it("block() denies via a non-counting probe and expires", () => {
    let t = 0;
    const { guard } = makeGuard({ now: () => t });
    expect(guard.blockedFor("s", "k")).toBe(0);
    guard.block("s", "k", 300);
    expect(guard.blockedFor("s", "k")).toBe(300);
    t = 299_000;
    expect(guard.blockedFor("s", "k")).toBe(1);
    t = 300_001;
    expect(guard.blockedFor("s", "k")).toBe(0);
  });

  it("blockedFor() does NOT consume window budget", () => {
    const { guard } = makeGuard();
    for (let i = 0; i < 50; i++) expect(guard.blockedFor("s", "k")).toBe(0);
    // After 50 probes, a real hit should still be allowed (probes didn't count).
    expect(guard.hit("s", "k", rule).allowed).toBe(true);
  });

  it("an active block takes precedence over window counting", () => {
    let t = 0;
    const { guard } = makeGuard({ now: () => t });
    guard.block("s", "k", 60);
    const d = guard.hit("s", "k", rule);
    expect(d.allowed).toBe(false);
    expect(d.retryAfterSeconds).toBe(60);
  });

  it("block() extends but never shortens an existing block", () => {
    let t = 0;
    const { guard } = makeGuard({ now: () => t });
    guard.block("s", "k", 300);
    guard.block("s", "k", 10); // shorter — must not reduce
    expect(guard.blockedFor("s", "k")).toBe(300);
  });

  it("reset() clears both counts and blocks for a key", () => {
    const { guard } = makeGuard();
    guard.hit("s", "k", rule);
    guard.hit("s", "k", rule);
    guard.block("s", "k", 300);
    guard.reset("s", "k");
    expect(guard.blockedFor("s", "k")).toBe(0);
    expect(guard.hit("s", "k", rule).allowed).toBe(true);
  });
});

describe("AbuseGuard: disabled mode", () => {
  it("always allows and never blocks when disabled", () => {
    const { guard } = makeGuard({ enabled: false });
    for (let i = 0; i < 100; i++) {
      expect(guard.hit("s", "k", rule).allowed).toBe(true);
    }
    guard.block("s", "k", 300);
    expect(guard.blockedFor("s", "k")).toBe(0);
  });
});

describe("InMemoryAbuseBackend: bounded memory", () => {
  it("never exceeds the configured max key count (LRU eviction)", () => {
    const { guard, backend } = makeGuard({ maxKeys: 100 });
    for (let i = 0; i < 1000; i++) {
      guard.hit("s", `key-${i}`, rule);
    }
    expect(backend.size()).toBeLessThanOrEqual(100);
  });

  it("clear() drops all state", () => {
    const { guard, backend } = makeGuard();
    for (let i = 0; i < 10; i++) guard.hit("s", `k${i}`, rule);
    expect(backend.size()).toBeGreaterThan(0);
    guard.clear();
    expect(backend.size()).toBe(0);
  });
});
