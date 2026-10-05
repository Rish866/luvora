import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app";
import { closePool, pool } from "../src/db/pool";
import {
  resetDb,
  registerUser,
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
import { NotificationType } from "@luvora/shared";
import { toPushPayload } from "../src/notifications/deliveryDispatcher";
import { Worker } from "../src/jobs/worker";
import { buildDefaultRegistry } from "../src/jobs/defaultRegistry";

/**
 * Notification delivery tests (Increment 8 behaviour, now driven by the
 * Increment 9 durable job worker). Verify the push pipeline against a real
 * PostgreSQL: notifications enqueue a durable NOTIFICATION_PUSH_DELIVERY job,
 * the worker performs delivery through the existing (idempotent) delivery
 * pipeline, with retry/revocation, push preferences, SAFETY bypass, and payload
 * privacy preserved.
 */

let app: Express;
let push: TestPushProvider;
let worker: Worker;

beforeAll(() => {
  app = createApp();
});
beforeEach(async () => {
  await resetDb();
  push = new TestPushProvider();
  setPushProvider(push);
  worker = new Worker({ registry: buildDefaultRegistry(), workerId: "delivery-test-worker" });
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

/** Drain all currently-available jobs through the worker (bounded). Makes any
 *  RETRY_WAIT job immediately available first, so backoff delays don't stall a
 *  deterministic test. Returns when no job is claimable. */
async function drainJobs(maxIterations = 50): Promise<void> {
  for (let i = 0; i < maxIterations; i++) {
    // Make backed-off retries immediately claimable for determinism.
    await pool.query(
      `UPDATE background_jobs SET available_at = now() WHERE status = 'RETRY_WAIT'`,
    );
    const didWork = await worker.runOnce();
    if (!didWork) return;
  }
}

/** Create a notification via the service (enqueues a durable job), then drain
 *  the queue so the push actually executes. Returns the notification id. */
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
  await drainJobs();
  return r.notification?.id ?? null;
}

describe("delivery: push pipeline (via durable job)", () => {
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
    // The durable job reached SUCCEEDED.
    const job = await pool.query(
      `SELECT status FROM background_jobs WHERE job_type='NOTIFICATION_PUSH_DELIVERY'
        AND payload->>'notificationId' = $1`,
      [nid],
    );
    expect(job.rows[0].status).toBe("SUCCEEDED");
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
    const r = await service.create({
      userId: u.userId,
      type: NotificationType.SYSTEM,
      title: "secret-title",
      body: "secret-body-text",
      entityType: "system",
      entityId: null,
    });
    void r;
    await drainJobs();
    expect(push.sent).toHaveLength(1);
    const payloadStr = JSON.stringify(push.sent[0].payload);
    expect(payloadStr).not.toContain("secret-title");
    expect(payloadStr).not.toContain("secret-body-text");
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

describe("delivery: idempotency", () => {
  it("running the delivery job twice does not duplicate push rows or re-send", async () => {
    const u = await registerUser(app);
    await registerDevice(u);
    const nid = (await createNotif(u.userId))!;
    expect(push.sent).toHaveLength(1);
    // Re-run the same delivery job logic (simulating an at-least-once replay).
    const { deliverPushForNotificationId } = await import(
      "../src/notifications/deliveryDispatcher"
    );
    await deliverPushForNotificationId(nid);
    await deliverPushForNotificationId(nid);
    // Still exactly one delivery row; no additional send (already DELIVERED).
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM notification_deliveries WHERE notification_id=$1 AND channel='PUSH'`,
      [nid],
    );
    expect(rows[0].n).toBe(1);
    expect(push.sent).toHaveLength(1);
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

describe("delivery: failures, retry, revocation (via job worker)", () => {
  it("a permanent failure (invalid token) revokes the device and the job succeeds (nothing to retry)", async () => {
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
    // The job itself is terminal SUCCEEDED (a permanent device failure is not a
    // retryable JOB failure — there is nothing left to deliver).
    const job = await pool.query(
      `SELECT status FROM background_jobs WHERE payload->>'notificationId' = $1`,
      [nid],
    );
    expect(job.rows[0].status).toBe("SUCCEEDED");
  });

  it("a temporary provider failure schedules a job retry and eventually succeeds", async () => {
    const u = await registerUser(app);
    const deviceId = await registerDevice(u, "tok-temp-fail"); // TEMPORARY
    const r = await service.create({
      userId: u.userId,
      type: NotificationType.SYSTEM,
      title: "x",
      entityType: "system",
      entityId: null,
    });
    const nid = r.notification!.id;

    // Process the job once: the temp failure must schedule a RETRY_WAIT job.
    await worker.runOnce();
    let job = await pool.query(
      `SELECT status, attempt_count FROM background_jobs WHERE payload->>'notificationId' = $1`,
      [nid],
    );
    expect(job.rows[0].status).toBe("RETRY_WAIT");
    expect(job.rows[0].attempt_count).toBe(1);
    const del = await pool.query(
      `SELECT status FROM notification_deliveries WHERE notification_id=$1 AND channel='PUSH'`,
      [nid],
    );
    expect(del.rows[0].status).toBe("FAILED");

    // "Fix" the token, make the retry available, and drain — delivery succeeds.
    await pool.query(`UPDATE notification_devices SET token='tok-now-ok' WHERE id=$1`, [deviceId]);
    await drainJobs();
    job = await pool.query(
      `SELECT status FROM background_jobs WHERE payload->>'notificationId' = $1`,
      [nid],
    );
    expect(job.rows[0].status).toBe("SUCCEEDED");
    const del2 = await pool.query(
      `SELECT status FROM notification_deliveries WHERE notification_id=$1 AND channel='PUSH'`,
      [nid],
    );
    expect(del2.rows[0].status).toBe("DELIVERED");
  });

  it("a permanently-temp-failing delivery dead-letters the job after max attempts", async () => {
    const u = await registerUser(app);
    await registerDevice(u, "tok-temp-fail"); // always TEMPORARY
    const r = await service.create({
      userId: u.userId,
      type: NotificationType.SYSTEM,
      title: "x",
      entityType: "system",
      entityId: null,
    });
    const nid = r.notification!.id;
    // Drain repeatedly; the job keeps failing temporarily and is bounded at 5.
    await drainJobs(30);
    const job = await pool.query(
      `SELECT status, attempt_count, max_attempts FROM background_jobs WHERE payload->>'notificationId' = $1`,
      [nid],
    );
    expect(job.rows[0].status).toBe("DEAD");
    expect(job.rows[0].attempt_count).toBe(job.rows[0].max_attempts);
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
    expect(nid).toBeTruthy();
    const inApp = await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE id=$1`, [nid]);
    expect(inApp.rows[0].n).toBe(1);
    // No push sent and no PUSH delivery row (the job skipped it by preference).
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
    // Force a disabled SAFETY push pref directly in the DB...
    await pool.query(
      `INSERT INTO notification_preferences (user_id, category, enabled, push_enabled)
       VALUES ($1,'SAFETY',true,false)`,
      [victim.userId],
    );
    await request(app)
      .post(`/api/admin/users/${victim.userId}/suspend`)
      .set(...H(admin))
      .send({ reason: "x" });
    // Drain the enqueued SAFETY delivery job.
    await drainJobs();
    // ...the SAFETY push is still delivered (bypasses the push preference).
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
    await drainJobs();
    expect(r.created).toBe(false);
    expect(push.sent).toHaveLength(0);
    // No delivery job was enqueued either (notification was never created).
    const jobs = await pool.query(
      `SELECT count(*)::int AS n FROM background_jobs WHERE job_type='NOTIFICATION_PUSH_DELIVERY'`,
    );
    expect(jobs.rows[0].n).toBe(0);
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
