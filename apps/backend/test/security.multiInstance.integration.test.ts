import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import { redisAvailable, startEphemeralRedis, type EphemeralRedis } from "./redisTestHelpers";

/**
 * TRUE multi-instance distributed-enforcement proof (Increment 12, §34).
 *
 * Spawns TWO SEPARATE Node processes ("instance A" and "instance B"), each with
 * its own ioredis connection and its own RedisAbuseBackend — no shared
 * JavaScript memory whatsoever. Both point at the SAME ephemeral Redis. The
 * combined allowed count across the two processes must equal exactly the limit,
 * which is only possible if Redis (not process memory) is doing the
 * coordination.
 *
 * Skips cleanly when no redis-server binary is available.
 */

const haveRedis = redisAvailable();
const d = haveRedis ? describe : describe.skip;

const CHILD = path.resolve(__dirname, "fixtures/abuseInstanceChild.ts");

function runInstance(
  url: string,
  prefix: string,
  key: string,
  limit: number,
  windowMs: number,
  count: number,
): Promise<{ allowed: number; denied: number }> {
  return new Promise((resolve, reject) => {
    // Run the TS child via ts-node (the project already uses ts-node for scripts).
    const proc = spawn(
      "node",
      [
        "-r",
        "ts-node/register/transpile-only",
        CHILD,
        url,
        prefix,
        key,
        String(limit),
        String(windowMs),
        String(count),
      ],
      { cwd: path.resolve(__dirname, ".."), stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    proc.stdout.on("data", (c) => (out += c));
    proc.stderr.on("data", (c) => (err += c));
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`child exited ${code}: ${err}`));
        return;
      }
      try {
        resolve(JSON.parse(out.trim().split("\n").pop() as string));
      } catch (e) {
        reject(new Error(`bad child output: ${out} / ${err} / ${(e as Error).message}`));
      }
    });
  });
}

d("distributed abuse across two independent processes", () => {
  let server: EphemeralRedis;

  beforeAll(async () => {
    server = await startEphemeralRedis();
  }, 30_000);

  afterAll(async () => {
    await server?.stop();
  });

  it("enforces a shared limit across two separate OS processes", async () => {
    const limit = 10;
    const key = "multiproc";
    // Each process attempts 10 concurrent checks → 20 total attempts, limit 10.
    const [a, b] = await Promise.all([
      runInstance(server.url, "mi1", key, limit, 10_000, 10),
      runInstance(server.url, "mi1", key, limit, 10_000, 10),
    ]);
    const totalAllowed = a.allowed + b.allowed;
    const totalDenied = a.denied + b.denied;
    // The atomic Lua check-and-increment guarantees EXACTLY `limit` allowed
    // across BOTH processes — impossible without Redis-side coordination.
    expect(totalAllowed).toBe(limit);
    expect(totalDenied).toBe(20 - limit);
    // And each process must have done SOME work (both really ran).
    expect(a.allowed + a.denied).toBe(10);
    expect(b.allowed + b.denied).toBe(10);
  }, 30_000);

  it("a second wave from fresh processes is fully rejected (state persisted)", async () => {
    const limit = 3;
    const key = "persist";
    // Wave 1: one process consumes the whole budget.
    const first = await runInstance(server.url, "mi2", key, limit, 60_000, 3);
    expect(first.allowed).toBe(3);
    // Wave 2: a BRAND-NEW process sees the budget already spent (Redis state).
    const second = await runInstance(server.url, "mi2", key, limit, 60_000, 3);
    expect(second.allowed).toBe(0);
    expect(second.denied).toBe(3);
  }, 30_000);
});
