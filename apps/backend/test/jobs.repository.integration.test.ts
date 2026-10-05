import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { closePool, pool, withTransaction } from "../src/db/pool";
import { resetDb } from "./helpers";
import * as jobRepo from "../src/jobs/jobRepository";
import { JobType, JobStatus } from "@luvora/shared";

/**
 * Durable job repository tests against real PostgreSQL (Increment 9): enqueue,
 * idempotency, claim with FOR UPDATE SKIP LOCKED, lease assignment/extension,
 * retry/dead/cancel, and crash-recovery via lease reclaim. Concurrency is
 * exercised with real DB locking (never mocked).
 */

beforeAll(() => {
  /* pool/config loaded on import */
});
beforeEach(async () => {
  await resetDb();
});
afterAll(async () => {
  await closePool();
});

const PUSH = JobType.NOTIFICATION_PUSH_DELIVERY;

describe("jobs: enqueue + idempotency", () => {
  it("enqueues a PENDING job with defaults", async () => {
    const { row, created } = await jobRepo.enqueue({ jobType: PUSH, payload: { notificationId: "n1" } });
    expect(created).toBe(true);
    expect(row.status).toBe(JobStatus.PENDING);
    expect(row.attempt_count).toBe(0);
    expect(row.priority).toBe(100);
    expect(row.max_attempts).toBe(5);
    expect(row.payload).toEqual({ notificationId: "n1" });
  });

  it("respects an explicit priority, maxAttempts, and availableAt", async () => {
    const future = new Date(Date.now() + 60_000);
    const { row } = await jobRepo.enqueue({
      jobType: PUSH,
      payload: {},
      priority: 10,
      maxAttempts: 9,
      availableAt: future,
    });
    expect(row.priority).toBe(10);
    expect(row.max_attempts).toBe(9);
    expect(new Date(row.available_at).getTime()).toBeGreaterThan(Date.now() + 30_000);
  });

  it("a duplicate idempotency key does not create a second live job", async () => {
    const first = await jobRepo.enqueue({ jobType: PUSH, payload: {}, idempotencyKey: "k1" });
    const second = await jobRepo.enqueue({ jobType: PUSH, payload: {}, idempotencyKey: "k1" });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM background_jobs`);
    expect(rows[0].n).toBe(1);
  });

  it("the same idempotency key is allowed across DIFFERENT job types", async () => {
    await jobRepo.enqueue({ jobType: PUSH, payload: {}, idempotencyKey: "shared" });
    const other = await jobRepo.enqueue({
      jobType: JobType.NOTIFICATION_CLEANUP,
      payload: {},
      idempotencyKey: "shared",
    });
    expect(other.created).toBe(true);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM background_jobs`);
    expect(rows[0].n).toBe(2);
  });

  it("NULL idempotency keys may duplicate freely", async () => {
    await jobRepo.enqueue({ jobType: PUSH, payload: {} });
    await jobRepo.enqueue({ jobType: PUSH, payload: {} });
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM background_jobs`);
    expect(rows[0].n).toBe(2);
  });

  it("after a job becomes terminal, the same idempotency key can be re-enqueued", async () => {
    const first = await jobRepo.enqueue({ jobType: PUSH, payload: {}, idempotencyKey: "reuse" });
    // Force it terminal.
    await pool.query(`UPDATE background_jobs SET status='SUCCEEDED', completed_at=now() WHERE id=$1`, [
      first.row.id,
    ]);
    const second = await jobRepo.enqueue({ jobType: PUSH, payload: {}, idempotencyKey: "reuse" });
    expect(second.created).toBe(true);
    expect(second.row.id).not.toBe(first.row.id);
  });

  it("enqueue joins a caller transaction (outbox) and rolls back together", async () => {
    await expect(
      withTransaction(async (client) => {
        await jobRepo.enqueue({ jobType: PUSH, payload: { notificationId: "txn" } }, client);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM background_jobs`);
    expect(rows[0].n).toBe(0); // rolled back with the transaction
  });

  it("rejects an invalid status at the DB layer (CHECK constraint)", async () => {
    await expect(
      pool.query(`INSERT INTO background_jobs (job_type, status, payload) VALUES ('X','BOGUS','{}')`),
    ).rejects.toThrow();
  });
});

