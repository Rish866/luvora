import { config } from "../config";
import { log } from "../observability/logger";
import { abuseGuard } from "./abuseGuard";
import { RedisAbuseBackend } from "./redisAbuseBackend";
import { getRedis, initRedis } from "./redisClient";

/**
 * Initialise the abuse backend at process startup (Increment 12).
 *
 * - ABUSE_BACKEND=memory → nothing to do (the guard already starts in memory).
 * - ABUSE_BACKEND=redis  → connect to Redis and swap the guard's backend to the
 *   distributed RedisAbuseBackend. If the initial connection fails, honour the
 *   fail policy:
 *     'closed' (default, production-required) → keep trying in the background;
 *       the guard's per-op fail-closed logic denies security-critical checks
 *       while Redis is unavailable (we do NOT silently downgrade to the
 *       process-local backend — that would be a security downgrade).
 *     'open' → log and continue; the guard fails open on backend errors.
 *
 * Called from server.ts (and NOT from the worker, which does not use the guard).
 * Never throws — startup proceeds and readiness reflects Redis health.
 */
export async function initAbuseBackend(): Promise<void> {
  if (config.security.abuse.backend !== "redis") {
    log.info({ component: "abuse-guard", backend: "memory" }, "abuse backend initialized");
    return;
  }

  // Install the Redis backend regardless of initial connectivity: the backend
  // routes through the shared ioredis client, which reconnects on its own. The
  // guard's fail policy covers the window where Redis is not yet reachable.
  const redis = getRedis();
  abuseGuard.setBackend(
    new RedisAbuseBackend(redis, {
      prefix: config.security.abuse.redisKeyPrefix,
      timeoutMs: config.security.abuse.redisTimeoutMs,
    }),
  );

  const reachable = await initRedis();
  if (reachable) {
    log.info({ component: "abuse-guard", backend: "redis" }, "abuse backend initialized");
  } else {
    // Do not fall back to memory: that would silently make a multi-instance
    // deployment's limits process-local. Surface it; readiness will report the
    // Redis dependency as not-ready, and the guard applies the fail policy.
    log.warn(
      {
        component: "abuse-guard",
        backend: "redis",
        policy: config.security.abuse.failPolicy,
      },
      "abuse backend redis not reachable at startup; applying fail policy until it recovers",
    );
  }
}
