import type { Worker } from "./worker";
import type { WorkerHealth } from "@luvora/shared";

/**
 * Process-local reference to the embedded worker (if this process runs one), so
 * admin diagnostics can report its health. The API server does NOT require a
 * worker — when none is running, health reports `null` and the API is still
 * considered healthy.
 */
let activeWorker: Worker | null = null;

export function setActiveWorker(worker: Worker | null): void {
  activeWorker = worker;
}

export function getWorkerHealth(): WorkerHealth | null {
  return activeWorker ? activeWorker.health() : null;
}
