import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app";
import { closePool, pool } from "../src/db/pool";
import { resetDb, registerUser, setUserRole, auth, type RegisteredUser } from "./helpers";
import * as jobRepo from "../src/jobs/jobRepository";
import { Worker } from "../src/jobs/worker";
import { buildDefaultRegistry } from "../src/jobs/defaultRegistry";
import { setActiveWorker } from "../src/jobs/workerRegistry";
import * as service from "../src/notifications/notificationService";
import { TestPushProvider } from "../src/notifications/push/TestPushProvider";
import { setPushProvider, resetPushProvider } from "../src/notifications/push/pushProviders";
import { JobType, JobStatus, NotificationType } from "@luvora/shared";

/**
 * Admin job operational controls + failure-injection (Increment 10) against
 * real PostgreSQL: retry/cancel/dead-letter diagnostics, worker health + queue
 * pressure, operational-event audit, RBAC/security, and failure recovery.
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
  worker = new Worker({ registry: buildDefaultRegistry(), workerId: "ops-test-worker" });
});
afterEach(() => {
  resetPushProvider();
  setActiveWorker(null);
});
afterAll(async () => {
  await closePool();
});

const H = (u: RegisteredUser) => auth(u.accessToken);
async function admin(): Promise<RegisteredUser> {
  const u = await registerUser(app);
  await setUserRole(u.userId, "ADMIN");
  return u;
}
async function moderator(): Promise<RegisteredUser> {
  const u = await registerUser(app);
  await setUserRole(u.userId, "MODERATOR");
  return u;
}

async function seedJob(status: string, payload: Record<string, unknown> = {}): Promise<string> {
  const { row } = await jobRepo.enqueue({ jobType: JobType.NOTIFICATION_PUSH_DELIVERY, payload });
  await pool.query(`UPDATE background_jobs SET status=$2, failed_at=now() WHERE id=$1`, [row.id, status]);
  return row.id;
}

async function drainJobs(max = 40): Promise<void> {
  for (let i = 0; i < max; i++) {
    await pool.query(`UPDATE background_jobs SET available_at = now() WHERE status='RETRY_WAIT'`);
    if (!(await worker.runOnce())) return;
  }
}

describe("admin: retry (requeue) dead jobs", () => {
  it("requeues a DEAD job back to PENDING, resetting attempts, and audits it", async () => {
    const a = await admin();
    const id = await seedJob("DEAD", { notificationId: "n1" });
    // Bump attempt_count so we can verify reset.
    await pool.query(`UPDATE background_jobs SET attempt_count=5 WHERE id=$1`, [id]);

    const res = await request(app).post(`/api/admin/jobs/${id}/retry`).set(...H(a)).send({ reason: "ops" });
    expect(res.status).toBe(200);
    expect(res.body.data.job.status).toBe("PENDING");
    expect(res.body.data.job.attemptCount).toBe(0);

    const row = await jobRepo.getById(id);
    expect(row!.status).toBe(JobStatus.PENDING);
    expect(row!.attempt_count).toBe(0);

    // Audit record written (action job.requeued), no raw payload.
    const audit = await pool.query(
      `SELECT action, metadata FROM audit_logs WHERE action='job.requeued' AND target_id=$1`,
      [id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(JSON.stringify(audit.rows[0].metadata)).not.toContain("notificationId");
    // Operational event recorded.
    const ev = await pool.query(
      `SELECT count(*)::int AS n FROM operational_events WHERE event_type='JOB_MANUALLY_REQUEUED' AND job_id=$1`,
      [id],
    );
    expect(ev.rows[0].n).toBe(1);
  });

  it("refuses to retry a SUCCEEDED job (JOB_NOT_RETRYABLE)", async () => {
    const a = await admin();
    const id = await seedJob("SUCCEEDED");
    const res = await request(app).post(`/api/admin/jobs/${id}/retry`).set(...H(a));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("JOB_NOT_RETRYABLE");
  });

  it("refuses to retry a RUNNING job", async () => {
    const a = await admin();
    const id = await seedJob("RUNNING");
    const res = await request(app).post(`/api/admin/jobs/${id}/retry`).set(...H(a));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("JOB_NOT_RETRYABLE");
  });

  it("a requeued DEAD job executes again safely via the worker", async () => {
    const a = await admin();
    const u = await registerUser(app);
    await request(app)
      .post("/api/notifications/devices")
      .set(...H(u))
      .send({ platform: "ANDROID", provider: "FCM", token: "ops-ok-token" });
    // Create a real notification + its push job, then force it DEAD.
    const r = await service.create({ userId: u.userId, type: NotificationType.SYSTEM, title: "x" });
    const nid = r.notification!.id;
    const jobRow = await pool.query<{ id: string }>(
      `SELECT id FROM background_jobs WHERE payload->>'notificationId'=$1`,
      [nid],
    );
    await pool.query(`UPDATE background_jobs SET status='DEAD', failed_at=now() WHERE id=$1`, [jobRow.rows[0].id]);

    await request(app).post(`/api/admin/jobs/${jobRow.rows[0].id}/retry`).set(...H(a));
    await drainJobs();
    const after = await jobRepo.getById(jobRow.rows[0].id);
    expect(after!.status).toBe(JobStatus.SUCCEEDED);
    expect(push.sent.length).toBeGreaterThanOrEqual(1);
  });

  it("returns JOB_NOT_FOUND for an unknown job id", async () => {
    const a = await admin();
    const res = await request(app)
      .post("/api/admin/jobs/00000000-0000-0000-0000-000000000000/retry")
      .set(...H(a));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("JOB_NOT_FOUND");
  });
});

describe("admin: cancel jobs", () => {
  it("cancels a PENDING job and audits it", async () => {
    const a = await admin();
    const { row } = await jobRepo.enqueue({ jobType: JobType.NOTIFICATION_CLEANUP, payload: {} });
    const res = await request(app).post(`/api/admin/jobs/${row.id}/cancel`).set(...H(a)).send({ reason: "ops" });
    expect(res.status).toBe(200);
    expect((await jobRepo.getById(row.id))!.status).toBe(JobStatus.CANCELLED);
    const ev = await pool.query(
      `SELECT count(*)::int AS n FROM operational_events WHERE event_type='JOB_CANCELLED' AND job_id=$1`,
      [row.id],
    );
    expect(ev.rows[0].n).toBe(1);
  });

  it("refuses to cancel a RUNNING job (honest semantics)", async () => {
    const a = await admin();
    const id = await seedJob("RUNNING");
    const res = await request(app).post(`/api/admin/jobs/${id}/cancel`).set(...H(a));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("JOB_NOT_CANCELLABLE");
  });

  it("refuses to cancel a terminal job", async () => {
    const a = await admin();
    const id = await seedJob("SUCCEEDED");
    const res = await request(app).post(`/api/admin/jobs/${id}/cancel`).set(...H(a));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("JOB_NOT_CANCELLABLE");
  });
});

describe("admin: dead-letter + worker health + operational events", () => {
  it("lists DEAD jobs via /jobs/dead with redacted payloads", async () => {
    const a = await admin();
    await seedJob("DEAD", { notificationId: "n1", token: "RAW-SECRET" });
    await seedJob("SUCCEEDED");
    const res = await request(app).get("/api/admin/jobs/dead").set(...H(a));
    expect(res.status).toBe(200);
    expect(res.body.data.jobs.every((j: { status: string }) => j.status === "DEAD")).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain("RAW-SECRET");
    expect(res.body.data.jobs[0].payload).toBeUndefined();
  });

  it("worker health reports queue pressure signals even with no embedded worker", async () => {
    const a = await admin();
    // Seed a backlog of claimable jobs.
    for (let i = 0; i < 3; i++) await jobRepo.enqueue({ jobType: JobType.NOTIFICATION_CLEANUP, payload: { i } });
    const res = await request(app).get("/api/admin/jobs/worker").set(...H(a));
    expect(res.status).toBe(200);
    expect(res.body.data.worker.state).toBe("DISABLED");
    expect(res.body.data.worker.queueDepth).toBeGreaterThanOrEqual(3);
    expect(res.body.data.worker).toHaveProperty("queuePressure");
  });

  it("lists operational events (admin only)", async () => {
    const a = await admin();
    const id = await seedJob("DEAD");
    await request(app).post(`/api/admin/jobs/${id}/retry`).set(...H(a));
    const res = await request(app).get("/api/admin/operational-events").set(...H(a));
    expect(res.status).toBe(200);
    expect(res.body.data.events.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data.events.some((e: { eventType: string }) => e.eventType === "JOB_MANUALLY_REQUEUED")).toBe(true);
  });
});

describe("admin: operational endpoint authorization", () => {
  it("a normal user cannot access job operations (403)", async () => {
    const u = await registerUser(app);
    const id = await seedJob("DEAD");
    expect((await request(app).post(`/api/admin/jobs/${id}/retry`).set(...H(u))).status).toBe(403);
    expect((await request(app).post(`/api/admin/jobs/${id}/cancel`).set(...H(u))).status).toBe(403);
    expect((await request(app).get("/api/admin/jobs/dead").set(...H(u))).status).toBe(403);
    expect((await request(app).get("/api/admin/operational-events").set(...H(u))).status).toBe(403);
  });

  it("a MODERATOR cannot access admin job operations", async () => {
    const m = await moderator();
    const id = await seedJob("DEAD");
    expect((await request(app).post(`/api/admin/jobs/${id}/retry`).set(...H(m))).status).toBe(403);
    expect((await request(app).get("/api/admin/operational-events").set(...H(m))).status).toBe(403);
  });

  it("unauthenticated access is rejected (401)", async () => {
    const id = await seedJob("DEAD");
    expect((await request(app).post(`/api/admin/jobs/${id}/retry`)).status).toBe(401);
    expect((await request(app).get("/api/admin/jobs/dead")).status).toBe(401);
  });
});

describe("failure injection", () => {
  it("worker crashes after claiming → lease expires → another worker reclaims → completes", async () => {
    const { row } = await jobRepo.enqueue({ jobType: JobType.NOTIFICATION_CLEANUP, payload: {} });
    // Worker A claims then "crashes" (lease expires).
    const a = await jobRepo.claimNext("crash-A", 60);
    expect(a!.id).toBe(row.id);
    await pool.query(`UPDATE background_jobs SET leased_until = now() - interval '1 second' WHERE id=$1`, [row.id]);
    await jobRepo.reclaimExpired();
    // Worker B (our runOnce) reclaims + completes.
    const didWork = await worker.runOnce();
    expect(didWork).toBe(true);
    expect((await jobRepo.getById(row.id))!.status).toBe(JobStatus.SUCCEEDED);
  });

  it("worker unavailable → notification persists + job queued → worker starts → job completes", async () => {
    const u = await registerUser(app);
    await request(app)
      .post("/api/notifications/devices")
      .set(...H(u))
      .send({ platform: "ANDROID", provider: "FCM", token: "fi-ok-token" });
    // No worker runs yet. Create a notification.
    const r = await service.create({ userId: u.userId, type: NotificationType.SYSTEM, title: "x" });
    const nid = r.notification!.id;
    // Notification persisted + a PENDING push job queued, nothing delivered.
    const job = await pool.query(
      `SELECT status FROM background_jobs WHERE payload->>'notificationId'=$1`,
      [nid],
    );
    expect(job.rows[0].status).toBe("PENDING");
    expect(push.sent).toHaveLength(0);
    // Now the worker runs and completes it.
    await drainJobs();
    expect(push.sent.length).toBeGreaterThanOrEqual(1);
    const after = await pool.query(
      `SELECT status FROM background_jobs WHERE payload->>'notificationId'=$1`,
      [nid],
    );
    expect(after.rows[0].status).toBe("SUCCEEDED");
  });

  it("temporary push failure → job retries → provider recovers → job succeeds", async () => {
    const u = await registerUser(app);
    const dev = await request(app)
      .post("/api/notifications/devices")
      .set(...H(u))
      .send({ platform: "ANDROID", provider: "FCM", token: "tok-temp-fail" });
    const deviceId = dev.body.data.device.id;
    const r = await service.create({ userId: u.userId, type: NotificationType.SYSTEM, title: "x" });
    const nid = r.notification!.id;
    // First run: temporary failure -> RETRY_WAIT.
    await worker.runOnce();
    let job = await pool.query(
      `SELECT status FROM background_jobs WHERE payload->>'notificationId'=$1`,
      [nid],
    );
    expect(job.rows[0].status).toBe("RETRY_WAIT");
    // Provider recovers (fix token), retry succeeds.
    await pool.query(`UPDATE notification_devices SET token='tok-recovered' WHERE id=$1`, [deviceId]);
    await drainJobs();
    job = await pool.query(
      `SELECT status FROM background_jobs WHERE payload->>'notificationId'=$1`,
      [nid],
    );
    expect(job.rows[0].status).toBe("SUCCEEDED");
  });

  it("worker health reflects embedded worker when registered", async () => {
    const a = await admin();
    worker.start();
    setActiveWorker(worker);
    const res = await request(app).get("/api/admin/jobs/worker").set(...H(a));
    expect(res.body.data.worker.workerId).toBe("ops-test-worker");
    expect(["RUNNING", "UNHEALTHY"]).toContain(res.body.data.worker.state);
    await worker.stop();
  });
});
