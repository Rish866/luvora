import type { JobType } from "@luvora/shared";

/**
 * Lightweight in-process job metrics (Increment 9). No external dependency
 * (no Prometheus) — a small counter map plus duration accumulation, snapshot-
 * able for admin diagnostics. Process-local; resets on restart (authoritative
 * state lives in the `background_jobs` table). Never records payloads/secrets.
 */
export type JobCounter =
  | "jobs_enqueued"
  | "jobs_claimed"
  | "jobs_succeeded"
  | "jobs_retried"
  | "jobs_dead"
  | "jobs_cancelled"
  | "jobs_reclaimed";

class JobMetrics {
  private counters = new Map<string, number>();
  private durationTotalMs = new Map<string, number>();
  private durationCount = new Map<string, number>();

  inc(counter: JobCounter, jobType?: JobType, by = 1): void {
    this.counters.set(counter, (this.counters.get(counter) ?? 0) + by);
    if (jobType) {
      const key = `${counter}:${jobType}`;
      this.counters.set(key, (this.counters.get(key) ?? 0) + by);
    }
  }

  observeDuration(jobType: JobType, ms: number): void {
    this.durationTotalMs.set(jobType, (this.durationTotalMs.get(jobType) ?? 0) + ms);
    this.durationCount.set(jobType, (this.durationCount.get(jobType) ?? 0) + 1);
  }

  /** Flat counters snapshot (incl. per-type keys and avg durations). */
  snapshotCounters(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.counters) out[k] = v;
    for (const [type, total] of this.durationTotalMs) {
      const n = this.durationCount.get(type) ?? 0;
      if (n > 0) out[`job_execution_duration_avg_ms:${type}`] = Math.round(total / n);
    }
    return out;
  }

  reset(): void {
    this.counters.clear();
    this.durationTotalMs.clear();
    this.durationCount.clear();
  }
}

export const jobMetrics = new JobMetrics();
