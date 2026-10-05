import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app";
import { closePool, pool } from "../src/db/pool";
import {
  resetDb,
  registerUser,
  auth,
  insertBlock,
  insertDecision,
  type RegisteredUser,
} from "./helpers";

let app: Express;

beforeAll(() => {
  app = createApp();
});
beforeEach(async () => {
  await resetDb();
});
afterAll(async () => {
  await closePool();
});

// Convenience wrappers -------------------------------------------------------
const feed = (u: RegisteredUser, qs = "") =>
  request(app).get(`/api/discovery${qs}`).set(...auth(u.accessToken));
const like = (u: RegisteredUser, targetId: string) =>
  request(app).post(`/api/discovery/${targetId}/like`).set(...auth(u.accessToken));
const pass = (u: RegisteredUser, targetId: string) =>
  request(app).post(`/api/discovery/${targetId}/pass`).set(...auth(u.accessToken));
const block = (u: RegisteredUser, targetId: string) =>
  request(app).post(`/api/users/${targetId}/block`).set(...auth(u.accessToken));
const unblock = (u: RegisteredUser, targetId: string) =>
  request(app).delete(`/api/users/${targetId}/block`).set(...auth(u.accessToken));
const matchList = (u: RegisteredUser) =>
  request(app).get("/api/matches").set(...auth(u.accessToken));

function idsIn(feedRes: { body: { data: { candidates: { id: string }[] } } }): string[] {
  return feedRes.body.data.candidates.map((c) => c.id);
}

// ---------------------------------------------------------------------------
describe("discovery feed", () => {
  it("1. authenticated user can retrieve discovery", async () => {
    const a = await registerUser(app);
    await registerUser(app);
    const res = await feed(a);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.candidates)).toBe(true);
  });

  it("2. unauthenticated user cannot", async () => {
    const res = await request(app).get("/api/discovery");
    expect(res.status).toBe(401);
  });

  it("3. self is excluded", async () => {
    const a = await registerUser(app);
    await registerUser(app);
    const res = await feed(a);
    expect(idsIn(res)).not.toContain(a.userId);
  });

  it("4. already-liked users are excluded", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await like(a, b.userId);
    const res = await feed(a);
    expect(idsIn(res)).not.toContain(b.userId);
  });

  it("5. already-passed users are excluded", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await pass(a, b.userId);
    const res = await feed(a);
    expect(idsIn(res)).not.toContain(b.userId);
  });

  it("6. blocked users are excluded (A blocked B)", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await block(a, b.userId);
    const res = await feed(a);
    expect(idsIn(res)).not.toContain(b.userId);
  });

  it("7. users who blocked the caller are excluded (B blocked A)", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await insertBlock(b.userId, a.userId); // B blocks A
    const res = await feed(a);
    expect(idsIn(res)).not.toContain(b.userId);
  });

  it("8. existing matches are excluded", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await like(a, b.userId);
    await like(b, a.userId); // mutual -> match
    const res = await feed(a);
    expect(idsIn(res)).not.toContain(b.userId);
  });

  it("9. pagination works (deterministic, non-overlapping pages)", async () => {
    const a = await registerUser(app);
    // Create several candidates.
    for (let i = 0; i < 5; i++) await registerUser(app);
    const p1 = await feed(a, "?limit=2");
    expect(p1.body.data.candidates).toHaveLength(2);
    expect(p1.body.data.nextCursor).toBeTruthy();
    const p2 = await feed(a, `?limit=2&cursor=${encodeURIComponent(p1.body.data.nextCursor)}`);
    expect(p2.body.data.candidates).toHaveLength(2);
    // No overlap between pages.
    const overlap = idsIn(p1).filter((id) => idsIn(p2).includes(id));
    expect(overlap).toHaveLength(0);
  });

  it("10. invalid pagination is rejected", async () => {
    const a = await registerUser(app);
    const tooBig = await feed(a, "?limit=1000");
    expect(tooBig.status).toBe(400);
    const zero = await feed(a, "?limit=0");
    expect(zero.status).toBe(400);
    const badCursor = await feed(a, "?cursor=not-a-valid-cursor");
    expect(badCursor.status).toBe(400);
  });
});

