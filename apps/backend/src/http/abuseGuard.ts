import crypto from "node:crypto";
import { config } from "../config";
import { metrics } from "../observability/metrics";
import { log } from "../observability/logger";
import {
  type AbuseBackend,
  type AbuseDecision,
  type AbuseRule,
  InMemoryAbuseBackend,
} from "./abuseBackend";

export type { AbuseBackend, AbuseDecision, AbuseRule } from "./abuseBackend";
export { InMemoryAbuseBackend } from "./abuseBackend";

/**
 * AbuseGuard — the application-facing API over a pluggable AbuseBackend
 * (Increment 11 → distributed in Increment 12).
 *
 * Responsibilities (security semantics live HERE, not in the backend):
 *  - rules / limits / scopes / key construction
 *  - FINGERPRINTING raw identifiers (IP / email / user id) with an HMAC so no
 *    raw PII ever reaches the backend keyspace (critical for Redis)
 *  - retry-after shaping + the `ABUSE_GUARD_ENABLED` master switch
 *  - metrics + sanitized logging
 *  - the fail-open / fail-closed policy when a distributed backend errors
 *
 * The backend owns only counters/windows/TTL/atomicity/distribution.
 *
 * DISTRIBUTION: with the memory backend this is process-local (NOT globally
 * enforced). With the redis backend, state is shared across all instances and
 * check-and-increment is atomic, so limits hold cluster-wide. The configured
 * fail policy governs behaviour if Redis is unavailable.
 */

const DECISION_ALLOWED = (rule: AbuseRule): AbuseDecision => ({
  allowed: true,
  remaining: rule.limit,
  retryAfterSeconds: 0,
  count: 0,
});

export class AbuseGuard {
  private readonly fingerprintKey: Buffer;
  private backend: AbuseBackend;

  constructor(
    backend: AbuseBackend,
    private readonly enabled: boolean,
    private readonly failPolicy: "open" | "closed",
    fingerprintSecret: string,
    private readonly clock: () => number = () => Date.now(),
  ) {
    this.backend = backend;
    this.fingerprintKey = Buffer.from(fingerprintSecret || "luvora-abuse", "utf8");
  }

  /** Swap the underlying backend in place (startup wiring installs Redis after
   *  the connection is ready). All existing holders of this singleton see the
   *  change — the identity of the guard never changes. */
  setBackend(backend: AbuseBackend): void {
    this.backend = backend;
  }

  /** Which backend is active (for diagnostics/readiness). */
  get backendKind(): string {
    return this.backend.kind;
  }

  /**
   * HMAC-fingerprint a raw identifier so it is safe to use inside a backend key
   * (never a raw IP/email/user id). Deterministic + non-reversible. Returns a
   * short hex digest. An empty/unknown identifier yields a stable "none" token
   * so callers still produce a well-formed key.
   */
  fingerprint(identifier: string | undefined | null): string {
    if (!identifier || identifier === "unknown") return "none";
    return crypto
      .createHmac("sha256", this.fingerprintKey)
      .update(identifier)
      .digest("hex")
      .slice(0, 20);
  }

  /** Compose the opaque backend key. `scope` is a fixed, bounded label; `fp` is
   *  already a fingerprint. No raw PII, no secrets. */
  private composeKey(scope: string, fp: string): string {
    return `${scope}:${fp}`;
  }

  private recordOp(op: string): void {
    try {
      metrics.incr("abuse_backend_requests_total", { backend: this.backend.kind, op });
    } catch {
      /* best-effort */
    }
  }

  /** Handle a backend error according to the fail policy. For a COUNTING check,
   *  fail-closed denies (deny-list a request rather than silently stop
   *  protecting); fail-open allows. Always records metrics + a sanitized log. */
  private onBackendError(op: string, err: unknown): void {
    try {
      metrics.incr("abuse_backend_errors_total", { backend: this.backend.kind, op });
      metrics.incr("abuse_backend_fallbacks_total", { policy: this.failPolicy });
    } catch {
      /* best-effort */
    }
    log.warn(
      {
        component: "abuse-guard",
        backend: this.backend.kind,
        op,
        policy: this.failPolicy,
        errorName: (err as Error)?.name ?? "AbuseBackendError",
      },
      "abuse backend unavailable; applying fail policy",
    );
  }

  private observeLatency(ms: number): void {
    if (this.backend.kind !== "redis") return;
    try {
      metrics.observe("abuse_redis_latency_ms", ms);
    } catch {
      /* best-effort */
    }
  }

