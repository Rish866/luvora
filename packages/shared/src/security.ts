/**
 * Security-event shared types (Increment 11).
 *
 * Durable, low-volume security/forensics events (brute-force lockout, token
 * reuse, repeated unauthorized access, insecure-config detection). High-
 * frequency abuse counters are process-local (AbuseGuard) and are NOT
 * represented here.
 */

export enum SecurityEventType {
  LOGIN_THROTTLED = "LOGIN_THROTTLED",
  BRUTE_FORCE_LOCKOUT = "BRUTE_FORCE_LOCKOUT",
  REFRESH_TOKEN_REUSE = "REFRESH_TOKEN_REUSE",
  SUSPENDED_LOGIN_ATTEMPT = "SUSPENDED_LOGIN_ATTEMPT",
  WS_CONNECTION_REJECTED = "WS_CONNECTION_REJECTED",
  WS_ABUSE_THROTTLED = "WS_ABUSE_THROTTLED",
  OVERSIZED_REQUEST = "OVERSIZED_REQUEST",
  INSECURE_CONFIG = "INSECURE_CONFIG",
}

export enum SecuritySeverity {
  INFO = "INFO",
  WARNING = "WARNING",
  ERROR = "ERROR",
  CRITICAL = "CRITICAL",
}

/** Safe, admin-facing security-event DTO. Never contains raw IPs, tokens, or
 *  secrets — only a source fingerprint + sanitized metadata. */
export interface SecurityEventView {
  id: string;
  userId: string | null;
  eventType: SecurityEventType | string;
  severity: SecuritySeverity | string;
  category: string | null;
  sourceFingerprint: string | null;
  correlationId: string | null;
  metadata: Record<string, string | number | boolean | null>;
  createdAt: string;
}

/** Default retention for durable security events (days). */
export const SECURITY_EVENT_RETENTION_DAYS = 90;
