import { abuseGuard } from "../http/abuseGuard";
import { config } from "../config";
import { metrics } from "../observability/metrics";
import { recordSecurityEvent } from "../security/securityEvents";
import { SecurityEventType, SecuritySeverity } from "@luvora/shared";

/**
 * Brute-force / credential-stuffing protection for login (Increment 11).
 *
 * Tracks failed logins on TWO dimensions — client IP and target account (email,
 * lowercased) — so an attacker cannot bypass by rotating one dimension. After
 * `maxFailures` within the window, that dimension is throttled for
 * `throttleSeconds`. A successful login clears both dimensions' failure state.
 *
 * This is TEMPORARY throttling, not a permanent lockout (which could be
 * weaponised for denial of service against a victim account). It is process-
 * local (AbuseGuard) — not globally distributed.
 */

const SCOPE_IP = "login-fail";
const SCOPE_ACCOUNT = "login-fail-acct";

function accountKey(email: string): string {
  return email.trim().toLowerCase();
}

/** Call BEFORE verifying credentials. Returns a throttle decision; when
 *  throttled the caller should reject without checking the password. */
export function checkLoginAllowed(
  ip: string | undefined,
  email: string,
): { allowed: boolean; retryAfterSeconds: number } {
  // Non-counting probe of the penalty block set once a dimension crosses its
  // failure threshold (see recordLoginFailure). We never COUNT here — only
  // genuine failures increment the window — so a throttled attacker cannot
  // extend their own block by polling, and a legitimate user is unaffected.
  for (const [scope, key] of [
    [SCOPE_IP, ip ?? "unknown"],
    [SCOPE_ACCOUNT, accountKey(email)],
  ] as const) {
    const remaining = abuseGuard.blockedFor(scope, key);
    if (remaining > 0) {
      return { allowed: false, retryAfterSeconds: remaining };
    }
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

/** Record a failed login on both dimensions. When a dimension crosses the
 *  failure threshold, apply a temporary penalty block + a durable security
 *  event (lockout triggered). */
export async function recordLoginFailure(
  ip: string | undefined,
  email: string,
  userId: string | null,
): Promise<void> {
  metrics.incr("auth_failures_total", { kind: "login" });
  const rule = {
    limit: config.security.login.maxFailures,
    windowMs: config.security.login.failureWindowSeconds * 1000,
  };
  const dims: Array<{ scope: string; key: string; dim: string }> = [
    { scope: SCOPE_IP, key: ip ?? "unknown", dim: "ip" },
    { scope: SCOPE_ACCOUNT, key: accountKey(email), dim: "account" },
  ];
  for (const { scope, key, dim } of dims) {
    const decision = abuseGuard.hit(scope, key, rule);
    if (!decision.allowed || decision.remaining === 0) {
      // Threshold reached (or exceeded) → temporary block + security event.
      abuseGuard.block(scope, key, config.security.login.throttleSeconds);
      metrics.incr("auth_throttled_total", { dimension: dim });
      await recordSecurityEvent({
        eventType: SecurityEventType.BRUTE_FORCE_LOCKOUT,
        severity: SecuritySeverity.WARNING,
        category: "auth",
        userId: dim === "account" ? userId : null,
        source: dim === "ip" ? ip : null,
        metadata: { dimension: dim, throttleSeconds: config.security.login.throttleSeconds },
      });
    }
  }
}

/** Clear failure state for both dimensions after a successful authentication. */
export function clearLoginFailures(ip: string | undefined, email: string): void {
  abuseGuard.reset(SCOPE_IP, ip ?? "unknown");
  abuseGuard.reset(SCOPE_ACCOUNT, accountKey(email));
}
