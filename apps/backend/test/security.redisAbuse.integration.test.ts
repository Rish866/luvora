import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Redis from "ioredis";
import { RedisAbuseBackend } from "../src/http/redisAbuseBackend";
import { AbuseGuard } from "../src/http/abuseGuard";
import type { AbuseRule } from "../src/http/abuseBackend";
import { redisAvailable, startEphemeralRedis, type EphemeralRedis } from "./redisTestHelpers";

/**
 * REAL distributed-backend integration tests (Increment 12) against an
 * ephemeral redis-server. These prove that Redis — not shared JS memory —
 * provides coordination: each "instance" below has its OWN ioredis connection
 * and its OWN RedisAbuseBackend object; shared state exists only in Redis.
 *
 * The whole suite SKIPS cleanly if no redis-server binary is available, so
 * `npm test` stays self-contained. We never pretend a Redis test ran without
 * Redis.
 */

const haveRedis = redisAvailable();
const d = haveRedis ? describe : describe.skip;

let redisA: Redis; // "instance A" connection
let redisB: Redis; // "instance B" connection — genuinely independent client
let server: EphemeralRedis;
const PREFIX = "testns";
const rule: AbuseRule = { limit: 5, windowMs: 10_000 };

function backendFor(client: Redis) {
  return new RedisAbuseBackend(client, { prefix: PREFIX, timeoutMs: 200 });
}

d("RedisAbuseBackend (distributed)", () => {
  beforeAll(async () => {
    server = await startEphemeralRedis();
    redisA = new Redis(server.url, { maxRetriesPerRequest: 2, lazyConnect: false });
    redisB = new Redis(server.url, { maxRetriesPerRequest: 2, lazyConnect: false });
    await redisA.ping();
    await redisB.ping();
  }, 30_000);

  afterAll(async () => {
    await redisA?.quit().catch(() => {});
    await redisB?.quit().catch(() => {});
    await server?.stop();
  });

  beforeEach(async () => {
    // Clear only our namespace between tests.
    await backendFor(redisA).clear();
  });

  it("enforces the limit within a single backend", async () => {
    const b = backendFor(redisA);
    for (let i = 0; i < 5; i++) {
      expect((await b.check("k", rule, Date.now())).allowed).toBe(true);
    }
    const over = await b.check("k", rule, Date.now());
    expect(over.allowed).toBe(false);
    expect(over.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("SHARES state across two genuinely independent instances", async () => {
    // Instance A and instance B are separate objects on separate connections.
    const a = backendFor(redisA);
    const b = backendFor(redisB);
    const now = Date.now();
    // A makes 3 requests, B makes 2 → 5 total == the limit.
    expect((await a.check("shared", rule, now)).allowed).toBe(true);
    expect((await a.check("shared", rule, now)).allowed).toBe(true);
    expect((await a.check("shared", rule, now)).allowed).toBe(true);
    expect((await b.check("shared", rule, now)).allowed).toBe(true);
    expect((await b.check("shared", rule, now)).allowed).toBe(true);
    // The 6th combined request (from EITHER instance) must be rejected because
    // the state lives in Redis, not in either process's memory.
    expect((await a.check("shared", rule, now)).allowed).toBe(false);
    expect((await b.check("shared", rule, now)).allowed).toBe(false);
  });

  it("is atomic under concurrency across both instances", async () => {
    const a = backendFor(redisA);
    const b = backendFor(redisB);
    const now = Date.now();
    // Fire 20 concurrent requests split across both instances; limit = 5.
    const calls = [];
    for (let i = 0; i < 10; i++) calls.push(a.check("conc", rule, now));
    for (let i = 0; i < 10; i++) calls.push(b.check("conc", rule, now));
    const results = await Promise.all(calls);
    const allowed = results.filter((r) => r.allowed).length;
    // Atomic Lua check-and-increment ⇒ EXACTLY the limit is allowed, no more.
    expect(allowed).toBe(5);
  });

  it("expires window counters via TTL", async () => {
    const b = backendFor(redisA);
    const shortRule: AbuseRule = { limit: 2, windowMs: 1000 };
    const now = Date.now();
    expect((await b.check("ttl", shortRule, now)).allowed).toBe(true);
    expect((await b.check("ttl", shortRule, now)).allowed).toBe(true);
    expect((await b.check("ttl", shortRule, now)).allowed).toBe(false);
    // Advance past the window (the backend uses the passed `now`, so no sleep).
    const later = now + 1500;
    expect((await b.check("ttl", shortRule, later)).allowed).toBe(true);
  });

  it("penalty block via one instance is observed by the other", async () => {
    const a = backendFor(redisA);
    const b = backendFor(redisB);
    await a.block("acct", 300, Date.now());
    expect(await b.blockedFor("acct", Date.now())).toBeGreaterThan(0);
    expect(await b.blockedFor("acct", Date.now())).toBeLessThanOrEqual(300);
    // A block makes check() reject on the other instance too.
    expect((await b.check("acct", rule, Date.now())).allowed).toBe(false);
  });

  it("block() never shortens an existing block", async () => {
    const a = backendFor(redisA);
    await a.block("x", 300, Date.now());
    await a.block("x", 5, Date.now()); // shorter — must not reduce
    expect(await a.blockedFor("x", Date.now())).toBeGreaterThan(60);
  });

  it("isolates different keys / scopes (no collision)", async () => {
    const a = backendFor(redisA);
    const now = Date.now();
    for (let i = 0; i < 5; i++) await a.check("userA", rule, now);
    expect((await a.check("userA", rule, now)).allowed).toBe(false);
    // A different key has a fresh budget.
    expect((await a.check("userB", rule, now)).allowed).toBe(true);
  });

  it("reset() clears a key across instances", async () => {
    const a = backendFor(redisA);
    const b = backendFor(redisB);
    const now = Date.now();
    for (let i = 0; i < 5; i++) await a.check("r", rule, now);
    expect((await b.check("r", rule, now)).allowed).toBe(false);
    await a.reset("r");
    expect((await b.check("r", rule, now)).allowed).toBe(true);
  });

  it("retryAfterSeconds is positive and bounded by the window", async () => {
    const b = backendFor(redisA);
    const now = Date.now();
    for (let i = 0; i < 5; i++) await b.check("ra", rule, now);
    const over = await b.check("ra", rule, now);
    expect(over.retryAfterSeconds).toBeGreaterThan(0);
    expect(over.retryAfterSeconds).toBeLessThanOrEqual(rule.windowMs / 1000);
  });

  it("clear() only removes keys under its own namespace", async () => {
    const b = backendFor(redisA);
    await b.check("mine", rule, Date.now());
    // Write an unrelated key OUTSIDE the namespace.
    await redisA.set("unrelated:key", "keep");
    await b.clear();
    expect(await redisA.get("unrelated:key")).toBe("keep");
    await redisA.del("unrelated:key");
  });

  it("never writes a raw identifier into Redis (guard fingerprints keys)", async () => {
    const guard = new AbuseGuard(backendFor(redisA), true, "closed", "fp-secret");
    await guard.hit("login", "victim@example.com", rule);
    await guard.hit("ip", "203.0.113.42", rule);
    // Scan ALL keys and assert none contain the raw PII.
    const keys = await redisA.keys("*");
    const joined = keys.join("\n");
    expect(joined).not.toContain("victim@example.com");
    expect(joined).not.toContain("203.0.113.42");
    // But keys ARE present under our namespace (so we actually wrote state).
    expect(keys.some((k) => k.startsWith(`${PREFIX}:abuse:`))).toBe(true);
  });
});
