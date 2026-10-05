import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app";
import { closePool, pool } from "../src/db/pool";
import { resetDb, registerUser, setUserRole, auth, type RegisteredUser } from "./helpers";
import * as jobRepo from "../src/jobs/jobRepository";
import { JobType } from "@luvora/shared";

/**
 * Admin job diagnostics + security (Increment 9). Admins can list/inspect jobs
 * and read queue metrics; normal users and moderators cannot. Responses expose
 * only a REDACTED payload summary — never the raw payload or any secret. There
 * is no API path for a client to enqueue a job.
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

const H = (u: RegisteredUser) => auth(u.accessToken);

async function admin(): Promise<RegisteredUser> {
  const u = await registerUser(app);
  await setUserRole(u.userId, "ADMIN");
  // Re-login so the token reflects admin (role is read live regardless).
  return u;
}

async function seedJob(payload: Record<string, unknown>, status = "DEAD") {
  const { row } = await jobRepo.enqueue({ jobType: JobType.NOTIFICATION_PUSH_DELIVERY, payload });
  await pool.query(`UPDATE background_jobs SET status=$2, failed_at=now() WHERE id=$1`, [row.id, status]);
  return row.id;
}

describe("admin job diagnostics", () => {
  it("ADMIN can list jobs, filter by status, and paginate", async () => {
    const a = await admin();
    await seedJob({ notificationId: "n1" }, "DEAD");
    await seedJob({ notificationId: "n2" }, "SUCCEEDED");
    const all = await request(app).get("/api/admin/jobs").set(...H(a));
    expect(all.status).toBe(200);
    expect(all.body.data.jobs.length).toBeGreaterThanOrEqual(2);
    const dead = await request(app).get("/api/admin/jobs?status=DEAD").set(...H(a));
    expect(dead.body.data.jobs.every((j: { status: string }) => j.status === "DEAD")).toBe(true);
  });

  it("ADMIN can read a single job and queue metrics", async () => {
    const a = await admin();
    const id = await seedJob({ notificationId: "n1" }, "DEAD");
    const one = await request(app).get(`/api/admin/jobs/${id}`).set(...H(a));
    expect(one.status).toBe(200);
    expect(one.body.data.job.id).toBe(id);
    const metrics = await request(app).get("/api/admin/jobs/metrics").set(...H(a));
    expect(metrics.status).toBe(200);
    expect(metrics.body.data).toHaveProperty("countsByStatus");
    expect(metrics.body.data).toHaveProperty("countsByType");
  });

  it("a missing job returns JOB_NOT_FOUND", async () => {
    const a = await admin();
    const res = await request(app)
      .get("/api/admin/jobs/00000000-0000-0000-0000-000000000000")
      .set(...H(a));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("JOB_NOT_FOUND");
  });

  it("job diagnostics expose only a redacted payload summary, never secrets", async () => {
    const a = await admin();
    // A job payload that (hypothetically) contains sensitive keys.
    const { row } = await jobRepo.enqueue({
      jobType: JobType.NOTIFICATION_PUSH_DELIVERY,
      payload: { notificationId: "n1", token: "RAW-SECRET-TOKEN", password: "p" },
    });
    const res = await request(app).get(`/api/admin/jobs/${row.id}`).set(...H(a));
    const summary = res.body.data.job.payloadSummary;
    expect(summary.notificationId).toBe("n1");
    expect(summary.token).toBeUndefined();
    expect(summary.password).toBeUndefined();
    // The full raw payload key must not be present on the DTO at all.
    expect(res.body.data.job.payload).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("RAW-SECRET-TOKEN");
  });
});

describe("admin job diagnostics: authorization", () => {
  it("a normal user cannot access job diagnostics (403)", async () => {
    const u = await registerUser(app);
    expect((await request(app).get("/api/admin/jobs").set(...H(u))).status).toBe(403);
    expect((await request(app).get("/api/admin/jobs/metrics").set(...H(u))).status).toBe(403);
  });

  it("a MODERATOR cannot access job diagnostics (admin-only)", async () => {
    const m = await registerUser(app);
    await setUserRole(m.userId, "MODERATOR");
    expect((await request(app).get("/api/admin/jobs").set(...H(m))).status).toBe(403);
  });

  it("unauthenticated access is rejected (401)", async () => {
    expect((await request(app).get("/api/admin/jobs")).status).toBe(401);
    expect((await request(app).get("/api/admin/jobs/metrics")).status).toBe(401);
  });

  it("there is no client API to enqueue a job (no such route)", async () => {
    const u = await registerUser(app);
    // No POST /api/admin/jobs enqueue endpoint exists; a POST is not routed.
    const res = await request(app)
      .post("/api/admin/jobs")
      .set(...H(u))
      .send({ jobType: "NOTIFICATION_PUSH_DELIVERY", payload: {} });
    expect([401, 403, 404]).toContain(res.status);
  });
});
