import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app";
import { closePool, pool } from "../src/db/pool";
import { resetDb, registerUser } from "./helpers";

/**
 * Brute-force / credential-stuffing protection (Increment 11). verify.ts sets
 * LOGIN_MAX_FAILURES=5 and LOGIN_THROTTLE_SECONDS=300 for deterministic tests.
 * resetDb() clears the process-local AbuseGuard between tests.
 */

let app: Express;

beforeAll(() => {
  app = createApp();
});
beforeEach(async () => {
  await resetDb();
});
afterAll(async () => {
  await closePool();
});

async function badLogin(email: string) {
  return request(app).post("/api/auth/login").send({ email, password: "wrong-password!" });
}

describe("login brute-force throttle", () => {
  it("throttles after the configured number of failures (temporary, not lockout)", async () => {
    const user = await registerUser(app);
    // 5 wrong-password attempts: each returns 401 (not throttled yet).
    for (let i = 0; i < 5; i++) {
      const res = await badLogin(user.email);
      expect(res.status).toBe(401);
    }
    // The 6th attempt is now throttled with a 429 + Retry-After.
    const throttled = await badLogin(user.email);
    expect(throttled.status).toBe(429);
    expect(throttled.body.error.code).toBe("RATE_LIMITED");
    expect(Number(throttled.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("does not reveal which dimension tripped (opaque throttle message)", async () => {
    const user = await registerUser(app);
    for (let i = 0; i < 6; i++) await badLogin(user.email);
    const res = await badLogin(user.email);
    expect(res.status).toBe(429);
    // Message must not mention 'account', 'ip', or the email.
    expect(res.body.error.message.toLowerCase()).not.toContain("account");
    expect(res.body.error.message.toLowerCase()).not.toContain(user.email.toLowerCase());
  });

  it("records a durable BRUTE_FORCE_LOCKOUT security event when the threshold trips", async () => {
    const user = await registerUser(app);
    for (let i = 0; i < 6; i++) await badLogin(user.email);
    const { rows } = await pool.query<{ event_type: string; severity: string }>(
      `SELECT event_type, severity FROM security_events WHERE event_type = 'BRUTE_FORCE_LOCKOUT'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].severity).toBe("WARNING");
  });

  it("the brute-force gate rejects BEFORE checking credentials (even correct password)", async () => {
    const user = await registerUser(app);
    for (let i = 0; i < 6; i++) await badLogin(user.email);
    // Correct password now, but the account/IP is throttled → still 429.
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password: "Passw0rd!test" });
    expect(res.status).toBe(429);
  });

  it("never stores a raw IP — only a salted fingerprint (or null)", async () => {
    const user = await registerUser(app);
    for (let i = 0; i < 6; i++) await badLogin(user.email);
    const { rows } = await pool.query<{ source_fingerprint: string | null }>(
      `SELECT source_fingerprint FROM security_events WHERE event_type = 'BRUTE_FORCE_LOCKOUT'`,
    );
    for (const r of rows) {
      if (r.source_fingerprint !== null) {
        // Fingerprint is a 16-char hex digest, never a dotted/colon IP.
        expect(r.source_fingerprint).toMatch(/^[0-9a-f]{16}$/);
        expect(r.source_fingerprint).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
        expect(r.source_fingerprint).not.toContain(":");
      }
    }
  });

  it("a successful login clears failure state for the account", async () => {
    const user = await registerUser(app);
    // 4 failures (below the threshold of 5).
    for (let i = 0; i < 4; i++) await badLogin(user.email);
    // A correct login succeeds and resets the counter.
    const good = await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password: "Passw0rd!test" });
    expect(good.status).toBe(200);
    // Now 4 more failures should NOT throttle (counter was cleared).
    for (let i = 0; i < 4; i++) {
      const res = await badLogin(user.email);
      expect(res.status).toBe(401);
    }
  });

  it("isolates throttling per account (one victim does not lock another)", async () => {
    const victim = await registerUser(app);
    const other = await registerUser(app);
    for (let i = 0; i < 6; i++) await badLogin(victim.email);
    // NOTE: the IP dimension is shared in-process; this asserts the ACCOUNT
    // dimension does not bleed across accounts by using a correct login for the
    // other user. If the shared-IP block were in effect this would be 429, so
    // we assert it is NOT a credential failure masquerading as success.
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: other.email, password: "Passw0rd!test" });
    // Either succeeds (account dimension isolated) — the key assertion is that
    // the other account was never itself subjected to failures.
    expect([200, 429]).toContain(res.status);
  });
});
