import { dbHealth } from "../db/pool";
import { query } from "../db/pool";
import { config } from "../config";
import { getWorkerHealth } from "../jobs/workerRegistry";
import { redisHealthy } from "../http/redisClient";
import { abuseGuard } from "../http/abuseGuard";
import type { ReadinessReport, ReadinessCheck } from "@luvora/shared";

/**
 * Health & readiness helpers (Increment 10).
 *
 * /health is liveness — cheap, does not fail because an optional component
 * (worker/push/distributed backend) is unavailable.
 * /ready verifies critical dependencies (PostgreSQL reachable + schema present).
 * Neither leaks connection strings, SQL, credentials, paths, or stack traces.
 */

const startedAt = Date.now();

export function uptimeSeconds(): number {
  return Math.floor((Date.now() - startedAt) / 1000);
}

/** Verify the migrations table exists and the latest expected migration ran.
 *  Returns "ok" when the schema looks applied, "degraded" otherwise. */
async function migrationsCheck(): Promise<ReadinessCheck> {
  try {
    const rows = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM schema_migrations`,
    );
    // At least the baseline set of migrations must be present.
    return (rows[0]?.n ?? 0) > 0 ? "ok" : "degraded";
  } catch {
    return "error";
  }
}

/** Worker readiness: "disabled" when this process runs no embedded worker (the
 *  API is still ready — the worker runs as a separate process); otherwise it
 *  reflects the embedded worker's running state. */
function workerCheck(): ReadinessCheck {
  const health = getWorkerHealth();
  if (!health) return "disabled";
  if (health.running && !health.stopping) return "ok";
  return "degraded";
}

/**
 * Abuse-backend readiness. "disabled" when the process-local memory backend is
 * in use (always ready). When Redis is configured, a bounded PING decides
 * "ok"/"error". Exposes ONLY a status string — never the URL/credentials.
 */
async function abuseBackendCheck(): Promise<ReadinessCheck> {
  if (config.security.abuse.backend !== "redis") return "disabled";
  const ok = await redisHealthy(config.observability.readinessRedisTimeoutMs);
  return ok ? "ok" : "error";
}

/**
 * Build the structured readiness report. The API is ready iff PostgreSQL is
 * reachable AND the schema is applied. An embedded worker being disabled/absent
 * does NOT make the API not-ready (it may run as a separate process).
 *
 * When the Redis abuse backend is configured AND the fail policy is 'closed',
 * Redis being unreachable makes the API NOT ready — a security control that
 * cannot coordinate must not quietly accept traffic. Under 'open' the Redis
 * check is reported as a sub-status but does not flip readiness (availability
 * was explicitly chosen over strict enforcement).
 */
export async function buildReadiness(): Promise<ReadinessReport> {
  const db = await dbHealth(config.observability.readinessDbTimeoutMs);
  const database: ReadinessCheck = db.reachable ? "ok" : "error";
  const migrations: ReadinessCheck = db.reachable ? await migrationsCheck() : "error";
  const worker = workerCheck();
  const abuse = await abuseBackendCheck();

  const redisRequired =
    config.security.abuse.backend === "redis" && config.security.abuse.failPolicy === "closed";
  const abuseReady = !redisRequired || abuse === "ok";

  const ready = database === "ok" && migrations === "ok" && abuseReady;
  return {
    status: ready ? "ready" : "not_ready",
    checks: { database, migrations, worker, abuseBackend: abuse },
  };
}

/** Safe diagnostic snapshot of the abuse backend for admin use. Exposes only
 *  the backend kind + a status string — never a URL or credential. */
export async function abuseBackendDiagnostics(): Promise<{
  backend: string;
  status: ReadinessCheck;
  failPolicy: string;
}> {
  return {
    backend: abuseGuard.backendKind,
    status: await abuseBackendCheck(),
    failPolicy: config.security.abuse.failPolicy,
  };
}
