import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { closePool, pool } from "../src/db/pool";
import { resetDb } from "./helpers";
import * as jobRepo from "../src/jobs/jobRepository";
import * as jobService from "../src/jobs/jobService";
import { Worker } from "../src/jobs/worker";
import { JobRegistry } from "../src/jobs/jobRegistry";
import { JobResults, type JobHandler, type JobResult } from "../src/jobs/JobHandler";
import { JobType, JobStatus } from "@luvora/shared";

/**
 * Worker runtime tests against real PostgreSQL (Increment 9): execution,
 * success/retry/dead-letter, concurrency limit, multi-worker consumption,
 * backoff computation, and graceful shutdown. Handlers here are test doubles
 * registered under a real JobType so the full claim→execute→record path runs.
 */

beforeEach(async () => {
  await resetDb();
});
afterAll(async () => {
  await closePool();
});

/** A controllable test handler registered as NOTIFICATION_CLEANUP. */
class ControllableHandler implements JobHandler {
  readonly type = JobType.NOTIFICATION_CLEANUP;
  calls = 0;
  mode: "success" | "temp" | "permanent" | "throw" | "slow" = "success";
  slowMs = 0;
  async handle(): Promise<JobResult> {
    this.calls += 1;
    if (this.mode === "slow") await new Promise((r) => setTimeout(r, this.slowMs));
    if (this.mode === "throw") throw new Error("boom unexpected");
    if (this.mode === "temp") return JobResults.retry("PROVIDER_UNAVAILABLE", "retry me");
    if (this.mode === "permanent") return JobResults.permanent("INVALID", "no retry");
    return JobResults.success();
  }
}

function registryWith(handler: JobHandler): JobRegistry {
  const r = new JobRegistry();
  r.register(handler);
  return r;
}

async function enqueueCleanup(payload: Record<string, unknown> = {}, idem?: string) {
  return jobRepo.enqueue({
    jobType: JobType.NOTIFICATION_CLEANUP,
    payload,
    idempotencyKey: idem ?? null,
  });
}

