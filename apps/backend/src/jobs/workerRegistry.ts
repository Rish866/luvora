import type { Worker } from "./worker";
import { WorkerState, QueuePressureLevel, type WorkerHealth } from "@luvora/shared";
import * as jobRepo from "./jobRepository";
import { config } from "../config";

/**
 * Process-local reference to the embedded worker (if this process runs one), so
 * admin diagnostics can report its health. The API server does NOT require a
 * worker — when none is running, health reports a DISABLED state (the API is
 * still considered healthy) but STILL surfaces queue-pressure signals from the
 * shared database so operators can see the backlog from the API process.
 */
let activeWorker: Worker | null = null;

export function setActiveWorker(worker: Worker | null): void {
  activeWorker = worker;
}

/** Synchronous in-memory health, or null when no embedded worker runs here. */
export function getWorkerHealth(): WorkerHealth | null {
  return activeWorker ? activeWorker.health() : null;
}

/**
 * Full worker health incl. DB-derived queue pressure. When no embedded worker
 * runs in this process, returns a synthetic DISABLED health that still carries
 * the shared queue stats (depth / oldest age / stale / dead / pressure).
 */
export async function getWorkerHealthWithQueue(): Promise<WorkerHealth> {
  if (activeWorker) return activeWorker.healthWithQueue();

  // No embedded worker — synthesize a DISABLED view with queue stats from the DB.
  const base: WorkerHealth = {
    workerId: "none",
    running: false,
    stopping: false,
    concurrency: 0,
    activeJobs: 0,
    lastPollAt: null,
    lastSuccessAt: null,
    lastErrorCode: null,
    state: WorkerState.DISABLED,
    consecutiveErrors: 0,
  };
  try {
    const stats = await jobRepo.queueStats();
    let pressure = QueuePressureLevel.OK;
    if (
      stats.depth >= config.jobs.queueCriticalDepth ||
      (stats.oldestPendingAgeSeconds ?? 0) >= config.jobs.queueMaxAgeSeconds
    ) {
      pressure = QueuePressureLevel.CRITICAL;
    } else if (stats.depth >= config.jobs.queueWarningDepth) {
      pressure = QueuePressureLevel.WARNING;
    }
    return {
      ...base,
      queueDepth: stats.depth,
      oldestPendingAgeSeconds: stats.oldestPendingAgeSeconds,
      staleRunningCount: stats.staleRunning,
      deadJobCount: stats.dead,
      queuePressure: pressure,
    };
  } catch {
    return base;
  }
}
