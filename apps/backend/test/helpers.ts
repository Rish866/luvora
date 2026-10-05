import type { Express } from "express";
import request from "supertest";
import { pool } from "../src/db/pool";

/** Truncate all data tables between tests for isolation. */
export async function resetDb(): Promise<void> {
  await pool.query(`
    TRUNCATE consent_responses, fantasy_players, fantasy_sessions,
             blocks, matches, likes, photos, profiles,
             devices, auth_sessions, users
    RESTART IDENTITY CASCADE;
  `);
}

export interface RegisteredUser {
  userId: string;
  accessToken: string;
  refreshToken: string;
  email: string;
}

let counter = 0;

/** Register a fresh adult user via the real API and return their tokens. */
export async function registerUser(
  app: Express,
  overrides: Partial<{ email: string; dateOfBirth: string; displayName: string }> = {},
): Promise<RegisteredUser> {
  counter += 1;
  const email = overrides.email ?? `user${counter}.${Date.now()}@example.com`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({
      email,
      password: "Passw0rd!test",
      displayName: overrides.displayName ?? `User${counter}`,
      dateOfBirth: overrides.dateOfBirth ?? "1995-01-01",
      ageConfirmed: true,
    });
  if (res.status !== 201) {
    throw new Error(`registerUser failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return {
    userId: res.body.data.userId,
    accessToken: res.body.data.accessToken,
    refreshToken: res.body.data.refreshToken,
    email,
  };
}

/** Create an ACTIVE match between two users directly (bypassing discovery,
 *  which arrives in a later increment). */
export async function createMatch(a: string, b: string): Promise<string> {
  const [ua, ub] = [a, b].sort();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO matches (user_a, user_b, state) VALUES ($1, $2, 'ACTIVE') RETURNING id`,
    [ua, ub],
  );
  return rows[0].id;
}

export function auth(token: string): [string, string] {
  return ["Authorization", `Bearer ${token}`];
}