describe("jobs: claim with locking", () => {
  it("claims an available job, transitions to RUNNING, assigns a lease + worker + attempt", async () => {
    await jobRepo.enqueue({ jobType: PUSH, payload: {} });
    const claimed = await jobRepo.claimNext("w1", 60);
    expect(claimed).not.toBeNull();
    expect(claimed!.status).toBe(JobStatus.RUNNING);
    expect(claimed!.worker_id).toBe("w1");
    expect(claimed!.attempt_count).toBe(1);
    expect(claimed!.leased_until).not.toBeNull();
  });

  it("does NOT claim a job whose available_at is in the future", async () => {
    await jobRepo.enqueue({ jobType: PUSH, payload: {}, availableAt: new Date(Date.now() + 60_000) });
    const claimed = await jobRepo.claimNext("w1", 60);
    expect(claimed).toBeNull();
  });

  it("claims higher priority (lower number) first", async () => {
    await jobRepo.enqueue({ jobType: PUSH, payload: { tag: "low" }, priority: 500 });
    await jobRepo.enqueue({ jobType: PUSH, payload: { tag: "high" }, priority: 10 });
    const claimed = await jobRepo.claimNext("w1", 60);
    expect(claimed!.payload.tag).toBe("high");
  });

  it("concurrent workers never claim the same job (SKIP LOCKED)", async () => {
    // One job; three workers race. Exactly one gets it.
    await jobRepo.enqueue({ jobType: PUSH, payload: {} });
    const results = await Promise.all([
      jobRepo.claimNext("wa", 60),
      jobRepo.claimNext("wb", 60),
      jobRepo.claimNext("wc", 60),
    ]);
    const claimed = results.filter((r) => r !== null);
    expect(claimed).toHaveLength(1);
  });

  it("three workers draining many jobs each claim a disjoint set", async () => {
    const N = 30;
    for (let i = 0; i < N; i++) await jobRepo.enqueue({ jobType: PUSH, payload: { i } });
    const claimedIds = new Set<string>();
    const workerDrain = async (wid: string) => {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const job = await jobRepo.claimNext(wid, 60);
        if (!job) break;
        expect(claimedIds.has(job.id)).toBe(false); // never double-claimed
        claimedIds.add(job.id);
      }
    };
    await Promise.all([workerDrain("wa"), workerDrain("wb"), workerDrain("wc")]);
    expect(claimedIds.size).toBe(N);
  });
});

describe("jobs: lease + reclaim (crash recovery)", () => {
  it("extends a lease for the owning worker only", async () => {
    await jobRepo.enqueue({ jobType: PUSH, payload: {} });
    const job = await jobRepo.claimNext("w1", 60);
    expect(await jobRepo.extendLease(job!.id, "w1", 120)).toBe(true);
    expect(await jobRepo.extendLease(job!.id, "intruder", 120)).toBe(false);
  });

  it("an expired lease is reclaimable: RUNNING→RETRY_WAIT, attempt_count preserved", async () => {
    await jobRepo.enqueue({ jobType: PUSH, payload: {} });
    const job = await jobRepo.claimNext("w1", 60);
    // Expire the lease (simulate worker crash).
    await pool.query(`UPDATE background_jobs SET leased_until = now() - interval '1 second' WHERE id=$1`, [
      job!.id,
    ]);
    const { reclaimed } = await jobRepo.reclaimExpired();
    expect(reclaimed).toBe(1);
    const after = await jobRepo.getById(job!.id);
    expect(after!.status).toBe(JobStatus.RETRY_WAIT);
    expect(after!.attempt_count).toBe(1); // NOT reset
    expect(after!.worker_id).toBeNull();
  });

  it("CRASH RECOVERY: worker A claims, crashes; worker B reclaims and completes", async () => {
    await jobRepo.enqueue({ jobType: PUSH, payload: {} });
    const a = await jobRepo.claimNext("wA", 60);
    expect(a).not.toBeNull();
    // Worker A "crashes" — lease expires.
    await pool.query(`UPDATE background_jobs SET leased_until = now() - interval '1 second' WHERE id=$1`, [
      a!.id,
    ]);
    // A different worker reclaims then claims it.
    await jobRepo.reclaimExpired();
    const b = await jobRepo.claimNext("wB", 60);
    expect(b).not.toBeNull();
    expect(b!.id).toBe(a!.id);
    expect(b!.worker_id).toBe("wB");
    expect(b!.attempt_count).toBe(2); // second attempt
    // B completes it.
    expect(await jobRepo.markSucceeded(b!.id, "wB")).toBe(true);
    const final = await jobRepo.getById(b!.id);
    expect(final!.status).toBe(JobStatus.SUCCEEDED);
  });

  it("claimNext itself reclaims an expired RUNNING lease", async () => {
    await jobRepo.enqueue({ jobType: PUSH, payload: {} });
    const a = await jobRepo.claimNext("wA", 60);
    await pool.query(`UPDATE background_jobs SET leased_until = now() - interval '1 second' WHERE id=$1`, [
      a!.id,
    ]);
    const b = await jobRepo.claimNext("wB", 60);
    expect(b!.id).toBe(a!.id);
    expect(b!.worker_id).toBe("wB");
  });

  it("reclaim dead-letters a job that already exhausted its attempts", async () => {
    const { row } = await jobRepo.enqueue({ jobType: PUSH, payload: {}, maxAttempts: 1 });
    const a = await jobRepo.claimNext("wA", 60); // attempt 1 of 1
    expect(a!.attempt_count).toBe(1);
    await pool.query(`UPDATE background_jobs SET leased_until = now() - interval '1 second' WHERE id=$1`, [
      row.id,
    ]);
    const { dead } = await jobRepo.reclaimExpired();
    expect(dead).toBe(1);
    const after = await jobRepo.getById(row.id);
    expect(after!.status).toBe(JobStatus.DEAD);
  });

  it("concurrent reclaimers do not double-process the same expired job", async () => {
    // Enqueue + claim all 10 first (so an interleaved claim can't reclaim a
    // not-yet-expired peer), THEN expire every lease at once.
    for (let i = 0; i < 10; i++) {
      await jobRepo.enqueue({ jobType: PUSH, payload: { i } });
    }
    for (let i = 0; i < 10; i++) {
      await jobRepo.claimNext(`w${i}`, 60);
    }
    await pool.query(
      `UPDATE background_jobs SET leased_until = now() - interval '1 second' WHERE status='RUNNING'`,
    );
    const [r1, r2, r3] = await Promise.all([
      jobRepo.reclaimExpired(),
      jobRepo.reclaimExpired(),
      jobRepo.reclaimExpired(),
    ]);
    const totalReclaimed = r1.reclaimed + r2.reclaimed + r3.reclaimed + r1.dead + r2.dead + r3.dead;
    expect(totalReclaimed).toBe(10); // each expired job handled exactly once
  });
});

