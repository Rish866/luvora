import { randomUUID } from "node:crypto";
import { query, withTransaction } from "../db/pool";

export interface AuthSessionRow {
  id: string;
  family_id: string;
  user_id: string;
  refresh_token_hash: string;
  rotated_at: string | null;
  revoked_at: string | null;
  expires_at: string;
  created_at: string;
}

/** Start a brand-new refresh-token family (called on login/register). */
export async function createAuthSession(input: {
  userId: string;
  refreshTokenHash: string;
  expiresAt: Date;
  userAgent?: string;
  ip?: string;
}): Promise<AuthSessionRow> {
  const rows = await query<AuthSessionRow>(
    `INSERT INTO auth_sessions
       (family_id, user_id, refresh_token_hash, expires_at, user_agent, ip)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      randomUUID(),
      input.userId,
      input.refreshTokenHash,
      input.expiresAt.toISOString(),
      input.userAgent ?? null,
      input.ip ?? null,
    ],
  );
  return rows[0];
}

export async function findByTokenHash(
  hash: string,
): Promise<AuthSessionRow | null> {
  const rows = await query<AuthSessionRow>(
    `SELECT * FROM auth_sessions WHERE refresh_token_hash = $1`,
    [hash],
  );
  return rows[0] ?? null;
}

/**
 * Rotate a token: mark the current row rotated and insert a new row in the SAME
 * family, atomically. Returns the new row.
 */
export async function rotateSession(
  current: AuthSessionRow,
  newHash: string,
  newExpiresAt: Date,
): Promise<AuthSessionRow> {
  return withTransaction(async (client) => {
    await client.query(
      `UPDATE auth_sessions SET rotated_at = now() WHERE id = $1`,
      [current.id],
    );
    const { rows } = await client.query<AuthSessionRow>(
      `INSERT INTO auth_sessions
         (family_id, user_id, refresh_token_hash, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [current.family_id, current.user_id, newHash, newExpiresAt.toISOString()],
    );
    return rows[0];
  });
}

export async function revokeSession(id: string): Promise<void> {
  await query(
    `UPDATE auth_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
    [id],
  );
}

/** Revoke an entire family (used when token reuse/theft is detected). */
export async function revokeFamily(familyId: string): Promise<void> {
  await query(
    `UPDATE auth_sessions SET revoked_at = now()
      WHERE family_id = $1 AND revoked_at IS NULL`,
    [familyId],
  );
}

/** Revoke every session for a user (password reset, account disable). */
export async function revokeAllForUser(userId: string): Promise<void> {
  await query(
    `UPDATE auth_sessions SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
}
