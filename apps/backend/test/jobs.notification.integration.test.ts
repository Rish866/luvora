import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app";
import { closePool, pool } from "../src/db/pool";
import { resetDb, registerUser, createMatch, setUserRole, auth, type RegisteredUser } from "./helpers";
import { TestPushProvider } from "../src/notifications/push/TestPushProvider";
import { setPushProvider, resetPushProvider } from "../src/notifications/push/pushProviders";
import * as service from "../src/notifications/notificationService";
import { NotificationType } from "@luvora/shared";
import { Worker } from "../src/jobs/worker";
import { buildDefaultRegistry } from "../src/jobs/defaultRegistry";

/**
 * Notification → durable job integration (Increment 9). Verifies the outbox:
 * a notification INSERT and its push-delivery job commit atomically, and the
 * worker later performs delivery. Also covers idempotency, SAFETY priority, and
 * that the notification API never fails because the provider is unavailable.
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
  worker = new Worker({ registry: buildDefaultRegistry(), workerId: "notif-job-worker" });
});
afterEach(() => {
  resetPushProvider();
});
afterAll(async () => {
  await closePool();
});

const H = (u: RegisteredUser) => auth(u.accessToken);

async function drainJobs(max = 40): Promise<void> {
  for (let i = 0; i < max; i++) {
    await pool.query(`UPDATE background_jobs SET available_at = now() WHERE status='RETRY_WAIT'`);
    if (!(await worker.runOnce())) return;
  }
}

async function pushJobFor(notificationId: string) {
  const { rows } = await pool.query(
    `SELECT * FROM background_jobs WHERE job_type='NOTIFICATION_PUSH_DELIVERY'
       AND payload->>'notificationId' = $1`,
    [notificationId],
  );
  return rows[0] ?? null;
}

describe("notification outbox: atomic enqueue", () => {
  it("creating a notification atomically enqueues exactly one delivery job", async () => {
    const u = await registerUser(app);
    const r = await service.create({
      userId: u.userId,
      type: NotificationType.SYSTEM,
      title: "hi",
      entityType: "system",
      entityId: null,
    });
    const nid = r.notification!.id;
    const job = await pushJobFor(nid);
    expect(job).not.toBeNull();
    expect(job.status).toBe("PENDING");
    // Notification + its job both committed.
    const n = await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE id=$1`, [nid]);
    expect(n.rows[0].n).toBe(1);
  });

  it("a deduped (duplicate) notification does NOT enqueue a second job", async () => {
    const u = await registerUser(app);
    const dedupeKey = "evt:1";
    await service.create({ userId: u.userId, type: NotificationType.SYSTEM, title: "x", dedupeKey });
    await service.create({ userId: u.userId, type: NotificationType.SYSTEM, title: "x", dedupeKey });
    const jobs = await pool.query(
      `SELECT count(*)::int AS n FROM background_jobs WHERE job_type='NOTIFICATION_PUSH_DELIVERY'`,
    );
    expect(jobs.rows[0].n).toBe(1);
  });

  it("a suppressed-by-preference notification enqueues NO job (nothing created)", async () => {
    const u = await registerUser(app);
    await request(app)
      .put("/api/notifications/preferences")
      .set(...H(u))
      .send({ category: "SYSTEM", enabled: false });
    const r = await service.create({ userId: u.userId, type: NotificationType.SYSTEM, title: "x" });
    expect(r.created).toBe(false);
    const jobs = await pool.query(`SELECT count(*)::int AS n FROM background_jobs`);
    expect(jobs.rows[0].n).toBe(0);
  });

  it("SAFETY delivery jobs are enqueued at high priority", async () => {
    const admin = await registerUser(app);
    await setUserRole(admin.userId, "ADMIN");
    const victim = await registerUser(app);
    await request(app)
      .post(`/api/admin/users/${victim.userId}/suspend`)
      .set(...H(admin))
      .send({ reason: "x" });
    const { rows } = await pool.query(
      `SELECT priority FROM background_jobs
        WHERE job_type='NOTIFICATION_PUSH_DELIVERY'`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].priority).toBe(10); // JobPriority.HIGH
  });
});

describe("notification outbox: worker-driven delivery", () => {
  it("the worker delivers the push and marks both the delivery row and job terminal", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    const matchId = await createMatch(a.userId, b.userId);
    await request(app)
      .post("/api/notifications/devices")
      .set(...H(b))
      .send({ platform: "ANDROID", provider: "FCM", token: "ok-token-1" });

    await request(app)
      .post(`/api/matches/${matchId}/messages`)
      .set(...H(a))
      .send({ body: "private body text" });

    // Before the worker runs: a PENDING job exists, no push sent yet.
    const bNotif = await pool.query(
      `SELECT id FROM notifications WHERE user_id=$1 AND type='MESSAGE_RECEIVED'`,
      [b.userId],
    );
    const nid = bNotif.rows[0].id;
    expect((await pushJobFor(nid)).status).toBe("PENDING");
    expect(push.sent).toHaveLength(0);

    await drainJobs();

    // After the worker: push delivered, job SUCCEEDED, no body leak in payload.
    expect(push.sent.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(push.sent.map((s) => s.payload))).not.toContain("private body text");
    expect((await pushJobFor(nid)).status).toBe("SUCCEEDED");
    const del = await pool.query(
      `SELECT status FROM notification_deliveries WHERE notification_id=$1 AND channel='PUSH'`,
      [nid],
    );
    expect(del.rows[0].status).toBe("DELIVERED");
  });

  it("the notification API succeeds even when the push provider is unavailable", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    const matchId = await createMatch(a.userId, b.userId);
    await request(app)
      .post("/api/notifications/devices")
      .set(...H(b))
      .send({ platform: "ANDROID", provider: "FCM", token: "tok-temp-fail" }); // provider temp-fails

    // Sending the message (which creates the notification) still returns 201.
    const res = await request(app)
      .post(`/api/matches/${matchId}/messages`)
      .set(...H(a))
      .send({ body: "hello" });
    expect(res.status).toBe(201);

    // The job will temp-fail and be scheduled for retry — but the API never saw it.
    await worker.runOnce();
    const bNotif = await pool.query(
      `SELECT id FROM notifications WHERE user_id=$1 AND type='MESSAGE_RECEIVED'`,
      [b.userId],
    );
    const job = await pushJobFor(bNotif.rows[0].id);
    expect(job.status).toBe("RETRY_WAIT");
  });

  it("an invalid-token device is revoked by the delivery job (permanent failure)", async () => {
    const u = await registerUser(app);
    await request(app)
      .post("/api/notifications/devices")
      .set(...H(u))
      .send({ platform: "IOS", provider: "APNS", token: "tok-invalid-token" });
    const r = await service.create({ userId: u.userId, type: NotificationType.SYSTEM, title: "x" });
    await drainJobs();
    const dev = await pool.query(`SELECT revoked_at FROM notification_devices WHERE user_id=$1`, [u.userId]);
    expect(dev.rows[0].revoked_at).not.toBeNull();
    // The job is terminal SUCCEEDED (permanent device failure is not a job retry).
    expect((await pushJobFor(r.notification!.id)).status).toBe("SUCCEEDED");
  });

  it("running the SAME delivery job twice does not double-send (idempotent)", async () => {
    const u = await registerUser(app);
    await request(app)
      .post("/api/notifications/devices")
      .set(...H(u))
      .send({ platform: "ANDROID", provider: "FCM", token: "ok-dup-1" });
    const r = await service.create({ userId: u.userId, type: NotificationType.SYSTEM, title: "x" });
    const nid = r.notification!.id;
    const { deliverPushForNotificationId } = await import(
      "../src/notifications/deliveryDispatcher"
    );
    await deliverPushForNotificationId(nid);
    await deliverPushForNotificationId(nid); // replay (crash-after-send scenario)
    const del = await pool.query(
      `SELECT count(*)::int AS n FROM notification_deliveries WHERE notification_id=$1 AND channel='PUSH'`,
      [nid],
    );
    expect(del.rows[0].n).toBe(1);
    expect(push.sent).toHaveLength(1); // existing delivery row prevents re-send
  });
});
