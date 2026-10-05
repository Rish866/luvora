import { query, withTransaction } from "../db/pool";

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  date_of_birth: string; // ISO date
  age_confirmed_at: string | null;
  email_verified_at: string | null;
  is_disabled: boolean;
  created_at: string;
  deleted_at: string | null;
  // Increment 6: role + account state.
  role: string;
  account_status: string;
  suspended_until: string | null;
  suspension_reason: string | null;
}

export async function findByEmail(email: string): Promise<UserRow | null> {
  const rows = await query<UserRow>(
    `SELECT * FROM users WHERE lower(email) = lower($1) AND deleted_at IS NULL`,
    [email],
  );
  return rows[0] ?? null;
}

export async function findById(id: string): Promise<UserRow | null> {
  const rows = await query<UserRow>(
    `SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return rows[0] ?? null;
}

/** Create a user and their (minimal) profile atomically. */
export async function createUser(input: {
  email: string;
  passwordHash: string;
  dateOfBirth: string;
  displayName: string;
}): Promise<UserRow> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<UserRow>(
      `INSERT INTO users (email, password_hash, date_of_birth, age_confirmed_at)
       VALUES ($1, $2, $3, now())
       RETURNING *`,
      [input.email, input.passwordHash, input.dateOfBirth],
    );
    const user = rows[0];
    await client.query(
      `INSERT INTO profiles (user_id, display_name) VALUES ($1, $2)`,
      [user.id, input.displayName],
    );
    return user;
  });
}

// ---- Increment 6: role + account state ----

/** Set a user's role (server-side only; validated by the admin service). */
export async function setRole(userId: string, role: string): Promise<void> {
  await query(`UPDATE users SET role = $2 WHERE id = $1`, [userId, role]);
}

/** Count active (non-deleted) users with a given role. Used to protect against
 *  removing the last admin. */
export async function countByRole(role: string): Promise<number> {
  const rows = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM users
      WHERE role = $1 AND deleted_at IS NULL AND account_status <> 'DEACTIVATED'`,
    [role],
  );
  return rows[0]?.n ?? 0;
}

/** Apply a suspension (SUSPENDED with optional expiry). */
export async function suspendUser(
  userId: string,
  suspendedUntil: Date | null,
  reason: string,
): Promise<void> {
  await query(
    `UPDATE users
        SET account_status = 'SUSPENDED',
            suspended_until = $2,
            suspension_reason = $3
      WHERE id = $1`,
    [userId, suspendedUntil ? suspendedUntil.toISOString() : null, reason],
  );
}

/** Lift a suspension, returning the user to ACTIVE. */
export async function unsuspendUser(userId: string): Promise<void> {
  await query(
    `UPDATE users
        SET account_status = 'ACTIVE', suspended_until = NULL, suspension_reason = NULL
      WHERE id = $1`,
    [userId],
  );
}

export async function deactivateUser(userId: string, reason: string): Promise<void> {
  await query(
    `UPDATE users
        SET account_status = 'DEACTIVATED', suspension_reason = $2
      WHERE id = $1`,
    [userId, reason],
  );
}

export async function reactivateUser(userId: string): Promise<void> {
  await query(
    `UPDATE users
        SET account_status = 'ACTIVE', suspended_until = NULL, suspension_reason = NULL
      WHERE id = $1`,
    [userId],
  );
}

/** Auto-lapse an expired suspension back to ACTIVE. Returns true if lapsed. */
export async function lapseExpiredSuspension(userId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE users
        SET account_status = 'ACTIVE', suspended_until = NULL, suspension_reason = NULL
      WHERE id = $1
        AND account_status = 'SUSPENDED'
        AND suspended_until IS NOT NULL
        AND suspended_until <= now()
      RETURNING id`,
    [userId],
  );
  return rows.length > 0;
}
