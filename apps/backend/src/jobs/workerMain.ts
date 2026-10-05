import { JobType } from "@luvora/shared";
import { Worker } from "./worker";
import { buildDefaultRegistry } from "./defaultRegistry";
import { enqueueMaintenance } from "./jobService";
import { config } from "../config";
import { logger } from "../logger";
import { closePool } from "../db/pool";
import { initPresence } from "../presence/presenceService";

/**
 * Standalone worker entrypoint (`npm run worker`). Runs independently of the API
 * server. Starts the durable job worker and a lightweight scheduler that
 * periodically enqueues the maintenance jobs (cleanup / presence reconciliation
 * / job retention) using idempotency keys so duplicates collapse to one job.
 *
 * The API server does NOT need this process; the queue persists in PostgreSQL.
 */

// Interval between maintenance enqueues (ms). Modest; the jobs themselves are
// idempotent and cheap. Kept internal (not a hot config knob).
const MAINTENANCE_INTERVAL_MS = 60_000;

export function startWorkerProcess(): { worker: Worker; stop: () => Promise<void> } {
  // The presence reconciliation handler reaps the in-process registry; wire the
  // transition listener so reaped users get last-seen + presence.changed.
  initPresence();

  const registry = buildDefaultRegistry();
  const worker = new Worker({ registry });
  worker.start();

  const scheduleMaintenance = async () => {
    for (const type of [
      JobType.NOTIFICATION_CLEANUP,
      JobType.PRESENCE_RECONCILIATION,
      JobType.BACKGROUND_JOB_CLEANUP,
    ] as const) {
      try {
        await enqueueMaintenance(type);
      } catch (err) {
        logger.warn({ err: (err as Error).message, type }, "maintenance enqueue failed");
      }
    }
  };
  // Enqueue once at startup, then on an interval.
  void scheduleMaintenance();
  const maintenanceTimer = setInterval(() => void scheduleMaintenance(), MAINTENANCE_INTERVAL_MS);
  maintenanceTimer.unref();

  const stop = async (): Promise<void> => {
    clearInterval(maintenanceTimer);
    await worker.stop();
  };
  return { worker, stop };
}

// CLI entry.
if (require.main === module) {
  logger.info({ env: config.nodeEnv }, "starting luvora job worker");
  const { stop } = startWorkerProcess();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "worker received shutdown signal");
    await stop();
    await closePool();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  // Safety: force-exit if graceful shutdown stalls beyond the grace + margin.
  process.on("SIGTERM", () => {
    setTimeout(() => process.exit(1), config.jobs.shutdownGraceMs + 5_000).unref();
  });
}
