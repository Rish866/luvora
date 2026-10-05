import type Redis from "ioredis";
import type { AbuseBackend, AbuseDecision, AbuseRule } from "./abuseBackend";

/**
 * Distributed abuse backend backed by Redis (Increment 12).
 *
 * State is shared across every application instance pointed at the same Redis,
 * so an attacker cannot bypass a limit by alternating requests between
 * instances. All mutating operations are ATOMIC via a single Lua script
 * (evaluated server-side), so concurrent requests from different instances
 * cannot race past the limit.
 *
 * Key layout (all under the configured prefix; `v1` allows a future format bump):
 *   <prefix>:abuse:v1:w:<key>   sorted set — sliding-window event timestamps (ms)
 *   <prefix>:abuse:v1:b:<key>   string with TTL — active penalty block
 *
 * `<key>` is already a fingerprinted, bounded, colon-delimited scope+identifier
 * produced by the AbuseGuard — it NEVER contains a raw IP/email/user id or any
 * secret. We additionally bound its length defensively here.
 *
 * Memory is bounded without any application sweep: the window ZSET is given a
 * TTL of the window length (refreshed on each hit) and trimmed of expired
 * members inside the script; the block key expires with the penalty. Idle keys
 * disappear on their own.
 */

const KEY_VERSION = "v1";
const MAX_KEY_LEN = 256;

/**
 * Atomic sliding-window check-and-increment, honouring an active penalty block.
 *
 * KEYS[1] = window zset key
 * KEYS[2] = block key
 * ARGV[1] = now (ms)         ARGV[2] = windowMs
 * ARGV[3] = limit            ARGV[4] = a unique member id (now:rand)
 *
 * Returns: { allowed(0|1), remaining, retryAfterSeconds, count }
 */
const CHECK_LUA = `
local wkey = KEYS[1]
local bkey = KEYS[2]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

-- Active penalty block takes precedence (matches in-memory semantics).
local bttl = redis.call('PTTL', bkey)
if bttl and bttl > 0 then
  local secs = math.ceil(bttl / 1000)
  return { 0, 0, secs, limit }
end

-- Drop events outside the window, then count what remains.
local windowStart = now - windowMs
redis.call('ZREMRANGEBYSCORE', wkey, '-inf', windowStart)
local count = redis.call('ZCARD', wkey)

if count >= limit then
  -- Retry-after derived from the oldest surviving event.
  local oldest = redis.call('ZRANGE', wkey, 0, 0, 'WITHSCORES')
  local retry = 1
  if oldest and oldest[2] then
    local ms = (tonumber(oldest[2]) + windowMs) - now
    retry = math.max(1, math.ceil(ms / 1000))
  end
  return { 0, 0, retry, count }
end

-- Record this event and bound the key lifetime to the window.
redis.call('ZADD', wkey, now, member)
redis.call('PEXPIRE', wkey, windowMs)
local newCount = count + 1
local remaining = limit - newCount
if remaining < 0 then remaining = 0 end
return { 1, remaining, 0, newCount }
`;

/** Register a penalty block, never shortening an existing one.
 *  KEYS[1] = block key, ARGV[1] = seconds. */
const BLOCK_LUA = `
local bkey = KEYS[1]
local secs = tonumber(ARGV[1])
local existing = redis.call('PTTL', bkey)
local existingSecs = 0
if existing and existing > 0 then existingSecs = math.ceil(existing / 1000) end
if secs > existingSecs then
  redis.call('SET', bkey, '1', 'EX', secs)
end
return 1
`;

export interface RedisAbuseBackendOptions {
  prefix: string;
  /** Per-operation timeout (ms) applied by the caller/guard; stored for ref. */
  timeoutMs: number;
}

export class RedisAbuseBackend implements AbuseBackend {
  readonly kind = "redis";
  private readonly ns: string;

  constructor(
    private readonly redis: Redis,
    private readonly opts: RedisAbuseBackendOptions,
  ) {
    this.ns = `${opts.prefix}:abuse:${KEY_VERSION}`;
  }

  /** Defensive canonicalisation: bound length so a crafted scope cannot create
   *  a huge key. The guard already fingerprints identifiers; this is belt-and-
   *  braces. The result is still deterministic for a given input. */
  private safeKey(key: string): string {
    const trimmed = key.length > MAX_KEY_LEN ? key.slice(0, MAX_KEY_LEN) : key;
    return trimmed;
  }

  private windowKey(key: string): string {
    return `${this.ns}:w:${this.safeKey(key)}`;
  }

  private blockKey(key: string): string {
    return `${this.ns}:b:${this.safeKey(key)}`;
  }

  async check(key: string, rule: AbuseRule, now: number): Promise<AbuseDecision> {
    const member = `${now}:${Math.random().toString(36).slice(2, 10)}`;
    const res = (await this.redis.eval(
      CHECK_LUA,
      2,
      this.windowKey(key),
      this.blockKey(key),
      String(now),
      String(rule.windowMs),
      String(rule.limit),
      member,
    )) as [number, number, number, number];
    return {
      allowed: res[0] === 1,
      remaining: res[1],
      retryAfterSeconds: res[2],
      count: res[3],
    };
  }

  async blockedFor(key: string, _now: number): Promise<number> {
    const pttl = await this.redis.pttl(this.blockKey(key));
    if (pttl <= 0) return 0;
    return Math.ceil(pttl / 1000);
  }

  async block(key: string, seconds: number, _now: number): Promise<void> {
    await this.redis.eval(BLOCK_LUA, 1, this.blockKey(key), String(seconds));
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(this.windowKey(key), this.blockKey(key));
  }

  async size(): Promise<number> {
    // Bounded scan over only this backend's namespace (never a global KEYS *).
    let cursor = "0";
    let count = 0;
    const match = `${this.ns}:*`;
    do {
      const [next, batch] = (await this.redis.scan(
        cursor,
        "MATCH",
        match,
        "COUNT",
        500,
      )) as [string, string[]];
      cursor = next;
      count += batch.length;
      // Hard cap the work so size() can never become an unbounded operation.
      if (count > 100_000) break;
    } while (cursor !== "0");
    return count;
  }

  /** Delete ONLY keys under this backend's namespace. Never FLUSHALL/FLUSHDB —
   *  that would destroy unrelated data in a shared Redis. */
  async clear(): Promise<void> {
    let cursor = "0";
    const match = `${this.ns}:*`;
    do {
      const [next, batch] = (await this.redis.scan(
        cursor,
        "MATCH",
        match,
        "COUNT",
        500,
      )) as [string, string[]];
      cursor = next;
      if (batch.length > 0) await this.redis.del(...batch);
    } while (cursor !== "0");
  }
}
