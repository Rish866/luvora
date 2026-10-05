import fs from "node:fs";
import path from "node:path";
import { pool, withTransaction } from "./pool";
import { logger } from "../logger";

/**
 * Minimal, dependency-free forward migration runner.
 *
 * Applies `.sql` files in the repo-level database/migrations directory in
 * lexical order, each inside a transaction, recording applied files in
 * schema_migrations. Re-running is a no-op for already-applied files
 * (idempotent). We intentionally keep this small and auditable rather than
 * pulling a heavy migration framework.
 *
 * `down` is intentionally not implemented for forward-only SQL migrations; to
 * reset a dev/test database, drop and recreate it (see scripts/verify.ts).
 */

// __dirname at runtime: apps/backend/src/db  ->  ../../../../database/migrations
const MIGRATIONS_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "database",
  "migrations",
);

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function appliedSet(): Promise<Set<string>> {
  const { rows } = await pool.query<{ filename: string }>(
    "SELECT filename FROM schema_migrations",
  );
  return new Set(rows.map((r) => r.filename));
}

export async function migrateUp(): Promise<string[]> {
  await ensureMigrationsTable();
  const already = await appliedSet();
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const applied: string[] = [];
  for (const file of files) {
    if (already.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (filename) VALUES ($1)",
        [file],
      );
    });
    logger.info({ migration: file }, "applied migration");
    applied.push(file);
  }
  return applied;
}

// CLI entry
if (require.main === module) {
  const cmd = process.argv[2] ?? "up";
  (async () => {
    if (cmd === "up") {
      const applied = await migrateUp();
      // eslint-disable-next-line no-console
      console.log(
        applied.length
          ? `Applied: ${applied.join(", ")}`
          : "No pending migrations.",
      );
    } else {
      // eslint-disable-next-line no-console
      console.error(`Unsupported command: ${cmd}. Only 'up' is supported.`);
      process.exitCode = 1;
    }
    await pool.end();
  })().catch((err) => {
    logger.error({ err }, "migration failed");
    // Also write to stderr directly: the structured logger is silenced under
    // NODE_ENV=test, and migration failures must always be visible to CI.
    // eslint-disable-next-line no-console
    console.error("Migration failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
    pool.end();
  });
}
