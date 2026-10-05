import type { Request, Response, NextFunction, RequestHandler } from "express";
import { abuseGuard, type AbuseRule } from "./abuseGuard";
import { Errors } from "./errors";
import { metrics } from "../observability/metrics";
import { log } from "../observability/logger";

/**
 * Express middleware factory over the shared AbuseGuard (Increment 11).
 *
 * Keys a limit by a bounded, server-derived dimension (client IP and/or the
 * authenticated user id). Where both are available we check BOTH so an attacker
 * cannot bypass by rotating one dimension. On throttle: standard RATE_LIMITED
 * envelope + `Retry-After` header + a bounded metric (scope only — never IP/
 * user/token in a label).
 */

/** Derive the client IP honouring the configured trusted-proxy depth. Express's
 *  `req.ip` already reflects `trust proxy`; we fall back to the socket address.
 *  Never trusts raw forwarded headers when no proxy is trusted. */
export function clientIp(req: Request): string {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

export interface AbuseGuardOptions {
  scope: string;
  rule: AbuseRule;
  /** Which dimensions to key on. Defaults to IP. */
  by?: Array<"ip" | "user">;
}

/**
 * Shared, conservative per-user abuse rules for write/action endpoints
 * (Increment 11). Keyed by user so they are effective even under test, where
 * the legacy express-rate-limit is intentionally disabled. These are generous
 * enough never to affect normal interactive use but cap scripted abuse (spam
 * likes/messages/invites). All values are process-local — see
 * docs/SECURITY.md: rate limiting is process-local unless a distributed backend
 * is configured.
 */
export const AbuseRules = {
  /** Discovery like/pass/block — swipe-style actions. */
  discoveryAction: { limit: 120, windowMs: 60_000 } as AbuseRule,
  /** Chat message send. */
  chatSend: { limit: 60, windowMs: 60_000 } as AbuseRule,
  /** Fantasy session create. */
  sessionCreate: { limit: 30, windowMs: 60_000 } as AbuseRule,
  /** Fantasy session invite. */
  sessionInvite: { limit: 60, windowMs: 60_000 } as AbuseRule,
  /** Notification preference writes. */
  prefWrite: { limit: 60, windowMs: 60_000 } as AbuseRule,
} as const;

export function abuseLimit(opts: AbuseGuardOptions): RequestHandler {
  const by = opts.by ?? ["ip"];
  return (req: Request, res: Response, next: NextFunction): void => {
    const keys: Array<{ dim: string; key: string }> = [];
    if (by.includes("ip")) keys.push({ dim: "ip", key: clientIp(req) });
    if (by.includes("user") && req.userId) keys.push({ dim: "user", key: req.userId });

    for (const { dim, key } of keys) {
      const decision = abuseGuard.hit(`${opts.scope}:${dim}`, key, opts.rule);
      if (!decision.allowed) {
        res.setHeader("Retry-After", String(decision.retryAfterSeconds));
        try {
          metrics.incr("rate_limit_hits_total", { scope: opts.scope, dimension: dim });
        } catch {
          /* telemetry best-effort */
        }
        log.warn({ scope: opts.scope, dimension: dim }, "rate_limit.throttled");
        next(Errors.rateLimited());
        return;
      }
    }
    next();
  };
}
