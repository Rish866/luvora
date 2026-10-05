import Redis, { type RedisOptions } from "ioredis";
import { config } from "../config";
import { log } from "../observability/logger";

/**
 * Lazily-constructed, process-wide ioredis client used by the distributed abuse
 * backend (Increment 12). Mirrors the db/pool.ts pattern: a single shared
 * connection, an error handler so an idle socket error never crashes the
 * process, a bounded reconnect strategy, a timeout-bounded health probe, and a
 * graceful close. The Redis URL/credentials are NEVER logged — only safe status
 * (connected / reconnecting / error-name) is ever emitted.
 *
 * The connection is created ONLY when something asks for it (initRedis/getRedis)
 * so processes that don't use Redis (e.g. the worker, or memory-backend
 * deployments) never open a socket.
 */

let client: Redis | null = null;
let lastKnownStatus = "uninitialized";

function buildOptions(): RedisOptions {
  return {
    // Bound command wait + connect so a stalled Redis degrades per fail policy
    // instead of hanging a request. The abuse backend also wraps each op in its
    // own timeout for defence in depth.
    connectTimeout: Math.max(1000, config.security.abuse.redisTimeoutMs * 10),
    commandTimeout: Math.max(50, config.security.abuse.redisTimeoutMs),
    // Fail fast on an unreachable server rather than queueing commands forever.
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
    // Bounded, capped exponential reconnect backoff: never a tight loop.
    retryStrategy(times: number): number | null {
      const delay = Math.min(1000 * 2 ** Math.min(times, 5), 30_000);
      return delay;
    },
    // Treat READONLY (failover) as reconnectable; otherwise default behaviour.
    reconnectOnError: () => false,
  };
}

/** Create (if needed) and return the shared Redis client. Attaches logging on
 *  lifecycle events — none of which include the URL or credentials. */
export function getRedis(): Redis {
  if (client) return client;
  const c = new Redis(config.security.abuse.redisUrl, buildOptions());
  // Lifecycle logging: safe status only, never the connection string.
  c.on("connect", () => {
    lastKnownStatus = "connecting";
  });
  c.on("ready", () => {
    lastKnownStatus = "ready";
    log.info({ component: "abuse-redis" }, "abuse backend redis ready");
  });
  c.on("reconnecting", () => {
    lastKnownStatus = "reconnecting";
  });
  c.on("end", () => {
    lastKnownStatus = "end";
  });
  c.on("error", (err) => {
    lastKnownStatus = "error";
    // ioredis error messages can embed host:port but never the password; still,
    // we log only the error NAME to be safe (the structured logger also strips
    // sensitive field keys).
    log.warn(
      { component: "abuse-redis", errorName: (err as Error)?.name ?? "RedisError" },
      "abuse backend redis error",
    );
  });
  client = c;
  return c;
}

/** Eagerly open the connection at process startup and verify it with a PING,
 *  so a misconfigured Redis is surfaced early rather than on the first request.
 *  Returns true when reachable. Never throws. */
export async function initRedis(): Promise<boolean> {
  try {
    const c = getRedis();
    await c.connect().catch((err) => {
      // connect() rejects if already connecting/connected; ignore that case.
      if (!/already/i.test((err as Error)?.message ?? "")) throw err;
    });
    await c.ping();
    return true;
  } catch (err) {
    log.warn(
      { component: "abuse-redis", errorName: (err as Error)?.name ?? "RedisError" },
      "abuse backend redis initial connection failed",
    );
    return false;
  }
}

/** Timeout-bounded health probe for readiness. Returns true iff a PING succeeds
 *  within the configured readiness timeout. Exposes NO connection details. */
export async function redisHealthy(timeoutMs: number): Promise<boolean> {
  if (!client) return false;
  try {
    const ping = client.ping();
    const result = await Promise.race([
      ping,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("REDIS_TIMEOUT")), timeoutMs),
      ),
    ]);
    return result === "PONG";
  } catch {
    return false;
  }
}

/** Safe status string for diagnostics (never a URL/credential). */
export function redisStatus(): string {
  return client ? client.status || lastKnownStatus : "uninitialized";
}

/** Graceful shutdown: quit the connection if open. Never throws. */
export async function closeRedis(): Promise<void> {
  if (!client) return;
  const c = client;
  client = null;
  try {
    await c.quit();
  } catch {
    try {
      c.disconnect();
    } catch {
      /* ignore */
    }
  }
}

/** Test-only: drop the cached client so a test can reconfigure/reconnect. */
export function __resetRedisForTests(): void {
  client = null;
  lastKnownStatus = "uninitialized";
}