  /**
   * Count one event against `scope`+`identifier` and decide. The identifier is
   * fingerprinted before it reaches the backend. When disabled, always allows.
   * On backend error, applies the fail policy (closed => deny, open => allow).
   */
  async hit(scope: string, identifier: string, rule: AbuseRule): Promise<AbuseDecision> {
    if (!this.enabled) return DECISION_ALLOWED(rule);
    const key = this.composeKey(scope, this.fingerprint(identifier));
    const started = Date.now();
    try {
      this.recordOp("check");
      const decision = await this.backend.check(key, rule, this.clock());
      this.observeLatency(Date.now() - started);
      if (!decision.allowed && this.backend.kind === "redis") {
        try {
          metrics.incr("abuse_redis_rejections_total", { scope });
        } catch {
          /* best-effort */
        }
      }
      return decision;
    } catch (err) {
      this.observeLatency(Date.now() - started);
      this.onBackendError("check", err);
      if (this.failPolicy === "closed") {
        // Deny: a security control that cannot verify must not wave traffic
        // through. Give a short, finite retry-after.
        return { allowed: false, remaining: 0, retryAfterSeconds: 5, count: 0 };
      }
      return DECISION_ALLOWED(rule);
    }
  }

  /** Pre-fingerprinted variant for callers that already fingerprinted (avoids
   *  double-hashing). Used by the brute-force module which keys by both IP and
   *  account and wants matching fingerprints across hit/block/reset. */
  async hitFingerprinted(scope: string, fp: string, rule: AbuseRule): Promise<AbuseDecision> {
    if (!this.enabled) return DECISION_ALLOWED(rule);
    const key = this.composeKey(scope, fp);
    const started = Date.now();
    try {
      this.recordOp("check");
      const decision = await this.backend.check(key, rule, this.clock());
      this.observeLatency(Date.now() - started);
      return decision;
    } catch (err) {
      this.observeLatency(Date.now() - started);
      this.onBackendError("check", err);
      if (this.failPolicy === "closed") {
        return { allowed: false, remaining: 0, retryAfterSeconds: 5, count: 0 };
      }
      return DECISION_ALLOWED(rule);
    }
  }

  /**
   * Non-counting probe: seconds remaining on an active penalty block for
   * `scope`+fingerprint (0 = not blocked). On backend error this returns 0 (a
   * probe cannot by itself deny — the subsequent counting `hit` applies the
   * fail policy), so a Redis blip never permanently locks a user out.
   */
  async blockedForFingerprinted(scope: string, fp: string): Promise<number> {
    if (!this.enabled) return 0;
    try {
      this.recordOp("blockedFor");
      return await this.backend.blockedFor(this.composeKey(scope, fp), this.clock());
    } catch (err) {
      this.onBackendError("blockedFor", err);
      return 0;
    }
  }

  /** Apply an explicit penalty block to `scope`+fingerprint. */
  async blockFingerprinted(scope: string, fp: string, seconds: number): Promise<void> {
    if (!this.enabled) return;
    try {
      this.recordOp("block");
      await this.backend.block(this.composeKey(scope, fp), seconds, this.clock());
    } catch (err) {
      this.onBackendError("block", err);
    }
  }

  /** Clear state for `scope`+fingerprint (e.g. after a successful login). */
  async resetFingerprinted(scope: string, fp: string): Promise<void> {
    try {
      this.recordOp("reset");
      await this.backend.reset(this.composeKey(scope, fp));
    } catch (err) {
      this.onBackendError("reset", err);
    }
  }

  async size(): Promise<number> {
    try {
      return await this.backend.size();
    } catch {
      return 0;
    }
  }

  async clear(): Promise<void> {
    try {
      await this.backend.clear();
    } catch {
      /* best-effort (test isolation helper) */
    }
  }
}

/** Build the backend selected by config. Only the memory backend is
 *  constructed eagerly; the Redis backend is wired lazily in wireRedisBackend()
 *  (called from server startup) so processes that don't use Redis never connect. */
function buildDefaultBackend(): AbuseBackend {
  return new InMemoryAbuseBackend(config.security.abuseGuardMaxKeys);
}

/** Shared process-wide abuse guard. Starts on the in-memory backend; if
 *  ABUSE_BACKEND=redis, server startup swaps in the Redis backend via
 *  abuseGuard.setBackend() after the connection is initialised. Everyone imports
 *  this one stable instance, so the backend swap is seen everywhere. */
export const abuseGuard = new AbuseGuard(
  buildDefaultBackend(),
  config.security.abuseGuardEnabled,
  config.security.abuse.failPolicy,
  config.security.abuse.fingerprintSecret,
);
