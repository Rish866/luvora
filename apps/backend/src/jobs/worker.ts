import { randomUUID } from "node:crypto";
import { JobFailureKind, type WorkerHealth } from "@luvora/shared";
import * as jobRepo from "./jobRepository";
import type { JobRegistry } from "./jobRegistry";
import { jobMetrics } from "./jobMetrics";
import { computeBackoffMs, sanitizeErrorCode, sanitizeErrorMessage } from "./jobService";
import type { JobResult } from "./JobHandler";
import { config } from "../config";
import { logger } from "../logger";

/**
 * Durable job worker runtime (Increment 9).
 *
 * Loop: claim up to `concurrency` jobs (each via `FOR UPDATE SKIP LOCKED`),
 * execute their handlers concurrently (bounded), heartbeat leases for in-flight
 * work, record success / schedule retry / dead-letter, and periodically reclaim
 * expired leases from crashed workers. Shuts down gracefully on stop().
 *
 * The worker never holds a DB transaction across handler execution: claim
 * commits first, the handler runs, then the result is recorded in a short write.
 */
export interface WorkerOptions {
  registry: JobRegistry;
  workerId?: string;
  concurrency?: number;
  pollIntervalMs?: number;
  leaseSeconds?: number;
  heartbeatSeconds?: number;
  reclaimIntervalSeconds?: number;
  shutdownGraceMs?: number;
}

interface ActiveJob {
  jobId: string;
  jobType: string;
  heartbeat: NodeJS.Timeout;
  promise: Promise<void>;
}

export class Worker {
  readonly workerId: string;
  private readonly registry: JobRegistry;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly leaseSeconds: number;
  private readonly heartbeatSeconds: number;
  private readonly reclaimIntervalSeconds: number;
  private readonly shutdownGraceMs: number;

  private running = false;
  private stopping = false;
  private loopPromise: Promise<void> | null = null;
  private reclaimTimer: NodeJS.Timeout | null = null;
  private readonly active = new Map<string, ActiveJob>();

  private lastPollAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private lastErrorCode: string | null = null;

  constructor(opts: WorkerOptions) {
    this.registry = opts.registry;
    this.workerId = opts.workerId ?? `worker-${randomUUID()}`;
    this.concurrency = opts.concurrency ?? config.jobs.concurrency;
    this.pollIntervalMs = opts.pollIntervalMs ?? config.jobs.pollIntervalMs;
    this.leaseSeconds = opts.leaseSeconds ?? config.jobs.leaseSeconds;
    this.heartbeatSeconds = opts.heartbeatSeconds ?? config.jobs.leaseHeartbeatSeconds;
    this.reclaimIntervalSeconds =
      opts.reclaimIntervalSeconds ?? config.jobs.reclaimIntervalSeconds;
    this.shutdownGraceMs = opts.shutdownGraceMs ?? config.jobs.shutdownGraceMs;
  }

  /** Start the worker loop + periodic reclaim. Non-blocking. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    logger.info(
      { workerId: this.workerId, concurrency: this.concurrency },
      "worker.started",
    );
    this.reclaimTimer = setInterval(() => {
      void this.runReclaim();
    }, this.reclaimIntervalSeconds * 1000);
    this.reclaimTimer.unref();
    this.loopPromise = this.loop();
  }

  private async runReclaim(): Promise<void> {
    try {
      const { reclaimed, dead } = await jobRepo.reclaimExpired();
      if (reclaimed > 0 || dead > 0) {
        jobMetrics.inc("jobs_reclaimed", undefined, reclaimed);
        logger.info({ workerId: this.workerId, reclaimed, dead }, "job.reclaimed");
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "job reclaim failed");
    }
  }

  private async loop(): Promise<void> {
    while (this.running && !this.stopping) {
      let claimedAny = false;
      try {
        // Fill up to the concurrency limit.
        while (this.active.size < this.concurrency && !this.stopping) {
          const job = await jobRepo.claimNext(this.workerId, this.leaseSeconds);
          this.lastPollAt = Date.now();
          if (!job) break;
          claimedAny = true;
          jobMetrics.inc("jobs_claimed", job.job_type);
          logger.info(
            { workerId: this.workerId, jobId: job.id, jobType: job.job_type, attempt: job.attempt_count },
            "job.claimed",
          );
          this.spawn(job);
        }
      } catch (err) {
        this.lastErrorCode = sanitizeErrorCode((err as Error).message);
        logger.warn({ err: (err as Error).message }, "worker claim loop error");
      }
      // Back off only when there was no work; otherwise loop promptly.
      if (!claimedAny) {
        await this.sleep(this.pollIntervalMs);
      } else {
        await this.sleep(1);
      }
    }
  }

  /** Execute a claimed job: run its handler, heartbeat its lease, record result. */
  private spawn(job: jobRepo.JobRow): void {
    const started = Date.now();
    const correlationId = randomUUID();
    const heartbeat = setInterval(() => {
      void jobRepo.extendLease(job.id, this.workerId, this.leaseSeconds).catch(() => undefined);
    }, this.heartbeatSeconds * 1000);
    heartbeat.unref();

    const run = async (): Promise<void> => {
      let result: JobResult;
      const handler = this.registry.get(job.job_type);
      if (!handler) {
        // No handler registered — permanent (misconfiguration). Dead-letter.
        result = {
          outcome: "failure",
          kind: JobFailureKind.PERMANENT,
          errorCode: "NO_HANDLER",
          errorMessage: `no handler for ${job.job_type}`,
        };
      } else {
        logger.info(
          { workerId: this.workerId, jobId: job.id, jobType: job.job_type, correlationId },
          "job.started",
        );
        try {
          result = await handler.handle(job.payload, {
            jobId: job.id,
            workerId: this.workerId,
            attempt: job.attempt_count,
            correlationId,
          });
        } catch (err) {
          // A thrown handler = unknown error, retryable within the attempt cap.
          result = {
            outcome: "failure",
            kind: JobFailureKind.TEMPORARY,
            errorCode: sanitizeErrorCode((err as Error)?.message),
            errorMessage: sanitizeErrorMessage((err as Error)?.message),
          };
        }
      }
      await this.recordResult(job, result, started);
    };

    const promise = run()
      .catch((err) => {
        logger.error({ err: (err as Error).message, jobId: job.id }, "job record failed");
      })
      .finally(() => {
        clearInterval(heartbeat);
        this.active.delete(job.id);
      });

    this.active.set(job.id, { jobId: job.id, jobType: job.job_type, heartbeat, promise });
  }