describe("jobs: success / retry / dead / cancel", () => {
  it("markSucceeded is scoped to the owning worker + RUNNING", async () => {
    await jobRepo.enqueue({ jobType: PUSH, payload: {} });
    const job = await jobRepo.claimNext("w1", 60);
    expect(await jobRepo.markSucceeded(job!.id, "other")).toBe(false); // wrong worker
    expect(await jobRepo.markSucceeded(job!.id, "w1")).toBe(true);
    expect(await jobRepo.markSucceeded(job!.id, "w1")).toBe(false); // no longer RUNNING
  });

  it("scheduleRetry sets RETRY_WAIT with a future availability + sanitized error", async () => {
    await jobRepo.enqueue({ jobType: PUSH, payload: {} });
    const job = await jobRepo.claimNext("w1", 60);
    expect(await jobRepo.scheduleRetry(job!.id, "w1", 5000, "PROVIDER_UNAVAILABLE", "down")).toBe(true);
    const after = await jobRepo.getById(job!.id);
    expect(after!.status).toBe(JobStatus.RETRY_WAIT);
    expect(after!.last_error_code).toBe("PROVIDER_UNAVAILABLE");
    expect(new Date(after!.available_at).getTime()).toBeGreaterThan(Date.now() + 1000);
    expect(after!.worker_id).toBeNull();
  });

  it("markDead is terminal with failed_at + error metadata", async () => {
    await jobRepo.enqueue({ jobType: PUSH, payload: {} });
    const job = await jobRepo.claimNext("w1", 60);
    expect(await jobRepo.markDead(job!.id, "w1", "INVALID_PAYLOAD", "bad")).toBe(true);
    const after = await jobRepo.getById(job!.id);
    expect(after!.status).toBe(JobStatus.DEAD);
    expect(after!.failed_at).not.toBeNull();
    expect(after!.last_error_code).toBe("INVALID_PAYLOAD");
  });

  it("cancel transitions a non-terminal job and is a no-op on terminal jobs", async () => {
    const { row } = await jobRepo.enqueue({ jobType: PUSH, payload: {} });
    expect(await jobRepo.cancel(row.id)).toBe(true);
    expect((await jobRepo.getById(row.id))!.status).toBe(JobStatus.CANCELLED);
    expect(await jobRepo.cancel(row.id)).toBe(false); // already terminal
  });
});

describe("jobs: retention cleanup", () => {
  it("deletes terminal jobs past their retention cutoffs, keeps active + recent", async () => {
    const active = await jobRepo.enqueue({ jobType: PUSH, payload: { k: "active" } });
    const oldSucceeded = await jobRepo.enqueue({ jobType: PUSH, payload: { k: "old-ok" } });
    const oldDead = await jobRepo.enqueue({ jobType: PUSH, payload: { k: "old-dead" } });
    await pool.query(
      `UPDATE background_jobs SET status='SUCCEEDED', completed_at = now() - interval '30 days' WHERE id=$1`,
      [oldSucceeded.row.id],
    );
    await pool.query(
      `UPDATE background_jobs SET status='DEAD', failed_at = now() - interval '60 days' WHERE id=$1`,
      [oldDead.row.id],
    );
    const removed = await jobRepo.deleteTerminalBefore(
      new Date(Date.now() - 7 * 24 * 3600 * 1000),
      new Date(Date.now() - 30 * 24 * 3600 * 1000),
    );
    expect(removed).toBe(2);
    expect(await jobRepo.getById(active.row.id)).not.toBeNull(); // active kept
  });
});
