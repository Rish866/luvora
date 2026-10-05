/**
 * Child-process "application instance" for the multi-instance distributed abuse
 * test (Increment 12, §34). Each invocation is a SEPARATE OS process with its
 * OWN ioredis connection and its OWN RedisAbuseBackend — there is zero shared
 * JavaScript memory between instances. Coordination can ONLY come from Redis.
 *
 * Usage: node abuseInstanceChild.js <redisUrl> <prefix> <key> <limit> <windowMs> <count>
 * Emits one JSON line to stdout: { allowed: number, denied: number }
 */
import Redis from "ioredis";
import { RedisAbuseBackend } from "../../src/http/redisAbuseBackend";

async function main(): Promise<void> {
  const [, , url, prefix, key, limitStr, windowStr, countStr] = process.argv;
  const rule = { limit: Number(limitStr), windowMs: Number(windowStr) };
  const count = Number(countStr);

  const redis = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: false });
  await redis.ping();
  const backend = new RedisAbuseBackend(redis, { prefix, timeoutMs: 500 });

  const now = Date.now();
  const results = await Promise.all(
    Array.from({ length: count }, () => backend.check(key, rule, now)),
  );
  const allowed = results.filter((r) => r.allowed).length;
  const denied = results.length - allowed;

  process.stdout.write(JSON.stringify({ allowed, denied }) + "\n");
  await redis.quit();
}

main().then(
  () => process.exit(0),
  (err) => {
    process.stderr.write(String((err as Error)?.message ?? err) + "\n");
    process.exit(1);
  },
);
