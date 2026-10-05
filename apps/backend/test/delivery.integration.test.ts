import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app";
import { closePool, pool } from "../src/db/pool";
import {
  resetDb,
  registerUser,
  createMatch,
  setUserRole,
  auth,
  type RegisteredUser,
} from "./helpers";
import { TestPushProvider } from "../src/notifications/push/TestPushProvider";
import { DisabledPushProvider } from "../src/notifications/push/DisabledPushProvider";
import {
  setPushProvider,
  resetPushProvider,
} from "../src/notifications/push/pushProviders";
import * as service from "../src/notifications/notificationService";
import { NotificationType, NotificationCategory, type NotificationView } from "@luvora/shared";
import {
  retryFailedDeliveries,
  dispatchPush,
  toPushPayload,
} from "../src/notifications/deliveryDispatcher";

/** Minimal safe view for direct dispatcher calls in tests. */
function viewOf(id: string): NotificationView {
  return {
    id,
    type: NotificationType.SYSTEM,
    category: NotificationCategory.SYSTEM,
    title: "",
    body: "",
    entityType: null,
    entityId: null,
    readAt: null,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Notification delivery tests (Increment 8). Verify the push pipeline against a
 * real PostgreSQL: delivery tracking, idempotency/dedup, bounded retry,
 * permanent-failure token revocation, push preferences (distinct from in-app
 * existence), SAFETY bypass, and privacy of the push payload.
 */

let app: Express;
let push: TestPushProvider;

beforeAll(() => {
  app = createApp();
});
beforeEach(async () => {
  await resetDb();
  push = new TestPushProvider();
  setPushProvider(push);
});
afterEach(() => {
  resetPushProvider();
});
afterAll(async () => {
  await closePool();
});

const H = (u: RegisteredUser) => auth(u.accessToken);

async function registerDevice(
  u: RegisteredUser,
  token = `tok-${u.userId.slice(0, 8)}-ok`,
  provider = "FCM",
  platform = "ANDROID",
): Promise<string> {
  const res = await request(app)
    .post("/api/notifications/devices")
    .set(...H(u))
    .send({ platform, provider, token });
  if (res.status !== 201) throw new Error(`device register failed: ${res.status}`);
  return res.body.data.device.id;
}

/** Create a MESSAGE_RECEIVED-style notification for a user via the service (so
 *  the full create→deliver pipeline runs), awaiting background delivery. */
async function createNotif(
  userId: string,
  dedupeKey: string | null = null,
  type: NotificationType = NotificationType.SYSTEM,
): Promise<string | null> {
  const r = await service.create({
    userId,
    type,
    title: "x",
    body: "y",
    entityType: "system",
    entityId: null,
    dedupeKey,
  });
  // The service fires delivery with `void deliver(...)`; wait for it to settle.
  await settle();
  return r.notification?.id ?? null;
}

/** Allow fire-and-forget delivery (void deliver) to finish its DB writes. */
async function settle(ms = 150): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("delivery: push pipeline", () => {
  it("delivers to a registered device and records a DELIVERED push row", async () => {
    const u = await registerUser(app);
    await registerDevice(u);
    const nid = await createNotif(u.userId);
    expect(nid).toBeTruthy();
    expect(push.sent).toHaveLength(1);
    const { rows } = await pool.query(
      `SELECT status, channel FROM notification_deliveries WHERE notification_id=$1 AND channel='PUSH'`,
      [nid],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("DELIVERED");
  });

  it("records a REALTIME delivery row for every notification", async () => {
    const u = await registerUser(app);
    const nid = await createNotif(u.userId);
    const { rows } = await pool.query(
      `SELECT status FROM notification_deliveries WHERE notification_id=$1 AND channel='REALTIME'`,
      [nid],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("DELIVERED");
  });

  it("the push payload carries only opaque references (no title/body leak)", async () => {
    const u = await registerUser(app);
    await registerDevice(u);
    await service.create({
      userId: u.userId,
      type: NotificationType.SYSTEM,
      title: "secret-title",
      body: "secret-body-text",
      entityType: "system",
      entityId: null,
    });
    await settle();
    expect(push.sent).toHaveLength(1);
    const payloadStr = JSON.stringify(push.sent[0].payload);
    expect(payloadStr).not.toContain("secret-title");
    expect(payloadStr).not.toContain("secret-body-text");
    // Opaque references only.
    expect(push.sent[0].payload.notificationId).toBeTruthy();
    expect(push.sent[0].payload.type).toBe("SYSTEM");
  });

  it("the disabled provider performs no delivery but still records an attempt", async () => {
    setPushProvider(new DisabledPushProvider());
    const u = await registerUser(app);
    await registerDevice(u);
    const nid = await createNotif(u.userId);
    const { rows } = await pool.query(
      `SELECT status, last_error_code FROM notification_deliveries WHERE notification_id=$1 AND channel='PUSH'`,
      [nid],
    );
    expect(rows[0].status).toBe("REVOKED"); // terminal no-op
    expect(rows[0].last_error_code).toBe("PUSH_DISABLED");
    // Device is NOT revoked just because push is globally disabled.
    const dev = await pool.query(
      `SELECT revoked_at FROM notification_devices WHERE user_id=$1`,
      [u.userId],
    );
    expect(dev.rows[0].revoked_at).toBeNull();
  });

  it("no devices → no push rows (notification still created)", async () => {
    const u = await registerUser(app);
    const nid = await createNotif(u.userId);
    expect(nid).toBeTruthy();
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM notification_deliveries WHERE notification_id=$1 AND channel='PUSH'`,
      [nid],
    );
    expect(rows[0].n).toBe(0);
  });
});

describe("delivery: idempotency + concurrency", () => {
  it("dispatching the same notification twice does not duplicate push rows", async () => {
    const u = await registerUser(app);
    const deviceId = await registerDevice(u);
    void deviceId;
    const nid = (await createNotif(u.userId))!;
    const view = viewOf(nid);
    // Re-dispatch (simulating a reprocessed event).
    await dispatchPush(u.userId, view, true);
    await dispatchPush(u.userId, view, true);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM notification_deliveries WHERE notification_id=$1 AND channel='PUSH'`,
      [nid],
    );
    expect(rows[0].n).toBe(1);
  });

  it("concurrent dispatch attempts create exactly one delivery row", async () => {
    const u = await registerUser(app);
    await registerDevice(u);
    const nid = (await createNotif(u.userId))!;
    const view = viewOf(nid);
    await Promise.all([
      dispatchPush(u.userId, view, true),
      dispatchPush(u.userId, view, true),
      dispatchPush(u.userId, view, true),
    ]);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM notification_deliveries WHERE notification_id=$1 AND channel='PUSH'`,
      [nid],
    );
    expect(rows[0].n).toBe(1);
  });

  it("the push payload builder omits the human-readable title/body", () => {
    const payload = toPushPayload({
      id: "11111111-1111-4111-8111-111111111111",
      type: "MESSAGE_RECEIVED" as never,
      category: "MESSAGES" as never,
      title: "New message",
      body: "You have a new message.",
      entityType: "conversation",
      entityId: "22222222-2222-4222-8222-222222222222",
      readAt: null,
      createdAt: new Date().toISOString(),
    });
    expect(Object.keys(payload).sort()).toEqual(
      ["category", "entityId", "entityType", "notificationId", "type"],
    );
  });
});

describe("delivery: failures, retry, revocation", () => {
  it("a permanent failure (invalid token) revokes the device and does not retry", async () => {
    const u = await registerUser(app);
    await registerDevice(u, "tok-invalid-token"); // TestPushProvider → PERMANENT
    const nid = await createNotif(u.userId);
    const d = await pool.query(
      `SELECT status FROM notification_deliveries WHERE notification_id=$1 AND channel='PUSH'`,
      [nid],
    );
    expect(d.rows[0].status).toBe("REVOKED");
    const dev = await pool.query(
      `SELECT revoked_at FROM notification_devices WHERE user_id=$1`,
      [u.userId],
    );
    expect(dev.rows[0].revoked_at).not.toBeNull();
    // Retry pass does nothing for a REVOKED row.
    const r = await retryFailedDeliveries();
    expect(r.delivered).toBe(0);
  });

  it("a temporary failure is retryable and succeeds once the token works", async () => {
    const u = await registerUser(app);
    const deviceId = await registerDevice(u, "tok-temp-fail"); // TEMPORARY
    const nid = await createNotif(u.userId);
    let d = await pool.query(
      `SELECT status, attempt_count FROM notification_deliveries WHERE notification_id=$1 AND channel='PUSH'`,
      [nid],
    );
    expect(d.rows[0].status).toBe("FAILED");
    expect(d.rows[0].attempt_count).toBe(1);

    // "Fix" the device token so the retry succeeds.
    await pool.query(`UPDATE notification_devices SET token='tok-now-ok' WHERE id=$1`, [deviceId]);
    const r = await retryFailedDeliveries();
    expect(r.delivered).toBe(1);
    d = await pool.query(
      `SELECT status, attempt_count FROM notification_deliveries WHERE notification_id=$1 AND channel='PUSH'`,
      [nid],
    );
    expect(d.rows[0].status).toBe("DELIVERED");
    expect(d.rows[0].attempt_count).toBe(2);
  });

  it("temporary failures stop retrying after the bounded attempt cap", async () => {
    const u = await registerUser(app);
    await registerDevice(u, "tok-temp-fail");
    const nid = (await createNotif(u.userId))!;
    // Keep retrying; it will never succeed (always temp-fail). Bounded at 5.
    for (let i = 0; i < 10; i++) await retryFailedDeliveries();
    const d = await pool.query(
      `SELECT status, attempt_count FROM notification_deliveries WHERE notification_id=$1 AND channel='PUSH'`,
      [nid],
    );
    expect(d.rows[0].status).toBe("FAILED");
    expect(d.rows[0].attempt_count).toBeLessThanOrEqual(5);
    expect(d.rows[0].attempt_count).toBeGreaterThanOrEqual(5);
  });
});

describe("delivery: push preferences + SAFETY bypass", () => {
  it("disabling push for a category suppresses PUSH but keeps the in-app notification", async () => {
    const u = await registerUser(app);
    await registerDevice(u);
    await request(app)
      .put("/api/notifications/preferences")
      .set(...H(u))
      .send({ category: "SYSTEM", pushEnabled: false });
    const nid = await createNotif(u.userId);
    // In-app notification exists.
    expect(nid).toBeTruthy();
    const inApp = await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE id=$1`, [nid]);
    expect(inApp.rows[0].n).toBe(1);
    // But no push was sent / no push delivery row.
    expect(push.sent).toHaveLength(0);
    const d = await pool.query(
      `SELECT count(*)::int AS n FROM notification_deliveries WHERE notification_id=$1 AND channel='PUSH'`,
      [nid],
    );
    expect(d.rows[0].n).toBe(0);
  });

  it("SAFETY push cannot be disabled and is always delivered", async () => {
    const admin = await registerUser(app);
    await setUserRole(admin.userId, "ADMIN");
    const victim = await registerUser(app);
    await registerDevice(victim);
    // Attempt to disable SAFETY push via the API → rejected.
    const res = await request(app)
      .put("/api/notifications/preferences")
      .set(...H(victim))
      .send({ category: "SAFETY", pushEnabled: false });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("CRITICAL_PREFERENCE");
    // Even if a disabled SAFETY push pref is forced directly in the DB...
    await pool.query(
      `INSERT INTO notification_preferences (user_id, category, enabled, push_enabled)
       VALUES ($1,'SAFETY',true,false)`,
      [victim.userId],
    );
    await request(app)
      .post(`/api/admin/users/${victim.userId}/suspend`)
      .set(...H(admin))
      .send({ reason: "x" });
    await settle();
    // ...the SAFETY push is still delivered.
    expect(push.sent.length).toBeGreaterThanOrEqual(1);
    expect(push.sent.some((s) => s.payload.category === "SAFETY")).toBe(true);
  });

  it("disabling in-app (enabled=false) for a non-critical category suppresses the notification entirely", async () => {
    const u = await registerUser(app);
    await registerDevice(u);
    await request(app)
      .put("/api/notifications/preferences")
      .set(...H(u))
      .send({ category: "SYSTEM", enabled: false });
    const r = await service.create({
      userId: u.userId,
      type: NotificationType.SYSTEM,
      title: "x",
    });
    await settle();
    expect(r.created).toBe(false);
    expect(push.sent).toHaveLength(0);
  });
});

describe("delivery: preferences view", () => {
  it("exposes both enabled and pushEnabled per category (defaults true)", async () => {
    const u = await registerUser(app);
    const res = await request(app).get("/api/notifications/preferences").set(...H(u));
    expect(res.status).toBe(200);
    for (const p of res.body.data.preferences) {
      expect(p).toHaveProperty("enabled", true);
      expect(p).toHaveProperty("pushEnabled", true);
    }
  });
});
