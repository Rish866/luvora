import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";

/**
 * Ephemeral Redis for integration tests (Increment 12).
 *
 * Boots a throwaway `redis-server` on a free port with a unique data dir, and
 * tears it down afterwards. If no redis-server binary is found, `isAvailable`
 * is false and the caller MUST skip (we never pretend a Redis test ran without
 * Redis). This keeps `npm test`/`verify` self-contained — the Redis suite skips
 * cleanly when Redis is absent instead of failing.
 */

const REDIS_CANDIDATES = [
  process.env.REDIS_SERVER_BIN,
  "redis6-server",
  "redis-server",
  "/usr/bin/redis6-server",
  "/usr/bin/redis-server",
].filter(Boolean) as string[];

export interface EphemeralRedis {
  url: string;
  port: number;
  stop: () => Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function resolveBinary(): string | null {
  // We can't easily `which` cross-platform here; rely on spawn failing fast.
  return REDIS_CANDIDATES[0] ?? null;
}

let resolvedBin: string | null = null;

/** Synchronously probe whether a redis-server binary can be launched. Sync so
 *  tests can gate `describe` at module load without top-level await (which is
 *  disallowed under the project's CommonJS tsconfig). */
export function redisAvailable(): boolean {
  if (resolvedBin) return true;
  for (const bin of REDIS_CANDIDATES) {
    try {
      const res = spawnSync(bin, ["--version"], { stdio: "ignore" });
      if (res.status === 0) {
        resolvedBin = bin;
        return true;
      }
    } catch {
      /* try next candidate */
    }
  }
  return false;
}

/** Start an ephemeral redis-server. Throws if no binary is available (callers
 *  should gate on redisAvailable() first). */
export async function startEphemeralRedis(): Promise<EphemeralRedis> {
  const bin = resolvedBin ?? resolveBinary();
  if (!bin) throw new Error("no redis-server binary available");
  const port = await freePort();
  const dir = mkdtempSync(path.join(tmpdir(), "luvora-redis-"));
  const proc: ChildProcess = spawn(
    bin,
    [
      "--port",
      String(port),
      "--bind",
      "127.0.0.1",
      "--save",
      "",
      "--appendonly",
      "no",
      "--dir",
      dir,
    ],
    { stdio: "ignore" },
  );

  // Wait until the port accepts connections.
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (Date.now() > deadline) {
      proc.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
      throw new Error("redis did not start in time");
    }
    const up = await new Promise<boolean>((resolve) => {
      const sock = net.connect(port, "127.0.0.1");
      sock.on("connect", () => {
        sock.end();
        resolve(true);
      });
      sock.on("error", () => resolve(false));
    });
    if (up) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    url: `redis://127.0.0.1:${port}`,
    port,
    stop: async () => {
      proc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 150));
      if (!proc.killed) proc.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
