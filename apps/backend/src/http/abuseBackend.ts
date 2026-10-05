/**
 * Abuse / rate-limit backend abstraction (Increment 11 → generalised in
 * Increment 12 for distributed enforcement).
 *
 * The AbuseGuard (abuseGuard.ts) owns the SECURITY SEMANTICS — rules, scopes,
 * key construction, fingerprinting, retry-after shaping, metrics, enable switch
 * and fail-open/closed policy. A backend owns only the STATE MECHANICS —
 * counters/windows, TTL, atomicity, and (for Redis) distributed coordination.
 *
 * The interface is ASYNC so a networked backend (Redis) can be plugged in
 * without a correctness-destroying synchronous cache. The in-memory backend
 * simply resolves immediately.
 */

export interface AbuseDecision {
  /** True when the request/attempt is allowed. */
  allowed: boolean;
  /** Remaining attempts in the current window (>= 0). */
  remaining: number;
  /** Seconds until the window resets / the caller may retry. */
  retryAfterSeconds: number;
  /** Current count within the window (for diagnostics/tests). */
  count: number;
}

export interface AbuseRule {
  /** Max events permitted within `windowMs`. */
  limit: number;
  windowMs: number;
}

/**
 * Pluggable backend seam. Implemented by InMemoryAbuseBackend (process-local)
 * and RedisAbuseBackend (distributed). Every method is async.
 *
 * `now` is passed in by the guard (injectable clock) so unit tests remain
 * deterministic; a distributed backend may ignore it and use server time.
 */
export interface AbuseBackend {
  /** Atomic check-and-increment of a sliding window for `key`. */
  check(key: string, rule: AbuseRule, now: number): Promise<AbuseDecision>;
  /** Non-counting probe: seconds remaining on an active penalty block (0 = none). */
  blockedFor(key: string, now: number): Promise<number>;
  /** Record a penalty block for `key` lasting `seconds` from `now`. */
  block(key: string, seconds: number, now: number): Promise<void>;
  /** Clear all state for a single key (e.g. reset login failures on success). */
  reset(key: string): Promise<void>;
  /** Approximate number of tracked keys (diagnostics/tests). */
  size(): Promise<number>;
  /** Drop ALL state owned by this backend (test isolation / namespaced only). */
  clear(): Promise<void>;
  /** Short identifier for metrics/diagnostics labels: "memory" | "redis". */
  readonly kind: string;
}

interface Entry {
  /** Timestamps (ms) of events within the current window. */
  hits: number[];
  /** Last touch (ms) — used for LRU eviction. */
  touched: number;
  /** Explicit block-until (ms) for penalty-style throttling (0 = none). */
  blockedUntil: number;
}

/**
 * Process-local backend with bounded memory: at most `maxKeys` entries (approx
 * LRU eviction) plus a periodic sweep of expired entries. Deterministic given
 * the injected `now`. This remains the default and is used for dev/test and
 * single-instance deployments — it is NOT globally distributed.
 */
export class InMemoryAbuseBackend implements AbuseBackend {
  readonly kind = "memory";
  private readonly map = new Map<string, Entry>();
  private lastSweep = 0;

  constructor(private readonly maxKeys: number) {}

  private sweep(now: number): void {
    if (now - this.lastSweep < 1000) return;
    this.lastSweep = now;
    for (const [k, e] of this.map) {
      const recent = e.hits.length > 0 ? e.hits[e.hits.length - 1] : e.touched;
      if (now - recent > 3_600_000 && e.blockedUntil <= now) {
        this.map.delete(k);
      }
    }
  }

  private evictIfNeeded(): void {
    if (this.map.size < this.maxKeys) return;
    const toEvict = Math.max(1, Math.floor(this.maxKeys * 0.01));
    const entries = [...this.map.entries()].sort((a, b) => a[1].touched - b[1].touched);
    for (let i = 0; i < toEvict && i < entries.length; i++) {
      this.map.delete(entries[i][0]);
    }
  }

  async check(key: string, rule: AbuseRule, now: number): Promise<AbuseDecision> {
    this.sweep(now);
    let e = this.map.get(key);
    if (!e) {
      this.evictIfNeeded();
      e = { hits: [], touched: now, blockedUntil: 0 };
      this.map.set(key, e);
    }
    e.touched = now;

    // Active penalty block takes precedence.
    if (e.blockedUntil > now) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.ceil((e.blockedUntil - now) / 1000),
        count: e.hits.length,
      };
    }

    // Drop hits outside the window.
    const windowStart = now - rule.windowMs;
    e.hits = e.hits.filter((t) => t > windowStart);

    if (e.hits.length >= rule.limit) {
      const oldest = e.hits[0];
      const retryAfterMs = Math.max(0, oldest + rule.windowMs - now);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
        count: e.hits.length,
      };
    }

    e.hits.push(now);
    return {
      allowed: true,
      remaining: Math.max(0, rule.limit - e.hits.length),
      retryAfterSeconds: 0,
      count: e.hits.length,
    };
  }

  async blockedFor(key: string, now: number): Promise<number> {
    const e = this.map.get(key);
    if (!e || e.blockedUntil <= now) return 0;
    return Math.ceil((e.blockedUntil - now) / 1000);
  }

  async block(key: string, seconds: number, now: number): Promise<void> {
    let e = this.map.get(key);
    if (!e) {
      this.evictIfNeeded();
      e = { hits: [], touched: now, blockedUntil: 0 };
      this.map.set(key, e);
    }
    e.touched = now;
    e.blockedUntil = Math.max(e.blockedUntil, now + seconds * 1000);
  }

  async reset(key: string): Promise<void> {
    this.map.delete(key);
  }

  async size(): Promise<number> {
    return this.map.size;
  }

  async clear(): Promise<void> {
    this.map.clear();
    this.lastSweep = 0;
  }
}
