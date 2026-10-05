import { describe, it, expect } from "vitest";
import { AbuseGuard } from "../src/http/abuseGuard";
import { InMemoryAbuseBackend, type AbuseRule } from "../src/http/abuseBackend";

/**
 * Pure unit tests for the AbuseBackend mechanics and the AbuseGuard wrapper
 * (Increment 11 → async in Increment 12). An INJECTED clock makes sliding-window
 * / penalty-block behaviour deterministic (no flaky sleeps). The backend
 * interface is async; the in-memory implementation resolves immediately.
 */

const rule: AbuseRule = { limit: 3, windowMs: 10_000 };

function backend(maxKeys = 1000) {
  return new InMemoryAbuseBackend(maxKeys);
}

describe("InMemoryAbuseBackend: sliding-window counting", () => {
  it("allows up to the limit, then throttles", async () => {
    const b = backend();
    expect((await b.check("k", rule, 0)).allowed).toBe(true);
    expect((await b.check("k", rule, 0)).allowed).toBe(true);
    expect((await b.check("k", rule, 0)).allowed).toBe(true);
    const d = await b.check("k", rule, 0);
    expect(d.allowed).toBe(false);
    expect(d.remaining).toBe(0);
    expect(d.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("reports decreasing remaining as the window fills", async () => {
    const b = backend();
    expect((await b.check("k", rule, 0)).remaining).toBe(2);
    expect((await b.check("k", rule, 0)).remaining).toBe(1);
    expect((await b.check("k", rule, 0)).remaining).toBe(0);
  });

  it("recovers once the window slides past old hits", async () => {
    const b = backend();
    expect((await b.check("k", rule, 0)).allowed).toBe(true);
    expect((await b.check("k", rule, 0)).allowed).toBe(true);
    expect((await b.check("k", rule, 0)).allowed).toBe(true);
    expect((await b.check("k", rule, 0)).allowed).toBe(false);
    // All three original hits are now outside the window.
    expect((await b.check("k", rule, 10_001)).allowed).toBe(true);
  });

  it("keeps independent counters per key", async () => {
    const b = backend();
    for (let i = 0; i < 3; i++) await b.check("a", rule, 0);
    expect((await b.check("other", rule, 0)).allowed).toBe(true);
    expect((await b.check("a", rule, 0)).allowed).toBe(false);
  });

  it("computes retryAfterSeconds from the oldest hit in the window", async () => {
    const b = backend();
    await b.check("k", rule, 0); // oldest at t=0
    await b.check("k", rule, 2_000);
    await b.check("k", rule, 4_000);
    const d = await b.check("k", rule, 5_000);
    expect(d.allowed).toBe(false);
    // oldest(0) + window(10000) - now(5000) = 5000ms => 5s
    expect(d.retryAfterSeconds).toBe(5);
  });
});

describe("InMemoryAbuseBackend: penalty blocks", () => {
  it("block() denies via a non-counting probe and expires", async () => {
    const b = backend();
    expect(await b.blockedFor("k", 0)).toBe(0);
    await b.block("k", 300, 0);
    expect(await b.blockedFor("k", 0)).toBe(300);
    expect(await b.blockedFor("k", 299_000)).toBe(1);
    expect(await b.blockedFor("k", 300_001)).toBe(0);
  });

  it("blockedFor() does NOT consume window budget", async () => {
    const b = backend();
    for (let i = 0; i < 50; i++) expect(await b.blockedFor("k", 0)).toBe(0);
    expect((await b.check("k", rule, 0)).allowed).toBe(true);
  });

  it("an active block takes precedence over window counting", async () => {
    const b = backend();
    await b.block("k", 60, 0);
    const d = await b.check("k", rule, 0);
    expect(d.allowed).toBe(false);
    expect(d.retryAfterSeconds).toBe(60);
  });

  it("block() extends but never shortens an existing block", async () => {
    const b = backend();
    await b.block("k", 300, 0);
    await b.block("k", 10, 0); // shorter — must not reduce
    expect(await b.blockedFor("k", 0)).toBe(300);
  });

  it("reset() clears both counts and blocks for a key", async () => {
    const b = backend();
    await b.check("k", rule, 0);
    await b.check("k", rule, 0);
    await b.block("k", 300, 0);
    await b.reset("k");
    expect(await b.blockedFor("k", 0)).toBe(0);
    expect((await b.check("k", rule, 0)).allowed).toBe(true);
  });
});

describe("InMemoryAbuseBackend: bounded memory", () => {
  it("never exceeds the configured max key count (LRU eviction)", async () => {
    const b = backend(100);
    for (let i = 0; i < 1000; i++) await b.check(`key-${i}`, rule, 0);
    expect(await b.size()).toBeLessThanOrEqual(100);
  });

  it("clear() drops all state", async () => {
    const b = backend();
    for (let i = 0; i < 10; i++) await b.check(`k${i}`, rule, 0);
    expect(await b.size()).toBeGreaterThan(0);
    await b.clear();
    expect(await b.size()).toBe(0);
  });
});

describe("AbuseGuard: wrapper behaviour", () => {
  function guard(opts: { enabled?: boolean; failPolicy?: "open" | "closed" } = {}) {
    return new AbuseGuard(
      backend(),
      opts.enabled ?? true,
      opts.failPolicy ?? "closed",
      "unit-test-fingerprint-secret",
    );
  }

  it("exposes the active backend kind", () => {
    expect(guard().backendKind).toBe("memory");
  });

  it("fingerprints identifiers (never echoes the raw value)", () => {
    const g = guard();
    const fp = g.fingerprint("203.0.113.9");
    expect(fp).toMatch(/^[0-9a-f]{20}$/);
    expect(fp).not.toContain("203.0.113.9");
    // Deterministic + distinct per input.
    expect(g.fingerprint("203.0.113.9")).toBe(fp);
    expect(g.fingerprint("203.0.113.10")).not.toBe(fp);
    // Empty / unknown collapse to a stable sentinel.
    expect(g.fingerprint(undefined)).toBe("none");
    expect(g.fingerprint("unknown")).toBe("none");
  });

  it("enforces the limit through hit() keyed by identifier", async () => {
    const g = guard();
    for (let i = 0; i < 3; i++) {
      expect((await g.hit("scope", "1.2.3.4", rule)).allowed).toBe(true);
    }
    expect((await g.hit("scope", "1.2.3.4", rule)).allowed).toBe(false);
    // A different identifier is unaffected (independent fingerprint).
    expect((await g.hit("scope", "9.9.9.9", rule)).allowed).toBe(true);
  });

  it("always allows when disabled", async () => {
    const g = guard({ enabled: false });
    for (let i = 0; i < 100; i++) {
      expect((await g.hit("s", "k", rule)).allowed).toBe(true);
    }
  });

  it("fails CLOSED (deny) when the backend throws under the closed policy", async () => {
    const throwing = {
      kind: "redis",
      check: async () => {
        throw new Error("backend down");
      },
      blockedFor: async () => 0,
      block: async () => {},
      reset: async () => {},
      size: async () => 0,
      clear: async () => {},
    };
    const g = new AbuseGuard(throwing, true, "closed", "s");
    const d = await g.hit("s", "k", rule);
    expect(d.allowed).toBe(false);
    expect(d.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("fails OPEN (allow) when the backend throws under the open policy", async () => {
    const throwing = {
      kind: "redis",
      check: async () => {
        throw new Error("backend down");
      },
      blockedFor: async () => 0,
      block: async () => {},
      reset: async () => {},
      size: async () => 0,
      clear: async () => {},
    };
    const g = new AbuseGuard(throwing, true, "open", "s");
    expect((await g.hit("s", "k", rule)).allowed).toBe(true);
  });

  it("a probe (blockedFor) returns 0 on backend error — never a permanent lockout", async () => {
    const throwing = {
      kind: "redis",
      check: async () => ({ allowed: true, remaining: 1, retryAfterSeconds: 0, count: 0 }),
      blockedFor: async () => {
        throw new Error("backend down");
      },
      block: async () => {},
      reset: async () => {},
      size: async () => 0,
      clear: async () => {},
    };
    const g = new AbuseGuard(throwing, true, "closed", "s");
    expect(await g.blockedForFingerprinted("s", "fp")).toBe(0);
  });
});