  /** Persist the handler outcome: success / retry (backoff) / dead-letter. */
  private async recordResult(
    job: jobRepo.JobRow,
    result: JobResult,
    startedMs: number,
  ): Promise<void> {
    const durationMs = Date.now() - startedMs;
    jobMetrics.observeDuration(job.job_type, durationMs);

    if (result.outcome === "success") {
      const ok = await jobRepo.markSucceeded(job.id, this.workerId);
      if (ok) {
        jobMetrics.inc("jobs_succeeded", job.job_type);
        this.lastSuccessAt = Date.now();
        logger.info(
          { workerId: this.workerId, jobId: job.id, jobType: job.job_type, durationMs },
          "job.succeeded",
        );
      }
      return;
    }

    const errorCode = sanitizeErrorCode(result.errorCode);
    const errorMessage = sanitizeErrorMessage(result.errorMessage);
    this.lastErrorCode = errorCode;

    // Permanent failure OR attempts exhausted → dead-letter.
    const exhausted = job.attempt_count >= job.max_attempts;
    if (result.kind === JobFailureKind.PERMANENT || exhausted) {
      const dead = await jobRepo.markDead(job.id, this.workerId, errorCode, errorMessage);
      if (dead) {
        jobMetrics.inc("jobs_dead", job.job_type);
        logger.warn(
          { workerId: this.workerId, jobId: job.id, jobType: job.job_type, errorCode, attempt: job.attempt_count },
          "job.dead",
        );
      }
      return;
    }

    // Temporary failure with attempts remaining → backoff retry.
    const delayMs = computeBackoffMs(job.attempt_count);
    const scheduled = await jobRepo.scheduleRetry(
      job.id,
      this.workerId,
      delayMs,
      errorCode,
      errorMessage,
    );
    if (scheduled) {
      jobMetrics.inc("jobs_retried", job.job_type);
      logger.info(
        { workerId: this.workerId, jobId: job.id, jobType: job.job_type, errorCode, delayMs, attempt: job.attempt_count },
        "job.retry_scheduled",
      );
    }
  }

  /** Process a single job claim synchronously (used by tests for determinism).
   *  Returns true if a job was claimed+processed. */
  async runOnce(): Promise<boolean> {
    const job = await jobRepo.claimNext(this.workerId, this.leaseSeconds);
    this.lastPollAt = Date.now();
    if (!job) return false;
    jobMetrics.inc("jobs_claimed", job.job_type);
    const started = Date.now();
    const handler = this.registry.get(job.job_type);
    let result: JobResult;
    if (!handler) {
      result = {
        outcome: "failure",
        kind: JobFailureKind.PERMANENT,
        errorCode: "NO_HANDLER",
        errorMessage: `no handler for ${job.job_type}`,
      };
    } else {
      try {
        result = await handler.handle(job.payload, {
          jobId: job.id,
          workerId: this.workerId,
          attempt: job.attempt_count,
          correlationId: randomUUID(),
        });
      } catch (err) {
        result = {
          outcome: "failure",
          kind: JobFailureKind.TEMPORARY,
          errorCode: sanitizeErrorCode((err as Error)?.message),
          errorMessage: sanitizeErrorMessage((err as Error)?.message),
        };
      }
    }
    await this.recordResult(job, result, started);
    return true;
  }

  /**
   * Graceful shutdown: stop claiming new work, stop polling + reclaim, let
   * in-flight jobs finish up to the grace period, then stop lease heartbeats.
   * Jobs still running when the grace expires keep their lease and will be
   * reclaimed by another worker after it lapses — nothing is lost.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.stopping = true;
    logger.info({ workerId: this.workerId, active: this.active.size }, "worker.stopping");
    if (this.reclaimTimer) {
      clearInterval(this.reclaimTimer);
      this.reclaimTimer = null;
    }
    // Wait for the claim loop to exit.
    if (this.loopPromise) await this.loopPromise.catch(() => undefined);

    // Allow in-flight jobs to finish within the grace period.
    if (this.active.size > 0) {
      const inflight = [...this.active.values()].map((a) => a.promise);
      await Promise.race([
        Promise.allSettled(inflight),
        this.sleep(this.shutdownGraceMs),
      ]);
    }
    // Clear any remaining heartbeats; remaining leases will expire → reclaim.
    for (const a of this.active.values()) clearInterval(a.heartbeat);

    this.running = false;
    this.stopping = false;
    logger.info({ workerId: this.workerId }, "worker.stopped");
  }

  health(): WorkerHealth {
    return {
      workerId: this.workerId,
      running: this.running,
      stopping: this.stopping,
      concurrency: this.concurrency,
      activeJobs: this.active.size,
      lastPollAt: this.lastPollAt ? new Date(this.lastPollAt).toISOString() : null,
      lastSuccessAt: this.lastSuccessAt ? new Date(this.lastSuccessAt).toISOString() : null,
      lastErrorCode: this.lastErrorCode,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
