import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { config } from "../config";
import { logger } from "../logger";

/**
 * Shared PostgreSQL connection pool. One pool per process; the API is stateless
 * so pools can be scaled horizontally. Connection string drives SSL etc.
 */
export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (err) => {
  logger.error({ err }, "Unexpected idle PG client error");
});

/** Typed query helper. */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const res = await pool.query<T>(text, params as never[]);
  return res.rows;
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

export async function closePool(): Promise<void> {
  await pool.end();
}
