import { config } from "../config";

/**
 * Process-local abuse / rate-limit control (Increment 11).
 *
 * A single reusable primitive behind every abuse-sensitive surface (login,
 * reports, device registration, discovery interactions, WebSocket events, ...).
 * Scattered endpoint-specific logic now funnels through this.
 *
 * Design:
 *  - Sliding-window counting keyed by an opaque SCOPE:KEY string. Callers choose
 *    the key dimension(s) — e.g. IP, account id, or a composite — so an attacker
 *    cannot bypass protection by rotating a single dimension (callers check more
 *    than one key where appropriate).
 *  - BOUNDED memory: at most `maxKeys` entries; when full, the oldest-touched
 *    entries are evicted (approximate LRU). Expired entries are also swept
 *    periodically. There is no unbounded Map.
 *  - Deterministic + injectable clock for tests.
 *
 * LIMITATION (documented, not hidden): this is PROCESS-LOCAL. With multiple API
 * instances each process enforces its own limits — it is NOT a global/
 * distributed limiter. A distributed backend (e.g. Redis) would be required for
 * cluster-wide enforcement; the `AbuseBackend` shape below marks where that
 * plugs in. Only the in-memory backend is implemented.
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

interface Entry {
  /** Timestamps (ms) of events within the current window. */
  hits: number[];
  /** Last touch (ms) — used for LRU eviction. */
  touched: number;
  /** Explicit block-until (ms) for penalty-style throttling (0 = none). */
  blockedUntil: number;
}

/** Pluggable backend seam. Only InMemoryAbuseBackend is implemented; a
 *  distributed (Redis) backend would implement the same surface. */
export interface AbuseBackend {
  check(key: string, rule: AbuseRule, now: number): AbuseDecision;
  /** Non-counting probe: is `key` under an active penalty block right now? */
  blockedFor(key: string, now: number): number;
  /** Record a penalty block for `key` lasting `seconds` from `now`. */
  block(key: string, seconds: number, now: number): void;
  /** Clear all state for a key (e.g. reset login failures on success). */
  reset(key: string): void;
  size(): number;
  clear(): void;
}

export class InMemoryAbuseBackend implements AbuseBackend {
  private readonly map = new Map<string, Entry>();
  private lastSweep = 0;

  constructor(private readonly maxKeys: number) {}

  private sweep(now: number): void {
    // Sweep at most ~once/sec to bound overhead.
    if (now - this.lastSweep < 1000) return;
    this.lastSweep = now;
    // Remove entries with no recent hits and no active block. We cap work by
    // iterating lazily; the hard LRU cap below is the real memory bound.
    for (const [k, e] of this.map) {
      const recent = e.hits.length > 0 ? e.hits[e.hits.length - 1] : e.touched;
      if (now - recent > 3_600_000 && e.blockedUntil <= now) {
        this.map.delete(k);
      }
    }
  }

  private evictIfNeeded(): void {
    if (this.map.size < this.maxKeys) return;
    // Approximate LRU: evict the oldest-touched ~1% of entries.
    const toEvict = Math.max(1, Math.floor(this.maxKeys * 0.01));
    const entries = [...this.map.entries()].sort((a, b) => a[1].touched - b[1].touched);
    for (let i = 0; i < toEvict && i < entries.length; i++) {
      this.map.delete(entries[i][0]);
    }
  }

  check(key: string, rule: AbuseRule, now: number): AbuseDecision {
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

  blockedFor(key: string, now: number): number {
    const e = this.map.get(key);
    if (!e || e.blockedUntil <= now) return 0;
    return Math.ceil((e.blockedUntil - now) / 1000);
  }

  block(key: string, seconds: number, now: number): void {
    let e = this.map.get(key);
    if (!e) {
      this.evictIfNeeded();
      e = { hits: [], touched: now, blockedUntil: 0 };
      this.map.set(key, e);
    }
    e.touched = now;
    e.blockedUntil = Math.max(e.blockedUntil, now + seconds * 1000);
  }

  reset(key: string): void {
    this.map.delete(key);
  }

  size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
    this.lastSweep = 0;
  }
}

/**
 * The AbuseGuard — the application-facing API over a backend. Honours the global
 * `ABUSE_GUARD_ENABLED` switch (independent of the legacy express-rate-limit
 * `rateLimitEnabled`, so tests can exercise throttling under NODE_ENV=test).
 */
export class AbuseGuard {
  constructor(
    private readonly backend: AbuseBackend,
    private readonly enabled: boolean,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /** Count one event against `scope:key` and decide. When disabled, always
   *  allows (but still returns a well-formed decision). */
  hit(scope: string, key: string, rule: AbuseRule): AbuseDecision {
    if (!this.enabled) {
      return { allowed: true, remaining: rule.limit, retryAfterSeconds: 0, count: 0 };
    }
    return this.backend.check(`${scope}:${key}`, rule, this.clock());
  }

  /** Non-counting probe: seconds remaining on an active penalty block for
   *  `scope:key` (0 = not blocked). */
  blockedFor(scope: string, key: string): number {
    if (!this.enabled) return 0;
    return this.backend.blockedFor(`${scope}:${key}`, this.clock());
  }

  /** Apply an explicit penalty block to `scope:key`. */
  block(scope: string, key: string, seconds: number): void {
    if (!this.enabled) return;
    this.backend.block(`${scope}:${key}`, seconds, this.clock());
  }

  /** Clear state for `scope:key` (e.g. after a successful login). */
  reset(scope: string, key: string): void {
    this.backend.reset(`${scope}:${key}`);
  }

  size(): number {
    return this.backend.size();
  }

  clear(): void {
    this.backend.clear();
  }
}

/** Shared process-wide abuse guard. */
export const abuseGuard = new AbuseGuard(
  new InMemoryAbuseBackend(config.security.abuseGuardMaxKeys),
  config.security.abuseGuardEnabled,
);
