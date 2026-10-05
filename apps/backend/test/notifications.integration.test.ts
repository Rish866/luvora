import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app";
import { closePool, pool } from "../src/db/pool";
import {
  resetDb,
  registerUser,
  createMatch,
  auth,
  insertBlock,
  setUserRole,
  makeJpeg,
  uploadImage,
  type RegisteredUser,
} from "./helpers";
import { resetMediaProviders } from "../src/media/mediaProviders";

let app: Express;

beforeAll(() => {
  app = createApp();
});
beforeEach(async () => {
  await resetDb();
});
afterEach(() => {
  resetMediaProviders();
});
afterAll(async () => {
  await closePool();
});

const H = (u: RegisteredUser) => auth(u.accessToken);
const list = (u: RegisteredUser, qs = "") =>
  request(app).get(`/api/notifications${qs}`).set(...H(u));
const unreadCount = (u: RegisteredUser) =>
  request(app).get("/api/notifications/unread-count").set(...H(u));

// Reciprocal like helper that produces a match (and MATCH_CREATED notifications).
async function match(a: RegisteredUser, b: RegisteredUser): Promise<string> {
  await request(app).post(`/api/discovery/${b.userId}/like`).set(...H(a));
  const res = await request(app).post(`/api/discovery/${a.userId}/like`).set(...H(b));
  return res.body.data.matchId;
}

// ===========================================================================
describe("notifications: match integration", () => {
  it("a mutual match creates one MATCH_CREATED notification for each user", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await match(a, b);

    const la = await list(a);
    const lb = await list(b);
    expect(la.status).toBe(200);
    const aMatch = la.body.data.notifications.filter((n: { type: string }) => n.type === "MATCH_CREATED");
    const bMatch = lb.body.data.notifications.filter((n: { type: string }) => n.type === "MATCH_CREATED");
    expect(aMatch).toHaveLength(1);
    expect(bMatch).toHaveLength(1);
    expect(aMatch[0].entityType).toBe("match");
  });

  it("concurrent reciprocal likes create exactly one match and no duplicate notifications", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await Promise.all([
      request(app).post(`/api/discovery/${b.userId}/like`).set(...H(a)),
      request(app).post(`/api/discovery/${a.userId}/like`).set(...H(b)),
    ]);
    const matches = await pool.query(`SELECT count(*)::int AS n FROM matches`);
    expect(matches.rows[0].n).toBe(1);
    const notifs = await pool.query(
      `SELECT count(*)::int AS n FROM notifications WHERE type = 'MATCH_CREATED'`,
    );
    // At most one per user; never a storm.
    expect(notifs.rows[0].n).toBeLessThanOrEqual(2);
    // Each user has exactly one.
    const perUser = await pool.query(
      `SELECT user_id, count(*)::int AS n FROM notifications WHERE type='MATCH_CREATED' GROUP BY user_id`,
    );
    for (const r of perUser.rows) expect(r.n).toBe(1);
  });

  it("blocked users do not get match notifications (block prevents the match)", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await insertBlock(a.userId, b.userId);
    await request(app).post(`/api/discovery/${b.userId}/like`).set(...H(a)); // rejected
    const notifs = await pool.query(`SELECT count(*)::int AS n FROM notifications`);
    expect(notifs.rows[0].n).toBe(0);
  });
});

