import { abuseGuard } from "../http/abuseGuard";
import { config } from "../config";
import { metrics } from "../observability/metrics";
import { recordSecurityEvent } from "../security/securityEvents";
import { SecurityEventType, SecuritySeverity } from "@luvora/shared";

/**
 * Brute-force / credential-stuffing protection for login (Increment 11,
 * distributed in Increment 12).
 *
 * Tracks failed logins on TWO dimensions — client IP and target account (email,
 * lowercased) — so an attacker cannot bypass by rotating one dimension. After
 * `maxFailures` within the window, that dimension is throttled for
 * `throttleSeconds`. A successful login clears both dimensions' failure state.
 *
 * This is TEMPORARY throttling, not a permanent lockout (which could be
 * weaponised for denial of service against a victim account).
 *
 * DISTRIBUTION (Increment 12): when ABUSE_BACKEND=redis, this protection is
 * ENFORCED ACROSS ALL INSTANCES — an attacker cannot bypass the IP/account
 * failure limits by alternating requests between API instances. The IP and
 * email are HMAC-fingerprinted by the guard before they ever reach Redis, so no
 * raw PII is stored. With the memory backend it is process-local.
 */

const SCOPE_IP = "login-fail";
const SCOPE_ACCOUNT = "login-fail-acct";

function accountKey(email: string): string {
  return email.trim().toLowerCase();
}

/** Fingerprint the two dimensions once so hit/block/reset/probe all share the
 *  same backend keys. */
function dims(ip: string | undefined, email: string) {
  return [
    { scope: SCOPE_IP, fp: abuseGuard.fingerprint(ip ?? "unknown"), dim: "ip" as const, ip },
    { scope: SCOPE_ACCOUNT, fp: abuseGuard.fingerprint(accountKey(email)), dim: "account" as const, ip: undefined },
  ];
}

/** Call BEFORE verifying credentials. Returns a throttle decision; when
 *  throttled the caller should reject without checking the password. */
export async function checkLoginAllowed(
  ip: string | undefined,
  email: string,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  // Non-counting probe of the penalty block set once a dimension crosses its
  // failure threshold (see recordLoginFailure). We never COUNT here — only
  // genuine failures increment the window — so a throttled attacker cannot
  // extend their own block by polling, and a legitimate user is unaffected.
  for (const { scope, fp } of dims(ip, email)) {
    const remaining = await abuseGuard.blockedForFingerprinted(scope, fp);
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
  for (const { scope, fp, dim, ip: dimIp } of dims(ip, email)) {
    const decision = await abuseGuard.hitFingerprinted(scope, fp, rule);
    if (!decision.allowed || decision.remaining === 0) {
      // Threshold reached (or exceeded) → temporary block + security event.
      await abuseGuard.blockFingerprinted(scope, fp, config.security.login.throttleSeconds);
      metrics.incr("auth_throttled_total", { dimension: dim });
      await recordSecurityEvent({
        eventType: SecurityEventType.BRUTE_FORCE_LOCKOUT,
        severity: SecuritySeverity.WARNING,
        category: "auth",
        userId: dim === "account" ? userId : null,
        source: dim === "ip" ? dimIp : null,
        metadata: { dimension: dim, throttleSeconds: config.security.login.throttleSeconds },
      });
    }
  }
}

/** Clear failure state for both dimensions after a successful authentication. */
export async function clearLoginFailures(ip: string | undefined, email: string): Promise<void> {
  for (const { scope, fp } of dims(ip, email)) {
    await abuseGuard.resetFingerprinted(scope, fp);
  }
}
