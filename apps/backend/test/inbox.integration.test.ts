import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app";
import { closePool } from "../src/db/pool";
import { resetDb, registerUser, createMatch, auth, type RegisteredUser } from "./helpers";

/**
 * Increment 15 — messaging inbox contract: REST read receipt, per-conversation
 * unread count, last-message preview, enriched /api/matches, and total unread.
 */

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

const H = (u: RegisteredUser) => auth(u.accessToken);

async function pair(): Promise<{ a: RegisteredUser; b: RegisteredUser; matchId: string }> {
  const a = await registerUser(app);
  const b = await registerUser(app);
  const matchId = await createMatch(a.userId, b.userId);
  return { a, b, matchId };
}

/** Send a message from `u` in the match; returns the created message. */
async function send(u: RegisteredUser, matchId: string, body: string, extra: object = {}) {
  const res = await request(app)
    .post(`/api/matches/${matchId}/messages`)
    .set(...H(u))
    .send({ body, ...extra });
  if (res.status !== 201) throw new Error(`send failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.message;
}

const inbox = (u: RegisteredUser) => request(app).get("/api/matches").set(...H(u));
const matchDetail = (u: RegisteredUser, matchId: string) =>
  request(app).get(`/api/matches/${matchId}`).set(...H(u));

/** Resolve the conversationId for a viewer's match via the inbox. */
async function convId(u: RegisteredUser, matchId: string): Promise<string> {
  const res = await inbox(u);
  const m = res.body.data.matches.find((x: { matchId: string }) => x.matchId === matchId);
  return m.conversationId;
}

const readConv = (u: RegisteredUser, conversationId: string) =>
  request(app).post(`/api/conversations/${conversationId}/read`).set(...H(u));
const convUnread = (u: RegisteredUser, conversationId: string) =>
  request(app).get(`/api/conversations/${conversationId}/unread-count`).set(...H(u));

describe("inbox: enriched /api/matches", () => {
  it("includes conversationId, lastMessage, unreadCount, and totalUnreadCount", async () => {
    const { a, b, matchId } = await pair();
    await send(b, matchId, "hey a");
    const res = await inbox(a);
    expect(res.status).toBe(200);
    expect(typeof res.body.data.totalUnreadCount).toBe("number");
    const m = res.body.data.matches.find((x: { matchId: string }) => x.matchId === matchId);
    expect(m.conversationId).toBeTruthy();
    expect(m.user.id).toBe(b.userId);
    expect(m.lastMessage).toMatchObject({ text: "hey a", senderId: b.userId });
    expect(m.lastMessage.id).toBeTruthy();
    expect(m.lastMessage.createdAt).toBeTruthy();
    expect(m.lastMessage.hasAttachments).toBe(false);
    expect(m.unreadCount).toBe(1);
    expect(res.body.data.totalUnreadCount).toBe(1);
  });

  it("match detail is consistent with the inbox row", async () => {
    const { a, b, matchId } = await pair();
    await send(b, matchId, "detail msg");
    const res = await matchDetail(a, matchId);
    expect(res.status).toBe(200);
    expect(res.body.data.match.conversationId).toBeTruthy();
    expect(res.body.data.match.lastMessage.text).toBe("detail msg");
    expect(res.body.data.match.unreadCount).toBe(1);
  });

  it("a match with no messages has null lastMessage and zero unread", async () => {
    const { a, matchId } = await pair();
    const res = await inbox(a);
    const m = res.body.data.matches.find((x: { matchId: string }) => x.matchId === matchId);
    expect(m.lastMessage).toBeNull();
    expect(m.unreadCount).toBe(0);
    expect(m.conversationId).toBeTruthy(); // conversation ensured even with no messages
  });

  it("last message reflects the most recent message and sender (ordering)", async () => {
    const { a, b, matchId } = await pair();
    await send(a, matchId, "first (from a)");
    await send(b, matchId, "second (from b)");
    const last = await send(a, matchId, "third (from a)");
    const res = await inbox(b);
    const m = res.body.data.matches.find((x: { matchId: string }) => x.matchId === matchId);
    expect(m.lastMessage.id).toBe(last.id);
    expect(m.lastMessage.text).toBe("third (from a)");
    expect(m.lastMessage.senderId).toBe(a.userId);
  });
});

describe("inbox: unread semantics", () => {
  it("zero unread when no messages", async () => {
    const { a, matchId } = await pair();
    expect((await convUnread(a, await convId(a, matchId))).body.data.unreadCount).toBe(0);
  });

  it("counts only the OTHER participant's messages", async () => {
    const { a, b, matchId } = await pair();
    await send(a, matchId, "my own 1");
    await send(a, matchId, "my own 2");
    await send(b, matchId, "from b");
    const cid = await convId(a, matchId);
    // a's own messages don't count toward a's unread; only b's does.
    expect((await convUnread(a, cid)).body.data.unreadCount).toBe(1);
    // b sees a's two messages as unread, not their own.
    expect((await convUnread(b, cid)).body.data.unreadCount).toBe(2);
  });

  it("multiple unread accumulate", async () => {
    const { a, b, matchId } = await pair();
    for (let i = 0; i < 5; i++) await send(b, matchId, `m${i}`);
    expect((await convUnread(a, await convId(a, matchId))).body.data.unreadCount).toBe(5);
  });

  it("unread is user-specific (not shared between participants)", async () => {
    const { a, b, matchId } = await pair();
    await send(b, matchId, "to a");
    const cid = await convId(a, matchId);
    expect((await convUnread(a, cid)).body.data.unreadCount).toBe(1);
    expect((await convUnread(b, cid)).body.data.unreadCount).toBe(0);
  });
});

describe("inbox: REST read receipt", () => {
  it("marks the conversation read and clears unread (idempotent)", async () => {
    const { a, b, matchId } = await pair();
    await send(b, matchId, "unread 1");
    await send(b, matchId, "unread 2");
    const cid = await convId(a, matchId);
    expect((await convUnread(a, cid)).body.data.unreadCount).toBe(2);

    const r1 = await readConv(a, cid);
    expect(r1.status).toBe(200);
    expect(r1.body.data.unreadCount).toBe(0);
    expect(r1.body.data.lastReadMessageId).toBeTruthy();
    expect((await convUnread(a, cid)).body.data.unreadCount).toBe(0);

    // Idempotent: reading again is safe and stays at 0.
    const r2 = await readConv(a, cid);
    expect(r2.status).toBe(200);
    expect(r2.body.data.unreadCount).toBe(0);
  });

  it("reading only affects the caller's unread, not the partner's", async () => {
    const { a, b, matchId } = await pair();
    await send(a, matchId, "from a to b");
    await send(b, matchId, "from b to a");
    const cid = await convId(a, matchId);
    await readConv(a, cid); // a reads
    expect((await convUnread(a, cid)).body.data.unreadCount).toBe(0);
    // b still has a's message unread (a reading did not touch b's state).
    expect((await convUnread(b, cid)).body.data.unreadCount).toBe(1);
  });

  it("new messages after a read become unread again", async () => {
    const { a, b, matchId } = await pair();
    await send(b, matchId, "old");
    const cid = await convId(a, matchId);
    await readConv(a, cid);
    expect((await convUnread(a, cid)).body.data.unreadCount).toBe(0);
    await send(b, matchId, "new after read");
    expect((await convUnread(a, cid)).body.data.unreadCount).toBe(1);
  });

  it("reading a conversation with no messages is a safe no-op", async () => {
    const { a, matchId } = await pair();
    const cid = await convId(a, matchId);
    const r = await readConv(a, cid);
    expect(r.status).toBe(200);
    expect(r.body.data.lastReadMessageId).toBeNull();
    expect(r.body.data.unreadCount).toBe(0);
  });

  it("totalUnreadCount drops to zero after reading all conversations", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    const c = await registerUser(app);
    const m1 = await createMatch(a.userId, b.userId);
    const m2 = await createMatch(a.userId, c.userId);
    await send(b, m1, "hi from b");
    await send(c, m2, "hi from c");
    expect((await inbox(a)).body.data.totalUnreadCount).toBe(2);
    await readConv(a, await convId(a, m1));
    await readConv(a, await convId(a, m2));
    expect((await inbox(a)).body.data.totalUnreadCount).toBe(0);
  });
});

describe("inbox: authorization & IDOR", () => {
  it("requires authentication", async () => {
    expect((await request(app).get("/api/matches")).status).toBe(401);
    expect(
      (await request(app).post("/api/conversations/00000000-0000-0000-0000-000000000000/read"))
        .status,
    ).toBe(401);
  });

  it("a non-participant cannot read or query another conversation (opaque)", async () => {
    const { a, b, matchId } = await pair();
    const outsider = await registerUser(app);
    await send(b, matchId, "private");
    const cid = await convId(a, matchId);
    const read = await readConv(outsider, cid);
    expect([403, 404]).toContain(read.status);
    const unread = await convUnread(outsider, cid);
    expect([403, 404]).toContain(unread.status);
  });

  it("rejects a malformed conversation id", async () => {
    const u = await registerUser(app);
    const res = await request(app).post("/api/conversations/not-a-uuid/read").set(...H(u));
    expect(res.status).toBe(400);
  });

  it("a blocked relationship cannot read the conversation", async () => {
    const { a, b, matchId } = await pair();
    await send(a, matchId, "before block");
    const cid = await convId(b, matchId);
    // a blocks b -> match becomes BLOCKED; chat (and read) is no longer allowed.
    await request(app).post(`/api/users/${b.userId}/block`).set(...H(a));
    const res = await readConv(b, cid);
    expect([403, 404, 409]).toContain(res.status);
  });
});

describe("inbox: last-message preview content safety", () => {
  it("exposes only safe preview fields (no internal/storage/moderation data)", async () => {
    const { a, b, matchId } = await pair();
    await send(b, matchId, "safe preview");
    const res = await inbox(a);
    const m = res.body.data.matches.find((x: { matchId: string }) => x.matchId === matchId);
    expect(new Set(Object.keys(m.lastMessage))).toEqual(
      new Set(["id", "text", "senderId", "createdAt", "hasAttachments"]),
    );
    const serialized = JSON.stringify(m.lastMessage);
    expect(serialized).not.toMatch(/storage|moderation|conversation_id|client_message/i);
  });
});