describe("like", () => {
  it("11. like creates a decision (matched=false, no reciprocal)", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    const res = await like(a, b.userId);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      action: "LIKE",
      userId: b.userId,
      matched: false,
      matchId: null,
    });
  });

  it("12. duplicate like is idempotent (single row, no error)", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await like(a, b.userId);
    const second = await like(a, b.userId);
    expect(second.status).toBe(200);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM likes WHERE liker_id = $1 AND likee_id = $2`,
      [a.userId, b.userId],
    );
    expect(rows[0].n).toBe(1);
  });

  it("13. self-like rejected", async () => {
    const a = await registerUser(app);
    const res = await like(a, a.userId);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("CANNOT_INTERACT_WITH_SELF");
  });

  it("14. nonexistent user rejected", async () => {
    const a = await registerUser(app);
    const res = await like(a, "00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("USER_NOT_FOUND");
  });

  it("15. blocked target rejected (A blocked B then likes B)", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await block(a, b.userId);
    const res = await like(a, b.userId);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("INTERACTION_NOT_ALLOWED");
  });

  it("16. blocked-by-target rejected (B blocked A then A likes B)", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await insertBlock(b.userId, a.userId);
    const res = await like(a, b.userId);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("INTERACTION_NOT_ALLOWED");
  });
});

describe("pass", () => {
  it("17. pass creates a decision", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    const res = await pass(a, b.userId);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ action: "PASS", matched: false, matchId: null });
    const { rows } = await pool.query(
      `SELECT is_pass FROM likes WHERE liker_id = $1 AND likee_id = $2`,
      [a.userId, b.userId],
    );
    expect(rows[0].is_pass).toBe(true);
  });

  it("18. duplicate pass is idempotent", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await pass(a, b.userId);
    await pass(a, b.userId);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM likes WHERE liker_id = $1 AND likee_id = $2`,
      [a.userId, b.userId],
    );
    expect(rows[0].n).toBe(1);
  });

  it("19. passed user disappears from discovery", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await pass(a, b.userId);
    expect(idsIn(await feed(a))).not.toContain(b.userId);
  });

  it("20. self-pass rejected", async () => {
    const a = await registerUser(app);
    const res = await pass(a, a.userId);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("CANNOT_INTERACT_WITH_SELF");
  });
});

describe("mutual matching", () => {
  it("21. A likes B -> no match yet", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    const res = await like(a, b.userId);
    expect(res.body.data.matched).toBe(false);
  });

  it("22. B likes A -> exactly one match", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await like(a, b.userId);
    const res = await like(b, a.userId);
    expect(res.body.data.matched).toBe(true);
    expect(res.body.data.matchId).toBeTruthy();
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM matches`);
    expect(rows[0].n).toBe(1);
  });

  it("23. match appears in both users' match lists", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await like(a, b.userId);
    const m = await like(b, a.userId);
    const matchId = m.body.data.matchId;

    const la = await matchList(a);
    const lb = await matchList(b);
    expect(la.body.data.matches.map((x: { matchId: string }) => x.matchId)).toContain(matchId);
    expect(lb.body.data.matches.map((x: { matchId: string }) => x.matchId)).toContain(matchId);
    // A's list shows B as the other user, and vice versa.
    expect(la.body.data.matches[0].user.id).toBe(b.userId);
    expect(lb.body.data.matches[0].user.id).toBe(a.userId);
  });

  it("24. matched users do not appear in discovery", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await like(a, b.userId);
    await like(b, a.userId);
    expect(idsIn(await feed(a))).not.toContain(b.userId);
    expect(idsIn(await feed(b))).not.toContain(a.userId);
  });

  it("25. duplicate reciprocal requests do not create duplicate matches", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await like(a, b.userId);
    await like(b, a.userId);
    await like(a, b.userId); // repeat
    await like(b, a.userId); // repeat
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM matches`);
    expect(rows[0].n).toBe(1);
  });
});