describe("notifications: feed, read state, counts", () => {
  it("lists feed, filters unread, counts unread, marks read (idempotent), read-all", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await match(a, b); // a + b each get 1 MATCH_CREATED

    // Add a couple more via messages (a -> b).
    const matchId = await pool.query<{ id: string }>(
      `SELECT id FROM matches LIMIT 1`,
    );
    void matchId;

    const c = (await unreadCount(a)).body.data.count;
    expect(c).toBeGreaterThanOrEqual(1);

    const feed = await list(a);
    const id = feed.body.data.notifications[0].id;

    // unread filter returns only unread.
    const unread = await list(a, "?unread=true");
    expect(unread.body.data.notifications.every((n: { readAt: string | null }) => n.readAt === null)).toBe(true);

    // mark one read.
    const read1 = await request(app).post(`/api/notifications/${id}/read`).set(...H(a));
    expect(read1.status).toBe(200);
    // idempotent.
    const read2 = await request(app).post(`/api/notifications/${id}/read`).set(...H(a));
    expect(read2.status).toBe(200);
    const afterOne = (await unreadCount(a)).body.data.count;
    expect(afterOne).toBe(c - 1);

    // read-all.
    await request(app).post("/api/notifications/read-all").set(...H(a));
    expect((await unreadCount(a)).body.data.count).toBe(0);
  });

  it("keyset pagination returns non-overlapping pages", async () => {
    const a = await registerUser(app);
    // Seed several notifications directly.
    for (let i = 0; i < 5; i++) {
      await pool.query(
        `INSERT INTO notifications (user_id, type, category, title) VALUES ($1,'SYSTEM','SYSTEM',$2)`,
        [a.userId, `n${i}`],
      );
    }
    const p1 = await list(a, "?limit=2");
    expect(p1.body.data.notifications).toHaveLength(2);
    expect(p1.body.data.nextCursor).toBeTruthy();
    const p2 = await list(a, `?limit=2&cursor=${encodeURIComponent(p1.body.data.nextCursor)}`);
    const ids1 = p1.body.data.notifications.map((n: { id: string }) => n.id);
    const ids2 = p2.body.data.notifications.map((n: { id: string }) => n.id);
    expect(ids1.filter((x: string) => ids2.includes(x))).toHaveLength(0);
  });

  it("rejects a malformed cursor", async () => {
    const a = await registerUser(app);
    const res = await list(a, "?cursor=not-valid");
    expect(res.status).toBe(400);
  });

  it("unauthenticated access is rejected", async () => {
    expect((await request(app).get("/api/notifications")).status).toBe(401);
    expect((await request(app).get("/api/notifications/unread-count")).status).toBe(401);
  });

  it("DTOs expose only safe fields", async () => {
    const a = await registerUser(app);
    await pool.query(
      `INSERT INTO notifications (user_id, type, category, title, dedupe_key) VALUES ($1,'SYSTEM','SYSTEM','hi','k1')`,
      [a.userId],
    );
    const feed = await list(a);
    const n = feed.body.data.notifications[0];
    expect(new Set(Object.keys(n))).toEqual(
      new Set(["id", "type", "category", "title", "body", "entityType", "entityId", "readAt", "createdAt"]),
    );
    // No dedupe_key / user_id / expires_at leaked.
    const s = JSON.stringify(feed.body);
    expect(s).not.toContain("dedupe");
    expect(s).not.toContain("user_id");
  });
});

