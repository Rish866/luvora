import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Redis from "ioredis";
import { AbuseGuard } from "../src/http/abuseGuard";
import { RedisAbuseBackend } from "../src/http/redisAbuseBackend";
import { InMemoryAbuseBackend, type AbuseRule } from "../src/http/abuseBackend";
import { redisAvailable, startEphemeralRedis, type EphemeralRedis } from "./redisTestHelpers";

/**
 * Distributed login brute-force enforcement (Increment 12, §14).
 *
 * This is the attack the increment specifically targets: an attacker alternating
 * requests between two API instances must NOT be able to bypass the per-IP /
 * per-account failure limits. We model two instances as two independent guards
 * (separate fingerprint handling, separate connections) sharing ONE Redis, and
 * replicate the exact scope/fingerprint logic the real bruteForce module uses.
 *
 * We also cover the Redis-unavailable fail policy (§36) at the guard level.
 */

const haveRedis = redisAvailable();
const d = haveRedis ? describe : describe.skip;

const SCOPE_IP = "login-fail";
const SCOPE_ACCOUNT = "login-fail-acct";
const SECRET = "shared-fingerprint-secret-across-instances";
const rule: AbuseRule = { limit: 5, windowMs: 900_000 };

/** Replicate bruteForce.recordLoginFailure's dual-dimension logic against a
 *  given guard, so we exercise the real guard + backend path. */
async function recordFailure(guard: AbuseGuard, ip: string, email: string): Promise<void> {
  for (const [scope, id] of [
    [SCOPE_IP, ip],
    [SCOPE_ACCOUNT, email.toLowerCase()],
  ] as const) {
    const fp = guard.fingerprint(id);
    const decision = await guard.hitFingerprinted(scope, fp, rule);
    if (!decision.allowed || decision.remaining === 0) {
      await guard.blockFingerprinted(scope, fp, 300);
    }
  }
}

async function isThrottled(guard: AbuseGuard, ip: string, email: string): Promise<boolean> {
  for (const [scope, id] of [
    [SCOPE_IP, ip],
    [SCOPE_ACCOUNT, email.toLowerCase()],
  ] as const) {
    const fp = guard.fingerprint(id);
    if ((await guard.blockedForFingerprinted(scope, fp)) > 0) return true;
  }
  return false;
}

d("distributed login brute-force", () => {
  let server: EphemeralRedis;
  let redisA: Redis;
  let redisB: Redis;
  let guardA: AbuseGuard; // "instance A"
  let guardB: AbuseGuard; // "instance B"

  beforeAll(async () => {
    server = await startEphemeralRedis();
    redisA = new Redis(server.url, { maxRetriesPerRequest: 2 });
    redisB = new Redis(server.url, { maxRetriesPerRequest: 2 });
    await redisA.ping();
    await redisB.ping();
    guardA = new AbuseGuard(
      new RedisAbuseBackend(redisA, { prefix: "login", timeoutMs: 200 }),
      true,
      "closed",
      SECRET,
    );
    guardB = new AbuseGuard(
      new RedisAbuseBackend(redisB, { prefix: "login", timeoutMs: 200 }),
      true,
      "closed",
      SECRET,
    );
  }, 30_000);

  afterAll(async () => {
    await redisA?.quit().catch(() => {});
    await redisB?.quit().catch(() => {});
    await server?.stop();
  });

  beforeEach(async () => {
    await guardA.clear();
  });

  it("an attacker alternating between two instances cannot exceed the account limit", async () => {
    const ip = "198.51.100.5";
    const email = "victim@example.com";
    // 5 failures split across instance A and B (alternating). Limit is 5.
    const guards = [guardA, guardB, guardA, guardB, guardA];
    for (const g of guards) {
      await recordFailure(g, ip, email);
    }
    // Now BOTH instances must see the account/IP as throttled — the attacker
    // gained nothing by alternating, because state is shared in Redis.
    expect(await isThrottled(guardA, ip, email)).toBe(true);
    expect(await isThrottled(guardB, ip, email)).toBe(true);
  });

  it("fingerprints are identical across instances for the same identifier", async () => {
    // Both instances share the same fingerprint secret ⇒ same backend keys ⇒
    // shared state. (If secrets differed, enforcement would silently split.)
    expect(guardA.fingerprint("same@example.com")).toBe(guardB.fingerprint("same@example.com"));
  });

  it("a successful login on one instance clears the throttle for the other", async () => {
    const ip = "198.51.100.9";
    const email = "recover@example.com";
    for (let i = 0; i < 6; i++) await recordFailure(guardA, ip, email);
    expect(await isThrottled(guardB, ip, email)).toBe(true);
    // Clear via instance A (as a successful login would).
    for (const [scope, id] of [
      [SCOPE_IP, ip],
      [SCOPE_ACCOUNT, email.toLowerCase()],
    ] as const) {
      await guardA.resetFingerprinted(scope, guardA.fingerprint(id));
    }
    expect(await isThrottled(guardB, ip, email)).toBe(false);
  });

  it("different accounts do not share the account-dimension throttle", async () => {
    const ip = "203.0.113.1";
    for (let i = 0; i < 6; i++) await recordFailure(guardA, ip, "a@example.com");
    // The IP dimension IS shared (same ip) — but a DIFFERENT ip + account is free.
    expect(await isThrottled(guardB, "203.0.113.2", "b@example.com")).toBe(false);
  });

  it("fails CLOSED on the counting path when Redis is unreachable (policy=closed)", async () => {
    // Point a guard at a dead Redis (nothing listening on this port).
    const dead = new Redis("redis://127.0.0.1:6", {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
      commandTimeout: 150,
      retryStrategy: () => null,
    });
    const guard = new AbuseGuard(
      new RedisAbuseBackend(dead, { prefix: "dead", timeoutMs: 150 }),
      true,
      "closed",
      SECRET,
    );
    const decision = await guard.hit("scope", "x", rule);
    // Fail-closed ⇒ deny with a finite retry-after; no raw error leaks.
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
    dead.disconnect();
  });

  it("fails OPEN on the counting path when Redis is unreachable (policy=open)", async () => {
    const dead = new Redis("redis://127.0.0.1:6", {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
      commandTimeout: 150,
      retryStrategy: () => null,
    });
    const guard = new AbuseGuard(
      new RedisAbuseBackend(dead, { prefix: "dead", timeoutMs: 150 }),
      true,
      "open",
      SECRET,
    );
    const decision = await guard.hit("scope", "x", rule);
    expect(decision.allowed).toBe(true);
    dead.disconnect();
  });

  it("a probe never permanently locks a user out when Redis errors", async () => {
    const dead = new Redis("redis://127.0.0.1:6", {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
      commandTimeout: 150,
      retryStrategy: () => null,
    });
    const guard = new AbuseGuard(
      new RedisAbuseBackend(dead, { prefix: "dead", timeoutMs: 150 }),
      true,
      "closed",
      SECRET,
    );
    // blockedFor returns 0 on error (so a login gate does not deny purely on a
    // probe failure — the counting hit still applies the fail policy).
    expect(await guard.blockedForFingerprinted("login-fail", "fp")).toBe(0);
    dead.disconnect();
  });

  it("memory and redis backends expose the same decision shape", async () => {
    const mem = new AbuseGuard(new InMemoryAbuseBackend(100), true, "closed", SECRET);
    const memDecision = await mem.hit("s", "k", rule);
    const redisDecision = await guardA.hit("s2", "k2", rule);
    expect(Object.keys(memDecision).sort()).toEqual(Object.keys(redisDecision).sort());
  });
});
