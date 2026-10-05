import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
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

// Helpers --------------------------------------------------------------------
async function matchedPair(): Promise<{
  a: RegisteredUser;
  b: RegisteredUser;
  matchId: string;
}> {
  const a = await registerUser(app);
  const b = await registerUser(app);
  const matchId = await createMatch(a.userId, b.userId);
  return { a, b, matchId };
}

const getHistory = (u: RegisteredUser, matchId: string, qs = "") =>
  request(app).get(`/api/matches/${matchId}/messages${qs}`).set(...auth(u.accessToken));
const sendMsg = (u: RegisteredUser, matchId: string, body: unknown) =>
  request(app)
    .post(`/api/matches/${matchId}/messages`)
    .set(...auth(u.accessToken))
    .send(body as object);

// ---------------------------------------------------------------------------
describe("chat REST: conversation + history", () => {
  it("participant can retrieve (initially empty) history; lazily creates one conversation", async () => {
    const { a, matchId } = await matchedPair();
    const res = await getHistory(a, matchId);
    expect(res.status).toBe(200);
    expect(res.body.data.messages).toEqual([]);
    expect(res.body.data.conversationId).toBeTruthy();
    // Exactly one conversation row for the match.
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM conversations WHERE match_id = $1`,
      [matchId],
    );
    expect(rows[0].n).toBe(1);
  });

  it("unauthenticated history request is rejected", async () => {
    const { matchId } = await matchedPair();
    const res = await request(app).get(`/api/matches/${matchId}/messages`);
    expect(res.status).toBe(401);
  });

  it("unrelated authenticated user cannot read history (IDOR)", async () => {
    const { matchId } = await matchedPair();
    const c = await registerUser(app);
    const res = await getHistory(c, matchId);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("CHAT_NOT_AUTHORIZED");
  });

  it("blocked match cannot read history", async () => {
    const { a, b, matchId } = await matchedPair();
    await insertBlock(a.userId, b.userId);
    await pool.query(`UPDATE matches SET state = 'BLOCKED' WHERE id = $1`, [matchId]);
    const res = await getHistory(a, matchId);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("CHAT_NOT_AUTHORIZED");
  });

  it("inactive (UNMATCHED) match cannot read history", async () => {
    const { a, matchId } = await matchedPair();
    await pool.query(`UPDATE matches SET state = 'UNMATCHED' WHERE id = $1`, [matchId]);
    const res = await getHistory(a, matchId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("MATCH_NOT_ACTIVE");
  });

  it("history pagination works and returns oldest->newest with a working cursor", async () => {
    const { a, b, matchId } = await matchedPair();
    // Send 5 messages (alternating senders) to establish order.
    const bodies = ["m1", "m2", "m3", "m4", "m5"];
    for (let i = 0; i < bodies.length; i++) {
      const sender = i % 2 === 0 ? a : b;
      const r = await sendMsg(sender, matchId, { body: bodies[i] });
      expect(r.status).toBe(201);
    }
    // First page: newest 2 (but presented oldest->newest within the page).
    const p1 = await getHistory(a, matchId, "?limit=2");
    expect(p1.body.data.messages.map((m: { body: string }) => m.body)).toEqual(["m4", "m5"]);
    expect(p1.body.data.nextCursor).toBeTruthy();
    const p2 = await getHistory(a, matchId, `?limit=2&cursor=${encodeURIComponent(p1.body.data.nextCursor)}`);
    expect(p2.body.data.messages.map((m: { body: string }) => m.body)).toEqual(["m2", "m3"]);
    const p3 = await getHistory(a, matchId, `?limit=2&cursor=${encodeURIComponent(p2.body.data.nextCursor)}`);
    expect(p3.body.data.messages.map((m: { body: string }) => m.body)).toEqual(["m1"]);
    expect(p3.body.data.nextCursor).toBeNull();
  });

  it("malformed cursor is rejected", async () => {
    const { a, matchId } = await matchedPair();
    const res = await getHistory(a, matchId, "?cursor=not-a-cursor");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_CURSOR");
  });

  it("message ordering is deterministic across equal timestamps", async () => {
    const { a, b, matchId } = await matchedPair();
    // Insert several messages that may share a timestamp; ensure stable order.
    for (let i = 0; i < 10; i++) await sendMsg(i % 2 ? a : b, matchId, { body: `x${i}` });
    const r1 = await getHistory(a, matchId, "?limit=100");
    const r2 = await getHistory(b, matchId, "?limit=100");
    expect(r1.body.data.messages.map((m: { id: string }) => m.id)).toEqual(
      r2.body.data.messages.map((m: { id: string }) => m.id),
    );
  });
});

describe("chat REST: sending", () => {
  it("participant can send; message persists with server-generated id", async () => {
    const { a, matchId } = await matchedPair();
    const res = await sendMsg(a, matchId, { body: "Hello 👋" });
    expect(res.status).toBe(201);
    expect(res.body.data.message.body).toBe("Hello 👋");
    expect(res.body.data.message.senderId).toBe(a.userId);
    expect(res.body.data.message.id).toMatch(/^[0-9a-f-]{36}$/);
    const { rows } = await pool.query(`SELECT body FROM messages WHERE id = $1`, [
      res.body.data.message.id,
    ]);
    expect(rows[0].body).toBe("Hello 👋");
  });

  it("unrelated user cannot send", async () => {
    const { matchId } = await matchedPair();
    const c = await registerUser(app);
    const res = await sendMsg(c, matchId, { body: "intruder" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("CHAT_NOT_AUTHORIZED");
  });

  it("blocked match cannot send", async () => {
    const { a, b, matchId } = await matchedPair();
    await insertBlock(b.userId, a.userId);
    await pool.query(`UPDATE matches SET state = 'BLOCKED' WHERE id = $1`, [matchId]);
    const res = await sendMsg(a, matchId, { body: "blocked?" });
    expect(res.status).toBe(403);
  });

  it("empty / whitespace-only message is rejected", async () => {
    const { a, matchId } = await matchedPair();
    expect((await sendMsg(a, matchId, { body: "" })).body.error.code).toBe("MESSAGE_EMPTY");
    expect((await sendMsg(a, matchId, { body: "    " })).body.error.code).toBe("MESSAGE_EMPTY");
  });

  it("oversized message is rejected", async () => {
    const { a, matchId } = await matchedPair();
    const tooLong = "a".repeat(4001);
    const res = await sendMsg(a, matchId, { body: tooLong });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MESSAGE_TOO_LONG");
  });

  it("exactly 4000 chars is accepted; Unicode counts by code point", async () => {
    const { a, matchId } = await matchedPair();
    const ok = "a".repeat(4000);
    expect((await sendMsg(a, matchId, { body: ok })).status).toBe(201);
    // 4000 emoji code points should also be accepted (not counted as 2x UTF-16).
    const emoji = "😀".repeat(4000);
    expect((await sendMsg(a, matchId, { body: emoji })).status).toBe(201);
  });

  it("sender id cannot be spoofed via the body", async () => {
    const { a, b, matchId } = await matchedPair();
    const res = await sendMsg(a, matchId, { body: "x", senderId: b.userId, id: "fake" });
    expect(res.status).toBe(201);
    expect(res.body.data.message.senderId).toBe(a.userId); // authenticated identity wins
    expect(res.body.data.message.id).not.toBe("fake");
  });

  it("duplicate clientMessageId is idempotent (no duplicate rows)", async () => {
    const { a, matchId } = await matchedPair();
    const cmid = "11111111-1111-1111-1111-111111111111";
    const r1 = await sendMsg(a, matchId, { body: "retry me", clientMessageId: cmid });
    const r2 = await sendMsg(a, matchId, { body: "retry me", clientMessageId: cmid });
    expect(r1.body.data.message.id).toBe(r2.body.data.message.id);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM messages WHERE client_message_id = $1`,
      [cmid],
    );
    expect(rows[0].n).toBe(1);
  });
});