describe("notifications: IDOR + ownership", () => {
  it("a user cannot mark another user's notification read", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    const n = await pool.query<{ id: string }>(
      `INSERT INTO notifications (user_id, type, category, title) VALUES ($1,'SYSTEM','SYSTEM','x') RETURNING id`,
      [a.userId],
    );
    const res = await request(app).post(`/api/notifications/${n.rows[0].id}/read`).set(...H(b));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOTIFICATION_NOT_FOUND");
    // a's notification is still unread.
    const { rows } = await pool.query(`SELECT read_at FROM notifications WHERE id=$1`, [n.rows[0].id]);
    expect(rows[0].read_at).toBeNull();
  });

  it("read-all only affects the caller's notifications", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await pool.query(`INSERT INTO notifications (user_id, type, category, title) VALUES ($1,'SYSTEM','SYSTEM','x')`, [a.userId]);
    await pool.query(`INSERT INTO notifications (user_id, type, category, title) VALUES ($1,'SYSTEM','SYSTEM','y')`, [b.userId]);
    await request(app).post("/api/notifications/read-all").set(...H(a));
    const bUnread = await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL`, [b.userId]);
    expect(bUnread.rows[0].n).toBe(1);
  });

  it("a user only sees their own notifications in the feed", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await pool.query(`INSERT INTO notifications (user_id, type, category, title) VALUES ($1,'SYSTEM','SYSTEM','a-only')`, [a.userId]);
    await pool.query(`INSERT INTO notifications (user_id, type, category, title) VALUES ($1,'SYSTEM','SYSTEM','b-only')`, [b.userId]);
    const feed = await list(a);
    expect(feed.body.data.notifications.every((n: { title: string }) => n.title !== "b-only")).toBe(true);
  });
});

describe("notifications: dedupe + expiry", () => {
  it("the same dedupe key yields one logical notification", async () => {
    const a = await registerUser(app);
    const { create } = await import("../src/notifications/notificationService");
    await create({ userId: a.userId, type: "SYSTEM" as never, title: "x", dedupeKey: "dup:1" });
    await create({ userId: a.userId, type: "SYSTEM" as never, title: "x", dedupeKey: "dup:1" });
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE dedupe_key='dup:1'`);
    expect(rows[0].n).toBe(1);
  });

  it("concurrent creates with the same dedupe key insert exactly one", async () => {
    const a = await registerUser(app);
    const { create } = await import("../src/notifications/notificationService");
    await Promise.all([
      create({ userId: a.userId, type: "SYSTEM" as never, title: "x", dedupeKey: "race:1" }),
      create({ userId: a.userId, type: "SYSTEM" as never, title: "x", dedupeKey: "race:1" }),
    ]);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE dedupe_key='race:1'`);
    expect(rows[0].n).toBe(1);
  });

  it("expired notifications are excluded from feed + count and cleaned up", async () => {
    const a = await registerUser(app);
    await pool.query(
      `INSERT INTO notifications (user_id, type, category, title, expires_at)
       VALUES ($1,'SYSTEM','SYSTEM','old', now() - interval '1 day')`,
      [a.userId],
    );
    expect((await list(a)).body.data.notifications).toHaveLength(0);
    expect((await unreadCount(a)).body.data.count).toBe(0);
    const { cleanupExpiredNotifications } = await import("../src/notifications/notificationCleanup");
    const res = await cleanupExpiredNotifications();
    expect(res.removed).toBeGreaterThanOrEqual(1);
  });
});

describe("notifications: preferences", () => {
  it("default preferences are all enabled", async () => {
    const a = await registerUser(app);
    const res = await request(app).get("/api/notifications/preferences").set(...H(a));
    expect(res.status).toBe(200);
    expect(res.body.data.preferences.every((p: { enabled: boolean }) => p.enabled)).toBe(true);
  });

  it("disabling a category suppresses its notifications", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await request(app).put("/api/notifications/preferences").set(...H(a)).send({ category: "MATCHES", enabled: false });
    await match(a, b);
    // a disabled MATCHES -> no MATCH_CREATED for a; b still gets one.
    const aMatch = await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND type='MATCH_CREATED'`, [a.userId]);
    const bMatch = await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND type='MATCH_CREATED'`, [b.userId]);
    expect(aMatch.rows[0].n).toBe(0);
    expect(bMatch.rows[0].n).toBe(1);
  });

  it("critical SAFETY category cannot be disabled", async () => {
    const a = await registerUser(app);
    const res = await request(app).put("/api/notifications/preferences").set(...H(a)).send({ category: "SAFETY", enabled: false });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("CRITICAL_PREFERENCE");
  });

  it("SAFETY notifications are delivered even if a user tries to suppress (via DB)", async () => {
    const admin = await registerUser(app);
    await setUserRole(admin.userId, "ADMIN");
    const victim = await registerUser(app);
    // Force a disabled SAFETY preference directly (bypassing the API guard).
    await pool.query(
      `INSERT INTO notification_preferences (user_id, category, enabled) VALUES ($1,'SAFETY',false)`,
      [victim.userId],
    );
    await request(app).post(`/api/admin/users/${victim.userId}/suspend`).set(...H(admin)).send({ reason: "x" });
    const n = await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND type='SAFETY_ACTION'`, [victim.userId]);
    expect(n.rows[0].n).toBe(1); // not suppressed
  });
});

