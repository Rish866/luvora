import type { Express } from "express";
import request from "supertest";
import { pool } from "../src/db/pool";
import { abuseGuard } from "../src/http/abuseGuard";

/** Truncate all data tables between tests for isolation. */
export async function resetDb(): Promise<void> {
  await pool.query(`
    TRUNCATE security_events, operational_events, background_jobs,
             notification_deliveries, notification_devices,
             notifications, notification_preferences,
             safety_reports, moderation_actions, audit_logs,
             media_reports, message_attachments, media_assets,
             consent_responses, fantasy_players, fantasy_sessions,
             blocks, matches, likes, photos, profiles,
             devices, auth_sessions, users
    RESTART IDENTITY CASCADE;
  `);
  // Clear abuse/brute-force counters so each test starts clean. With the Redis
  // backend this clears only keys under the configured namespace.
  await abuseGuard.clear();
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

// ---- Media test fixtures (Increment 5) ----
// Real images generated with sharp (not downloaded). Keep tiny.
import sharp from "sharp";

/** A small valid JPEG, optionally with EXIF (orientation + marker). */
export async function makeJpeg(
  width = 32,
  height = 24,
  opts: { withExif?: boolean; markerText?: string } = {},
): Promise<Buffer> {
  let pipe = sharp({
    create: { width, height, channels: 3, background: { r: 120, g: 80, b: 200 } },
  });
  if (opts.withExif) {
    pipe = pipe.withMetadata({ orientation: 6 });
  }
  let buf = await pipe.jpeg().toBuffer();
  // Append a harmless trailing marker (after EOI) used by the deterministic
  // test scanner/moderation stubs. sharp/file-type still decode the image.
  if (opts.markerText) {
    buf = Buffer.concat([buf, Buffer.from(opts.markerText, "latin1")]);
  }
  return buf;
}

export async function makePng(width = 16, height = 16): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } },
  })
    .png()
    .toBuffer();
}

export async function makeWebp(width = 20, height = 20): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 9, g: 9, b: 9 } },
  })
    .webp()
    .toBuffer();
}

/**
 * Full upload helper: create intent + PUT bytes via the real API. Returns the
 * media id and the final asset view.
 */
// ---- Admin / safety test fixtures (Increment 6) ----
// TEST-ONLY: seed a role directly in the test database. This is a test fixture,
// NOT an application endpoint — the running app contains no admin-bootstrap
// backdoor. Production admins are provisioned out-of-band (see docs/SECURITY.md).
export async function setUserRole(userId: string, role: string): Promise<void> {
  await pool.query(`UPDATE users SET role = $2 WHERE id = $1`, [userId, role]);
}

/** Read a user's current account/role state directly (for assertions). */
export async function getUserState(
  userId: string,
): Promise<{ role: string; account_status: string; suspended_until: string | null }> {
  const { rows } = await pool.query<{
    role: string;
    account_status: string;
    suspended_until: string | null;
  }>(`SELECT role, account_status, suspended_until FROM users WHERE id = $1`, [userId]);
  return rows[0];
}

export async function uploadImage(
  app: Express,
  u: RegisteredUser,
  data: Buffer,
  mimeType = "image/jpeg",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ mediaId: string; body: any; status: number }> {
  const intent = await request(app)
    .post("/api/media")
    .set(...auth(u.accessToken))
    .send({ filename: "x.jpg", mimeType, sizeBytes: data.length, context: "chat" });
  if (intent.status !== 201) {
    throw new Error(`intent failed: ${intent.status} ${JSON.stringify(intent.body)}`);
  }
  const mediaId = intent.body.data.mediaId;
  const put = await request(app)
    .put(`/api/media/${mediaId}/content`)
    .set(...auth(u.accessToken))
    .set("Content-Type", "application/octet-stream")
    .send(data);
  return { mediaId, body: put.body, status: put.status };
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
