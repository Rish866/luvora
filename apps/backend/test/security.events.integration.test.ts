import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app";
import { closePool } from "../src/db/pool";
import { resetDb, registerUser, setUserRole, auth } from "./helpers";
import {
  recordSecurityEvent,
  sanitizeMetadata,
  sourceFingerprint,
  listSecurityEvents,
  cleanupSecurityEvents,
} from "../src/security/securityEvents";
import { SecurityEventType, SecuritySeverity } from "@luvora/shared";

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

describe("security events: recording & privacy", () => {
  it("persists an event retrievable via listSecurityEvents", async () => {
    await recordSecurityEvent({
      eventType: SecurityEventType.LOGIN_THROTTLED,
      severity: SecuritySeverity.WARNING,
      category: "auth",
      metadata: { note: "hello" },
    });
    const { events } = await listSecurityEvents({ limit: 50 });
    expect(events.length).toBe(1);
    expect(events[0].eventType).toBe("LOGIN_THROTTLED");
    expect(events[0].severity).toBe("WARNING");
    expect(events[0].metadata.note).toBe("hello");
  });

  it("stores only a salted fingerprint of the source, never the raw IP", async () => {
    await recordSecurityEvent({
      eventType: SecurityEventType.LOGIN_THROTTLED,
      source: "203.0.113.42",
      metadata: {},
    });
    const { events } = await listSecurityEvents({ limit: 50 });
    const fp = events[0].sourceFingerprint;
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(fp).not.toContain("203.0.113.42");
  });

  it("sourceFingerprint is deterministic and non-reversible-looking", () => {
    const a = sourceFingerprint("1.2.3.4");
    const b = sourceFingerprint("1.2.3.4");
    const c = sourceFingerprint("1.2.3.5");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(sourceFingerprint("")).toBeNull();
    expect(sourceFingerprint("unknown")).toBeNull();
  });

  it("sanitizeMetadata drops sensitive keys and bounds size", () => {
    const out = sanitizeMetadata({
      password: "secret",
      token: "abc",
      email: "a@b.com",
      ip: "1.2.3.4",
      safe: "ok",
      count: 3,
      flag: true,
      nothing: null,
      long: "y".repeat(1000),
    });
    expect(out.password).toBeUndefined();
    expect(out.token).toBeUndefined();
    expect(out.email).toBeUndefined();
    expect(out.ip).toBeUndefined();
    expect(out.safe).toBe("ok");
    expect(out.count).toBe(3);
    expect(out.flag).toBe(true);
    expect(out.nothing).toBeNull();
    expect(String(out.long).length).toBeLessThanOrEqual(300);
  });

  it("cleanupSecurityEvents removes events older than retention", async () => {
    await recordSecurityEvent({ eventType: SecurityEventType.LOGIN_THROTTLED });
    // Negative retention => cutoff in the FUTURE, so the just-inserted row is
    // unambiguously eligible regardless of any DB/Node clock skew.
    const removed = await cleanupSecurityEvents(-1);
    expect(removed).toBeGreaterThanOrEqual(1);
    const { events } = await listSecurityEvents({ limit: 50 });
    expect(events.length).toBe(0);
  });

  it("cleanupSecurityEvents keeps events within the retention window", async () => {
    await recordSecurityEvent({ eventType: SecurityEventType.LOGIN_THROTTLED });
    // A generous retention window must NOT delete a fresh event.
    const removed = await cleanupSecurityEvents(90);
    expect(removed).toBe(0);
    const { events } = await listSecurityEvents({ limit: 50 });
    expect(events.length).toBe(1);
  });

  it("never throws into the caller on a bad metadata shape", async () => {
    await expect(
      recordSecurityEvent({ eventType: "CUSTOM_EVENT", metadata: undefined }),
    ).resolves.toBeUndefined();
  });
});

describe("GET /api/admin/security-events (admin only)", () => {
  it("requires authentication", async () => {
    const res = await request(app).get("/api/admin/security-events");
    expect(res.status).toBe(401);
  });

  it("forbids non-admin users", async () => {
    const user = await registerUser(app);
    const res = await request(app)
      .get("/api/admin/security-events")
      .set(...auth(user.accessToken));
    expect(res.status).toBe(403);
  });

  it("returns events for an admin, filterable and paginated", async () => {
    const admin = await registerUser(app);
    await setUserRole(admin.userId, "ADMIN");
    await recordSecurityEvent({ eventType: SecurityEventType.LOGIN_THROTTLED, category: "auth" });
    await recordSecurityEvent({
      eventType: SecurityEventType.REFRESH_TOKEN_REUSE,
      severity: SecuritySeverity.CRITICAL,
      category: "auth",
    });

    const all = await request(app)
      .get("/api/admin/security-events")
      .set(...auth(admin.accessToken));
    expect(all.status).toBe(200);
    expect(all.body.data.events.length).toBe(2);

    const filtered = await request(app)
      .get("/api/admin/security-events?eventType=REFRESH_TOKEN_REUSE")
      .set(...auth(admin.accessToken));
    expect(filtered.status).toBe(200);
    expect(filtered.body.data.events.length).toBe(1);
    expect(filtered.body.data.events[0].eventType).toBe("REFRESH_TOKEN_REUSE");
  });

  it("never exposes a raw IP in the admin view (fingerprint only)", async () => {
    const admin = await registerUser(app);
    await setUserRole(admin.userId, "ADMIN");
    await recordSecurityEvent({
      eventType: SecurityEventType.LOGIN_THROTTLED,
      source: "198.51.100.7",
    });
    const res = await request(app)
      .get("/api/admin/security-events")
      .set(...auth(admin.accessToken));
    expect(res.status).toBe(200);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("198.51.100.7");
  });
});
