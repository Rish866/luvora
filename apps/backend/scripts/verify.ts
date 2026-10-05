/**
 * Sandbox verification runner.
 *
 * On developer machines you'd run Postgres via `docker compose up -d` and then
 * `npm run migrate:up && npm test`. This build sandbox has no stable Docker
 * daemon, so this script boots an EPHEMERAL native PostgreSQL (initdb into a
 * temp dir, start over a Unix socket, run the test suite, then tear down) —
 * all within this single process's lifetime, which the sandbox does not reap.
 *
 * The application code is identical in both cases; only DATABASE_URL differs.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PG_BIN = "/usr/bin";
const RUNNER_USER = "pgrunner";

function sh(cmd: string, opts: { user?: string } = {}): { code: number; out: string } {
  const full = opts.user ? ["su", "-", opts.user, "-c", cmd] : ["bash", "-c", cmd];
  const r = spawnSync(full[0], full.slice(1), { encoding: "utf8" });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

function ensureRunnerUser(): void {
  const exists = spawnSync("id", [RUNNER_USER]).status === 0;
  if (!exists) spawnSync("useradd", ["-m", RUNNER_USER]);
}

function main(): void {
  const haveInitdb = fs.existsSync(path.join(PG_BIN, "initdb"));
  if (!haveInitdb) {
    console.error(
      "Native PostgreSQL not found. On a dev machine run `docker compose up -d` " +
        "then `npm run migrate:up && npm test` instead.",
    );
    process.exit(1);
  }

  ensureRunnerUser();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rvpg-"));
  spawnSync("chown", ["-R", RUNNER_USER, dir]);
  const data = path.join(dir, "data");

  console.log("[verify] initializing ephemeral PostgreSQL...");
  let r = sh(`${PG_BIN}/initdb -D '${data}' -U app --auth=trust`, { user: RUNNER_USER });
  if (r.code !== 0) {
    console.error(r.out);
    process.exit(1);
  }
  fs.appendFileSync(
    path.join(data, "postgresql.conf"),
    `\nunix_socket_directories = '${dir}'\nlisten_addresses = ''\nfsync = off\n`,
  );

  console.log("[verify] starting PostgreSQL...");
  // Start WITHOUT -w (which can block under `su -c`), then poll with pg_isready.
  r = sh(
    `nohup ${PG_BIN}/postgres -D '${data}' -k '${dir}' > '${data}/startup.log' 2>&1 & disown; sleep 0.3`,
    { user: RUNNER_USER },
  );
  let ready = false;
  for (let i = 0; i < 30; i++) {
    const probe = sh(`${PG_BIN}/pg_isready -h '${dir}' -U app`, { user: RUNNER_USER });
    if (probe.code === 0) {
      ready = true;
      break;
    }
    spawnSync("sleep", ["0.5"]);
  }
  if (!ready) {
    console.error(r.out);
    try {
      console.error(fs.readFileSync(path.join(data, "startup.log"), "utf8"));
    } catch {
      /* ignore */
    }
    process.exit(1);
  }

  const cleanup = () => {
    sh(`${PG_BIN}/pg_ctl -D '${data}' -m immediate stop`, { user: RUNNER_USER });
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };

  try {
    sh(`${PG_BIN}/createdb -h '${dir}' -U app luvora_test`, { user: RUNNER_USER });

    // Connection string uses the Unix socket (host = dir, no password/TCP).
    const databaseUrl = `postgres://app@/luvora_test?host=${encodeURIComponent(dir)}`;

    const env = {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      JWT_ACCESS_SECRET: "test-access-secret-at-least-16-chars",
      JWT_REFRESH_SECRET: "test-refresh-secret-at-least-16-chars",
      BCRYPT_ROUNDS: "4", // fast hashing for tests
    };

    // Resolve paths relative to the backend package dir so this works no matter
    // which directory the script is launched from.
    const backendDir = path.resolve(__dirname, "..");

    console.log("[verify] running migrations...");
    const migrate = spawnSync(
      "node",
      ["-r", "ts-node/register", "src/db/migrate.ts", "up"],
      { env, encoding: "utf8", cwd: backendDir },
    );
    process.stdout.write(migrate.stdout ?? "");
    process.stderr.write(migrate.stderr ?? "");
    if (migrate.status !== 0) {
      console.error(`[verify] migrations failed (status ${migrate.status})`);
      cleanup();
      process.exit(migrate.status ?? 1);
    }

    console.log("[verify] running test suite...");
    const test = spawnSync("npx", ["vitest", "run"], {
      env,
      stdio: "inherit",
      cwd: backendDir,
    });
    cleanup();
    process.exit(test.status ?? 1);
  } catch (err) {
    console.error(err);
    cleanup();
    process.exit(1);
  }
}

main();
