import { z } from "zod";
import { Errors } from "../http/errors";
import { hashPassword, verifyPassword } from "./password";
import { meetsMinimumAge } from "./age";
import {
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
} from "./tokens";
import * as users from "../users/userRepository";
import * as sessions from "./authSessionRepository";
import { assertAccountActive } from "./accountState";
import { config } from "../config";
import {
  checkLoginAllowed,
  recordLoginFailure,
  clearLoginFailures,
} from "./bruteForce";
import { recordSecurityEvent } from "../security/securityEvents";
import { SecurityEventType, SecuritySeverity } from "@luvora/shared";

/** ---- Validation schemas ---- */

export const registerSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(128),
  displayName: z.string().min(1).max(50),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "dateOfBirth must be YYYY-MM-DD"),
  // The 18+ attestation checkbox. Required to be true, but NOT trusted on its
  // own — dateOfBirth must independently prove age.
  ageConfirmed: z.literal(true, {
    errorMap: () => ({ message: "You must confirm you are 18 or older." }),
  }),
});

export const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresIn: number;
}

export interface AuthResult extends AuthTokens {
  userId: string;
}

function issueTokens(userId: string): {
  accessToken: string;
  refreshToken: string;
  refreshHash: string;
  refreshExpiresAt: Date;
} {
  const accessToken = signAccessToken(userId);
  const { token: refreshToken, hash: refreshHash } = generateRefreshToken();
  const refreshExpiresAt = new Date(
    Date.now() + config.jwt.refreshTtlSeconds * 1000,
  );
  return { accessToken, refreshToken, refreshHash, refreshExpiresAt };
}

export async function register(
  input: RegisterInput,
  ctx: { userAgent?: string; ip?: string } = {},
): Promise<AuthResult> {
  const dob = new Date(`${input.dateOfBirth}T00:00:00Z`);
  if (Number.isNaN(dob.getTime())) {
    throw Errors.validation("Invalid date of birth.");
  }
  // SERVER-SIDE AGE GATE — the real enforcement point.
  if (!meetsMinimumAge(dob)) {
    throw Errors.ageRestricted();
  }

  const existing = await users.findByEmail(input.email);
  if (existing) {
    // Don't reveal whether the email exists beyond a generic conflict.
    throw Errors.conflict("An account could not be created with those details.");
  }

  const passwordHash = await hashPassword(input.password);
  const user = await users.createUser({
    email: input.email,
    passwordHash,
    dateOfBirth: input.dateOfBirth,
    displayName: input.displayName,
  });

  const t = issueTokens(user.id);
  await sessions.createAuthSession({
    userId: user.id,
    refreshTokenHash: t.refreshHash,
    expiresAt: t.refreshExpiresAt,
    userAgent: ctx.userAgent,
    ip: ctx.ip,
  });

  return {
    userId: user.id,
    accessToken: t.accessToken,
    refreshToken: t.refreshToken,
    accessExpiresIn: config.jwt.accessTtlSeconds,
  };
}

export async function login(
  input: LoginInput,
  ctx: { userAgent?: string; ip?: string } = {},
): Promise<AuthResult> {
  // BRUTE-FORCE GATE (Increment 11): if this IP or this account is currently
  // throttled from repeated failures, reject BEFORE touching the password hash
  // — this also removes the bcrypt cost as an amplification vector. Temporary,
  // not a permanent lockout.
  const gate = checkLoginAllowed(ctx.ip, input.email);
  if (!gate.allowed) {
    await recordSecurityEvent({
      eventType: SecurityEventType.LOGIN_THROTTLED,
      severity: SecuritySeverity.WARNING,
      category: "auth",
      source: ctx.ip,
      metadata: { retryAfterSeconds: gate.retryAfterSeconds },
    });
    // Opaque to avoid revealing which dimension tripped / whether the account
    // exists; the Retry-After header is emitted by the error handler.
    throw Errors.rateLimited("Too many attempts. Try again later.").withRetryAfter(
      gate.retryAfterSeconds,
    );
  }

  const user = await users.findByEmail(input.email);
  // Always run a hash comparison to reduce user-enumeration timing signals.
  const hash = user?.password_hash ?? "$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinv";
  const valid = await verifyPassword(input.password, hash);

  if (!user || !valid) {
    // Count the failure on both IP + account dimensions (may trigger a block).
    await recordLoginFailure(ctx.ip, input.email, user?.id ?? null);
    throw Errors.unauthenticated("Invalid email or password.");
  }
  if (user.is_disabled) {
    throw Errors.unauthorized("This account has been disabled.");
  }
  // Enforce account state (Increment 6). assertAccountActive auto-lapses an
  // expired suspension, and throws ACCOUNT_SUSPENDED / ACCOUNT_DEACTIVATED
  // otherwise — a suspended/deactivated user cannot obtain new tokens.
  await assertAccountActive(user.id);

  // Successful authentication clears the failure counters for both dimensions.
  clearLoginFailures(ctx.ip, input.email);

  const t = issueTokens(user.id);
  await sessions.createAuthSession({
    userId: user.id,
    refreshTokenHash: t.refreshHash,
    expiresAt: t.refreshExpiresAt,
    userAgent: ctx.userAgent,
    ip: ctx.ip,
  });

  return {
    userId: user.id,
    accessToken: t.accessToken,
    refreshToken: t.refreshToken,
    accessExpiresIn: config.jwt.accessTtlSeconds,
  };
}

/**
 * Refresh-token rotation with reuse detection.
 *  - Valid, un-rotated, un-revoked, unexpired token => rotate + issue new pair.
 *  - Reuse of an already-rotated token => treat as theft => revoke all sessions
 *    for that user.
 */
export async function refresh(
  refreshToken: string,
): Promise<AuthTokens> {
  const hash = hashRefreshToken(refreshToken);
  const session = await sessions.findByTokenHash(hash);

  if (!session) {
    throw Errors.unauthenticated("Invalid refresh token.");
  }
  if (session.rotated_at) {
    // The presented token was already exchanged once. Legitimate clients never
    // reuse a token, so this indicates theft/replay. Revoke the whole family.
    await sessions.revokeFamily(session.family_id);
    // Durable, high-signal security event (token theft indicator). Best-effort.
    await recordSecurityEvent({
      eventType: SecurityEventType.REFRESH_TOKEN_REUSE,
      severity: SecuritySeverity.CRITICAL,
      userId: session.user_id,
      category: "auth",
      metadata: { familyId: session.family_id },
    });
    throw Errors.unauthenticated("Refresh token reuse detected.");
  }
  if (session.revoked_at) {
    throw Errors.unauthenticated("Refresh token revoked.");
  }
  if (new Date(session.expires_at).getTime() < Date.now()) {
    throw Errors.unauthenticated("Refresh token expired.");
  }
  // Enforce account state on refresh too, so a suspended/deactivated user
  // cannot keep rotating tokens. (Sessions are also revoked on suspend; this is
  // defense in depth and handles any race.)
  await assertAccountActive(session.user_id);

  const t = issueTokens(session.user_id);
  await sessions.rotateSession(session, t.refreshHash, t.refreshExpiresAt);

  return {
    accessToken: t.accessToken,
    refreshToken: t.refreshToken,
    accessExpiresIn: config.jwt.accessTtlSeconds,
  };
}

export async function logout(refreshToken: string): Promise<void> {
  const hash = hashRefreshToken(refreshToken);
  const session = await sessions.findByTokenHash(hash);
  if (session && !session.revoked_at) {
    await sessions.revokeSession(session.id);
  }
}