describe("race condition", () => {
  it("concurrent reciprocal likes create exactly one match", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    // Fire both reciprocal likes simultaneously.
    const [r1, r2] = await Promise.all([
      like(a, b.userId),
      like(b, a.userId),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    // Exactly one match row regardless of interleaving.
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM matches`);
    expect(rows[0].n).toBe(1);
    // At least one of the responses reports the match; both match lists show 1.
    const la = await matchList(a);
    expect(la.body.data.matches).toHaveLength(1);
  });
});

describe("blocking", () => {
  it("26. block creates block (idempotent response)", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    const res = await block(a, b.userId);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ blocked: true, userId: b.userId });
  });

  it("27. blocked user disappears from discovery", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await block(a, b.userId);
    expect(idsIn(await feed(a))).not.toContain(b.userId);
  });

  it("28. reverse blocked relationship is also excluded", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await block(a, b.userId);
    // B's feed must not show A either.
    expect(idsIn(await feed(b))).not.toContain(a.userId);
  });

  it("29. blocked relationship prevents new like", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await block(a, b.userId);
    const res = await like(a, b.userId);
    expect(res.status).toBe(403);
  });

  it("30. unblock works", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await block(a, b.userId);
    const res = await unblock(a, b.userId);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ blocked: false });
    // After unblock, B is discoverable again (no decision exists).
    expect(idsIn(await feed(a))).toContain(b.userId);
  });

  it("31. unblock does NOT automatically recreate a match", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await like(a, b.userId);
    await like(b, a.userId); // match created
    await block(a, b.userId); // match -> BLOCKED
    expect((await matchList(a)).body.data.matches).toHaveLength(0);
    await unblock(a, b.userId);
    // Still no ACTIVE match; unblock must not resurrect it.
    expect((await matchList(a)).body.data.matches).toHaveLength(0);
    const { rows } = await pool.query(`SELECT state FROM matches`);
    expect(rows[0].state).toBe("BLOCKED");
  });

  it("32. duplicate block is safe", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await block(a, b.userId);
    const res = await block(a, b.userId);
    expect(res.status).toBe(200);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM blocks WHERE blocker_id = $1 AND blocked_id = $2`,
      [a.userId, b.userId],
    );
    expect(rows[0].n).toBe(1);
  });

  it("block removes an existing match from both active lists", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await like(a, b.userId);
    await like(b, a.userId);
    await block(a, b.userId);
    expect((await matchList(a)).body.data.matches).toHaveLength(0);
    expect((await matchList(b)).body.data.matches).toHaveLength(0);
  });
});