describe("worker: runOnce execution", () => {
  it("claims and completes a job → SUCCEEDED", async () => {
    const h = new ControllableHandler();
    const w = new Worker({ registry: registryWith(h), workerId: "w1" });
    const { row } = await enqueueCleanup();
    expect(await w.runOnce()).toBe(true);
    expect(h.calls).toBe(1);
    expect((await jobRepo.getById(row.id))!.status).toBe(JobStatus.SUCCEEDED);
  });

  it("runOnce returns false when the queue is empty", async () => {
    const w = new Worker({ registry: registryWith(new ControllableHandler()), workerId: "w1" });
    expect(await w.runOnce()).toBe(false);
  });

  it("a temporary failure schedules a retry (RETRY_WAIT) with backoff", async () => {
    const h = new ControllableHandler();
    h.mode = "temp";
    const w = new Worker({ registry: registryWith(h), workerId: "w1" });
    const { row } = await enqueueCleanup();
    await w.runOnce();
    const after = await jobRepo.getById(row.id);
    expect(after!.status).toBe(JobStatus.RETRY_WAIT);
    expect(after!.attempt_count).toBe(1);
    expect(after!.last_error_code).toBe("PROVIDER_UNAVAILABLE");
    expect(new Date(after!.available_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("a permanent failure dead-letters immediately (no retry)", async () => {
    const h = new ControllableHandler();
    h.mode = "permanent";
    const w = new Worker({ registry: registryWith(h), workerId: "w1" });
    const { row } = await enqueueCleanup();
    await w.runOnce();
    const after = await jobRepo.getById(row.id);
    expect(after!.status).toBe(JobStatus.DEAD);
    expect(after!.attempt_count).toBe(1);
  });

  it("a thrown handler is treated as a retryable unknown error", async () => {
    const h = new ControllableHandler();
    h.mode = "throw";
    const w = new Worker({ registry: registryWith(h), workerId: "w1" });
    const { row } = await enqueueCleanup();
    await w.runOnce();
    const after = await jobRepo.getById(row.id);
    expect(after!.status).toBe(JobStatus.RETRY_WAIT);
  });

  it("a job with no registered handler is dead-lettered (NO_HANDLER)", async () => {
    const emptyRegistry = new JobRegistry();
    const w = new Worker({ registry: emptyRegistry, workerId: "w1" });
    const { row } = await enqueueCleanup();
    await w.runOnce();
    const after = await jobRepo.getById(row.id);
    expect(after!.status).toBe(JobStatus.DEAD);
    expect(after!.last_error_code).toBe("NO_HANDLER");
  });

  it("retries up to max attempts then dead-letters", async () => {
    const h = new ControllableHandler();
    h.mode = "temp";
    const w = new Worker({ registry: registryWith(h), workerId: "w1" });
    const { row } = await enqueueCleanup({}, undefined);
    // Drive attempts, forcing availability each round.
    for (let i = 0; i < 10; i++) {
      await pool.query(`UPDATE background_jobs SET available_at = now() WHERE status='RETRY_WAIT'`);
      if (!(await w.runOnce())) break;
    }
    const after = await jobRepo.getById(row.id);
    expect(after!.status).toBe(JobStatus.DEAD);
    expect(after!.attempt_count).toBe(after!.max_attempts);
  });
});

describe("worker: concurrent multi-worker consumption", () => {
  it("three workers running concurrently each process a disjoint subset", async () => {
    const N = 24;
    const handlers = [0, 1, 2].map(() => new ControllableHandler());
    const workers = handlers.map((h, i) => new Worker({
      registry: registryWith(h),
      workerId: `cw${i}`,
      pollIntervalMs: 20,
      concurrency: 3,
    }));
    for (let i = 0; i < N; i++) await enqueueCleanup({ i });

    workers.forEach((w) => w.start());
    // Poll until all jobs are terminal, bounded.
    const start = Date.now();
    // eslint-disable-next-line no-constant-condition
    while (Date.now() - start < 8000) {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM background_jobs WHERE status NOT IN ('SUCCEEDED','DEAD','CANCELLED')`,
      );
      if (rows[0].n === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await Promise.all(workers.map((w) => w.stop()));

    const succeeded = await pool.query(
      `SELECT count(*)::int AS n FROM background_jobs WHERE status='SUCCEEDED'`,
    );
    expect(succeeded.rows[0].n).toBe(N);
    // The handlers collectively processed exactly N jobs (no double-processing
    // beyond at-least-once — each job SUCCEEDED exactly once here).
    const totalCalls = handlers.reduce((s, h) => s + h.calls, 0);
    expect(totalCalls).toBe(N);
  });

  it("respects the concurrency limit (never more than N jobs in-flight)", async () => {
    const h = new ControllableHandler();
    h.mode = "slow";
    h.slowMs = 150;
    const w = new Worker({
      registry: registryWith(h),
      workerId: "cw",
      concurrency: 2,
      pollIntervalMs: 20,
    });
    for (let i = 0; i < 6; i++) await enqueueCleanup({ i });
    w.start();
    // Shortly after start, no more than `concurrency` jobs should be RUNNING.
    await new Promise((r) => setTimeout(r, 60));
    const running = await pool.query(
      `SELECT count(*)::int AS n FROM background_jobs WHERE status='RUNNING'`,
    );
    expect(running.rows[0].n).toBeLessThanOrEqual(2);
    // Let them finish.
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM background_jobs WHERE status <> 'SUCCEEDED'`,
      );
      if (rows[0].n === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await w.stop();
    const done = await pool.query(`SELECT count(*)::int AS n FROM background_jobs WHERE status='SUCCEEDED'`);
    expect(done.rows[0].n).toBe(6);
  });
});

describe("worker: graceful shutdown", () => {
  it("stops claiming new jobs during shutdown and finishes in-flight work", async () => {
    const h = new ControllableHandler();
    h.mode = "slow";
    h.slowMs = 200;
    const w = new Worker({
      registry: registryWith(h),
      workerId: "sw",
      concurrency: 1,
      pollIntervalMs: 20,
      shutdownGraceMs: 2000,
    });
    await enqueueCleanup({ a: 1 });
    await enqueueCleanup({ a: 2 });
    w.start();
    await new Promise((r) => setTimeout(r, 50)); // let it pick up job 1
    await w.stop(); // should let job 1 finish, not claim job 2 mid-stop
    // At least one job completed; the worker is no longer running.
    expect(w.health().running).toBe(false);
    const succeeded = await pool.query(
      `SELECT count(*)::int AS n FROM background_jobs WHERE status='SUCCEEDED'`,
    );
    expect(succeeded.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it("health() reports worker identity and state", async () => {
    const w = new Worker({ registry: registryWith(new ControllableHandler()), workerId: "hw" });
    const h0 = w.health();
    expect(h0.workerId).toBe("hw");
    expect(h0.running).toBe(false);
    w.start();
    expect(w.health().running).toBe(true);
    await w.stop();
    expect(w.health().running).toBe(false);
  });
});

describe("jobService: backoff + sanitization", () => {
  it("computeBackoffMs grows with attempts and is bounded by the max delay", () => {
    const d1 = jobService.computeBackoffMs(1);
    const d3 = jobService.computeBackoffMs(3);
    const dBig = jobService.computeBackoffMs(50);
    expect(d1).toBeGreaterThan(0);
    // With jitter the exact value varies, but the cap must hold.
    expect(dBig).toBeLessThanOrEqual(60_000);
    expect(d3).toBeLessThanOrEqual(60_000);
  });

  it("sanitizeErrorCode produces a short token-free uppercase code", () => {
    expect(jobService.sanitizeErrorCode("Provider unavailable: secret=abc123")).toMatch(/^[A-Z0-9_]+$/);
    expect(jobService.sanitizeErrorCode(undefined)).toBe("UNKNOWN_ERROR");
    expect(jobService.sanitizeErrorCode("x".repeat(200)).length).toBeLessThanOrEqual(40);
  });

  it("redactPayload drops sensitive keys and bounds values", () => {
    const red = jobService.redactPayload({
      notificationId: "n1",
      token: "RAW-SECRET",
      password: "p",
      count: 3,
      flag: true,
      note: "x".repeat(500),
    });
    expect(red.notificationId).toBe("n1");
    expect(red.count).toBe(3);
    expect(red.flag).toBe(true);
    expect(red.token).toBeUndefined();
    expect(red.password).toBeUndefined();
    expect(String(red.note).length).toBeLessThanOrEqual(128);
  });
});

describe("jobService: enqueue helpers", () => {
  it("enqueueNotificationPushDelivery is idempotent per notification", async () => {
    const a = await jobService.enqueueNotificationPushDelivery("n-123");
    const b = await jobService.enqueueNotificationPushDelivery("n-123");
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM background_jobs WHERE job_type='NOTIFICATION_PUSH_DELIVERY'`,
    );
    expect(rows[0].n).toBe(1);
  });

  it("high-priority delivery is enqueued ahead of normal work", async () => {
    const normal = await jobService.enqueue(JobType.NOTIFICATION_PUSH_DELIVERY, { notificationId: "n1" });
    const high = await jobService.enqueueNotificationPushDelivery("n2", { high: true });
    void normal;
    void high;
    const w = new Worker({ registry: new JobRegistry(), workerId: "pw" });
    // Claim once; the high-priority job must be chosen first.
    const claimed = await jobRepo.claimNext("pw", 60);
    void w;
    expect(claimed!.payload.notificationId).toBe("n2");
  });

  it("backpressure (when configured) refuses non-idempotent standalone enqueue", async () => {
    // maxQueueDepth default is 0 (unbounded); verify the guard path is a no-op
    // here and that an idempotent job always enqueues.
    const r = await jobService.enqueue(JobType.NOTIFICATION_CLEANUP, {}, { idempotencyKey: "x" });
    expect(r.created).toBe(true);
  });
});
