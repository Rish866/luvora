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

/** Insert a block directly (for test setup). */
export async function insertBlock(
  blockerId: string,
  blockedId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)
     ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
    [blockerId, blockedId],
  );
}

/** Insert a discovery decision directly (for test setup). */
export async function insertDecision(
  likerId: string,
  likeeId: string,
  isPass: boolean,
): Promise<void> {
  await pool.query(
    `INSERT INTO likes (liker_id, likee_id, is_pass) VALUES ($1, $2, $3)
     ON CONFLICT (liker_id, likee_id) DO UPDATE SET is_pass = EXCLUDED.is_pass`,
    [likerId, likeeId, isPass],
  );
}

/**
 * Drive two users through the full invite -> accept -> consent flow until the
 * session is PLAYING, agreeing to the given consent categories (both say YES to
 * all of them). Returns the session id. Uses the real API via supertest.
 */
export async function createPlayingSession(
  app: Express,
  a: RegisteredUser,
  b: RegisteredUser,
  matchId: string,
  consentCategories: string[] = ["flirting", "teasing", "roleplay", "mystery"],
): Promise<string> {
  const invite = await request(app)
    .post("/api/sessions/invite")
    .set(...auth(a.accessToken))
    .send({ matchId, scenarioId: "placeholder", scenarioVersion: "v1" });
  if (invite.status !== 201) {
    throw new Error(`invite failed: ${invite.status} ${JSON.stringify(invite.body)}`);
  }
  const sessionId = invite.body.data.sessionId;

  const accept = await request(app)
    .post(`/api/sessions/${sessionId}/accept`)
    .set(...auth(b.accessToken))
    .send();
  if (accept.status !== 200) {
    throw new Error(`accept failed: ${accept.status} ${JSON.stringify(accept.body)}`);
  }

  const responses = consentCategories.map((category) => ({ category, response: "YES" }));
  for (const user of [a, b]) {
    const r = await request(app)
      .post(`/api/sessions/${sessionId}/consent`)
      .set(...auth(user.accessToken))
      .send({ responses, agreeToParticipate: true });
    if (r.status !== 200) {
      throw new Error(`consent failed: ${r.status} ${JSON.stringify(r.body)}`);
    }
  }
  return sessionId;
}
