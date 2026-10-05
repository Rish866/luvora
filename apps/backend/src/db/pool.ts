import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { config } from "../config";
import { logger } from "../logger";
import { metrics } from "../observability/metrics";
import type { DbHealth } from "@luvora/shared";

/**
 * Shared PostgreSQL connection pool. One pool per process; the API is stateless
 * so pools can be scaled horizontally. Connection string drives SSL etc.
 */
export const POOL_MAX = 10;
export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (err) => {
  logger.error({ err }, "Unexpected idle PG client error");
});

/**
 * Typed query helper. Instrumented with best-effort DB metrics (count /
 * errors / duration). Metric recording never affects the query result or
 * throws. SQL text and bound parameters are NEVER recorded in metrics/labels.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const started = Date.now();
  try {
    const res = await pool.query<T>(text, params as never[]);
    recordDbMetric(started, false);
    return res.rows;
  } catch (err) {
    recordDbMetric(started, true);
    throw err;
  }
}

function recordDbMetric(startedMs: number, errored: boolean): void {
  try {
    metrics.incr("db_queries_total");
    if (errored) metrics.incr("db_query_errors_total");
    metrics.observe("db_query_duration_ms", Date.now() - startedMs);
  } catch {
    /* telemetry is best-effort */
  }
}

/** Run a function inside a transaction, committing on success and rolling back
 *  on any error. Essential for operations that must be atomic — e.g. creating a
 *  match or recording consent for both players. */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Safe DB health snapshot. Pings with a bounded timeout and reports pool stats.
 * NEVER exposes the connection string or credentials. `reachable=false` on any
 * connectivity error or timeout.
 */
export async function dbHealth(timeoutMs: number): Promise<DbHealth> {
  let reachable = false;
  try {
    await withTimeout(pool.query("SELECT 1"), timeoutMs);
    reachable = true;
  } catch {
    reachable = false;
  }
  // pg Pool exposes totalCount / idleCount / waitingCount.
  const total = pool.totalCount ?? 0;
  const idle = pool.idleCount ?? 0;
  const waiting = pool.waitingCount ?? 0;
  const active = Math.max(0, total - idle);
  return {
    reachable,
    poolTotal: total,
    poolIdle: idle,
    poolWaiting: waiting,
    utilization: POOL_MAX > 0 ? Math.min(1, active / POOL_MAX) : 0,
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("DB_TIMEOUT")), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export async function closePool(): Promise<void> {
  await pool.end();
}