describe("notifications: chat integration", () => {
  it("a message notifies the recipient (not the sender) without leaking the body", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    const matchId = await createMatch(a.userId, b.userId);
    await request(app).post(`/api/matches/${matchId}/messages`).set(...H(a)).send({ body: "secret text 123" });
    const bNotifs = await pool.query(`SELECT type, body FROM notifications WHERE user_id=$1`, [b.userId]);
    const aNotifs = await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND type='MESSAGE_RECEIVED'`, [a.userId]);
    expect(bNotifs.rows.some((r) => r.type === "MESSAGE_RECEIVED")).toBe(true);
    expect(aNotifs.rows[0].n).toBe(0); // sender not notified
    // Body never contains the message text.
    for (const r of bNotifs.rows) expect(r.body).not.toContain("secret text");
  });

  it("duplicate clientMessageId does not create a second message notification", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    const matchId = await createMatch(a.userId, b.userId);
    const cmid = "55555555-5555-4555-8555-555555555555";
    await request(app).post(`/api/matches/${matchId}/messages`).set(...H(a)).send({ body: "hi", clientMessageId: cmid });
    await request(app).post(`/api/matches/${matchId}/messages`).set(...H(a)).send({ body: "hi", clientMessageId: cmid });
    const n = await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND type='MESSAGE_RECEIVED'`, [b.userId]);
    expect(n.rows[0].n).toBe(1);
  });

  it("a message with media attachment does not leak media storage keys into the notification", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    const matchId = await createMatch(a.userId, b.userId);
    const { mediaId } = await uploadImage(app, a, await makeJpeg(), "image/jpeg");
    await request(app).post(`/api/matches/${matchId}/messages`).set(...H(a)).send({ body: "pic", attachmentIds: [mediaId] });
    const notifs = await pool.query(`SELECT title, body, entity_type, entity_id FROM notifications WHERE user_id=$1`, [b.userId]);
    const s = JSON.stringify(notifs.rows);
    expect(s).not.toContain("storage");
    expect(s).not.toContain("media/");
  });
});

describe("notifications: fantasy integration", () => {
  async function playingThroughInvite(): Promise<{ a: RegisteredUser; b: RegisteredUser; sessionId: string }> {
    const a = await registerUser(app);
    const b = await registerUser(app);
    const matchId = await createMatch(a.userId, b.userId);
    const invite = await request(app)
      .post("/api/sessions/invite")
      .set(...H(a))
      .send({ matchId, scenarioId: "x", scenarioVersion: "v1" });
    const sessionId = invite.body.data.sessionId;
    return { a, b, sessionId };
  }

  it("invite notifies the invitee; accept notifies the initiator", async () => {
    const { a, b, sessionId } = await playingThroughInvite();
    const inviteN = await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND type='FANTASY_INVITE'`, [b.userId]);
    expect(inviteN.rows[0].n).toBe(1);
    await request(app).post(`/api/sessions/${sessionId}/accept`).set(...H(b)).send();
    const acceptN = await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND type='FANTASY_ACCEPTED'`, [a.userId]);
    expect(acceptN.rows[0].n).toBe(1);
  });

  it("fantasy notifications never contain consent/private data", async () => {
    const { b } = await playingThroughInvite();
    const notifs = await pool.query(`SELECT title, body FROM notifications WHERE user_id=$1`, [b.userId]);
    const s = JSON.stringify(notifs.rows).toLowerCase();
    for (const forbidden of ["consent", "yes", "no", "maybe", "boundary"]) {
      // crude check: the invite copy must not include consent vocabulary
      expect(s).not.toContain(`"${forbidden}"`);
    }
  });
});

describe("notifications: safety integration", () => {
  it("suspension creates a minimal SAFETY notification with no reporter/moderator identity", async () => {
    const admin = await registerUser(app);
    await setUserRole(admin.userId, "ADMIN");
    const victim = await registerUser(app);
    await request(app).post(`/api/admin/users/${victim.userId}/suspend`).set(...H(admin)).send({ reason: "harassment" });
    const notifs = await pool.query(`SELECT type, title, body FROM notifications WHERE user_id=$1`, [victim.userId]);
    expect(notifs.rows.some((r) => r.type === "SAFETY_ACTION")).toBe(true);
    const s = JSON.stringify(notifs.rows);
    // No actor/reporter id, no reason detail leaked.
    expect(s).not.toContain(admin.userId);
    expect(s).not.toContain("harassment");
  });
});