describe("chat REST: concurrency", () => {
  it("concurrent first-opens create exactly one conversation", async () => {
    const { a, b, matchId } = await matchedPair();
    await Promise.all([getHistory(a, matchId), getHistory(b, matchId)]);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM conversations WHERE match_id = $1`,
      [matchId],
    );
    expect(rows[0].n).toBe(1);
  });

  it("concurrent sends with the same clientMessageId persist exactly one message", async () => {
    const { a, matchId } = await matchedPair();
    // Ensure the conversation exists first so both inserts target the same one.
    await getHistory(a, matchId);
    const cmid = "22222222-2222-2222-2222-222222222222";
    await Promise.all([
      sendMsg(a, matchId, { body: "dup", clientMessageId: cmid }),
      sendMsg(a, matchId, { body: "dup", clientMessageId: cmid }),
    ]);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM messages WHERE client_message_id = $1`,
      [cmid],
    );
    expect(rows[0].n).toBe(1);
  });
});

describe("chat REST: privacy", () => {
  it("message payloads expose only safe fields", async () => {
    const { a, matchId } = await matchedPair();
    await sendMsg(a, matchId, { body: "hi" });
    const res = await getHistory(a, matchId);
    const msg = res.body.data.messages[0];
    expect(new Set(Object.keys(msg))).toEqual(
      new Set(["id", "conversationId", "senderId", "body", "clientMessageId", "createdAt"]),
    );
    const serialized = JSON.stringify(res.body);
    for (const forbidden of [
      "password",
      "password_hash",
      "email",
      "date_of_birth",
      "refresh_token",
      "consent",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