describe("authorization / IDOR", () => {
  it("33. unrelated user cannot access another user's match", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    const c = await registerUser(app);
    await like(a, b.userId);
    const m = await like(b, a.userId);
    const matchId = m.body.data.matchId;

    const res = await request(app)
      .get(`/api/matches/${matchId}`)
      .set(...auth(c.accessToken));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("MATCH_NOT_AUTHORIZED");
  });

  it("participant CAN access their own match detail", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await like(a, b.userId);
    const m = await like(b, a.userId);
    const matchId = m.body.data.matchId;
    const res = await request(app)
      .get(`/api/matches/${matchId}`)
      .set(...auth(a.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.data.match.user.id).toBe(b.userId);
  });

  it("34. unrelated user cannot modify another user's relationship (own decision only)", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    const c = await registerUser(app);
    // C liking B records C's own decision, not A's. Verify A's decisions are
    // untouched and C cannot influence the A/B relationship.
    await like(a, b.userId);
    const beforeA = await pool.query(
      `SELECT count(*)::int AS n FROM likes WHERE liker_id = $1`,
      [a.userId],
    );
    await like(c, b.userId);
    const afterA = await pool.query(
      `SELECT count(*)::int AS n FROM likes WHERE liker_id = $1`,
      [a.userId],
    );
    expect(afterA.rows[0].n).toBe(beforeA.rows[0].n); // A's decisions unchanged
  });

  it("35. malformed UUIDs rejected", async () => {
    const a = await registerUser(app);
    const likeRes = await like(a, "not-a-uuid" as unknown as string);
    expect(likeRes.status).toBe(400);
    const matchRes = await request(app)
      .get("/api/matches/not-a-uuid")
      .set(...auth(a.accessToken));
    expect(matchRes.status).toBe(400);
    const blockRes = await request(app)
      .post("/api/users/not-a-uuid/block")
      .set(...auth(a.accessToken));
    expect(blockRes.status).toBe(400);
  });

  it("36. authenticated caller only sees their own match list", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    const c = await registerUser(app);
    const d = await registerUser(app);
    // A-B match and C-D match.
    await like(a, b.userId); await like(b, a.userId);
    await like(c, d.userId); await like(d, c.userId);
    const la = await matchList(a);
    const ids = la.body.data.matches.map((x: { user: { id: string } }) => x.user.id);
    expect(ids).toEqual([b.userId]); // only A's match, not C/D's
  });

  it("non-existent match id returns MATCH_NOT_FOUND", async () => {
    const a = await registerUser(app);
    const res = await request(app)
      .get("/api/matches/00000000-0000-0000-0000-000000000000")
      .set(...auth(a.accessToken));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("MATCH_NOT_FOUND");
  });
});

describe("like-after-pass state transition", () => {
  it("converting PASS -> LIKE updates the single decision row", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await pass(a, b.userId);
    await like(a, b.userId);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n, bool_or(is_pass) AS any_pass
         FROM likes WHERE liker_id = $1 AND likee_id = $2`,
      [a.userId, b.userId],
    );
    expect(rows[0].n).toBe(1); // no contradictory second row
    expect(rows[0].any_pass).toBe(false); // final state is LIKE
  });

  it("a prior PASS from the other side still matches once converted to LIKE", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await insertDecision(b.userId, a.userId, true); // B passed A
    await like(a, b.userId); // A likes B -> not reciprocal (B's is a pass)
    expect((await matchList(a)).body.data.matches).toHaveLength(0);
    await like(b, a.userId); // B converts to like -> match
    expect((await matchList(a)).body.data.matches).toHaveLength(1);
  });
});

describe("privacy", () => {
  it("discovery candidates expose only safe fields", async () => {
    const a = await registerUser(app);
    await registerUser(app);
    const res = await feed(a);
    const candidate = res.body.data.candidates[0];
    expect(candidate).toBeTruthy();
    const allowed = new Set(["id", "displayName", "bio", "interests", "age", "photo"]);
    for (const key of Object.keys(candidate)) {
      expect(allowed.has(key)).toBe(true);
    }
    const serialized = JSON.stringify(res.body);
    for (const forbidden of [
      "password",
      "password_hash",
      "refresh_token",
      "email",
      "date_of_birth",
      "is_disabled",
      "moderation_state",
      "consent",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("match summaries expose only safe fields", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await like(a, b.userId);
    await like(b, a.userId);
    const res = await matchList(a);
    const serialized = JSON.stringify(res.body);
    for (const forbidden of [
      "password",
      "password_hash",
      "refresh_token",
      "email",
      "consent",
      "response",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    const m = res.body.data.matches[0];
    expect(new Set(Object.keys(m))).toEqual(new Set(["matchId", "user", "createdAt"]));
    expect(new Set(Object.keys(m.user))).toEqual(new Set(["id", "displayName", "photo"]));
  });

  it("age is hidden when the candidate disables age visibility", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await pool.query(`UPDATE profiles SET age_visible = false WHERE user_id = $1`, [b.userId]);
    const res = await feed(a);
    const bCandidate = res.body.data.candidates.find((c: { id: string }) => c.id === b.userId);
    expect(bCandidate.age).toBeNull();
  });
});
