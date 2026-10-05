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
