import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { config } from "../config";

export interface AccessTokenClaims {
  sub: string; // user id
  type: "access";
}

/** Sign a short-lived access JWT. */
export function signAccessToken(userId: string): string {
  const claims: AccessTokenClaims = { sub: userId, type: "access" };
  return jwt.sign(claims, config.jwt.accessSecret, {
    expiresIn: config.jwt.accessTtlSeconds,
  });
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  const decoded = jwt.verify(token, config.jwt.accessSecret) as AccessTokenClaims;
  if (decoded.type !== "access") {
    throw new Error("Wrong token type");
  }
  return decoded;
}

/**
 * Refresh tokens are opaque high-entropy strings (not JWTs). We store only a
 * SHA-256 hash in the DB, so a database leak never yields usable tokens.
 */
export function generateRefreshToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(48).toString("base64url");
  const hash = hashRefreshToken(token);
  return { token, hash };
}

export function hashRefreshToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
