import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import request from "supertest";
import { closePool, pool } from "../src/db/pool";
import { presenceRegistry } from "../src/presence/presenceRegistry";
import { resetDb, registerUser, createMatch, auth, type RegisteredUser } from "./helpers";
import {
  startLiveServer,
  openSocket,
  nextMessage,
  send,
  closeSocket,
  type LiveServer,
} from "./wsHelpers";

/**
 * Increment 15 — REST read-receipt and WebSocket `message.read` operate on the
 * SAME read-state model (conversation_read_state). These tests prove the two
 * paths stay consistent: a WS read updates what the REST unread query sees, and
 * a REST read is observed by the partner's live WS client.
 */

let srv: LiveServer;

beforeAll(async () => {
  srv = await startLiveServer();
});
beforeEach(async () => {
  await resetDb();
  presenceRegistry.reset();
});
afterEach(async () => {
  presenceRegistry.reset();
  await new Promise((r) => setTimeout(r, 150));
});
afterAll(async () => {
  await srv.close();
  await closePool();
});

async function conversationFor(matchId: string): Promise<string> {
  await pool.query(
    `INSERT INTO conversations (match_id) VALUES ($1) ON CONFLICT (match_id) DO NOTHING`,
    [matchId],
  );
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM conversations WHERE match_id = $1`,
    [matchId],
  );
  return rows[0].id;
}

const restUnread = (u: RegisteredUser, conversationId: string) =>
  request(srv.app).get(`/api/conversations/${conversationId}/unread-count`).set(...auth(u.accessToken));

describe("inbox: REST ↔ WebSocket read-state parity", () => {
  it("a WebSocket message.read is reflected in the REST unread count", async () => {
    const a = await registerUser(srv.app);
    const b = await registerUser(srv.app);
    const matchId = await createMatch(a.userId, b.userId);
    const convId = await conversationFor(matchId);

    // a sends two messages to b via WS.
    const wsA = await openSocket(srv.port, a.accessToken);
    await nextMessage(wsA, (m) => m.type === "connection.ready");
    const c1 = nextMessage(wsA, (m) => m.type === "message.created");
    send(wsA, { type: "message.send", conversationId: convId, body: "one" });
    await c1;
    const c2 = nextMessage(wsA, (m) => m.type === "message.created");
    send(wsA, { type: "message.send", conversationId: convId, body: "two" });
    const lastMsg = (await c2).message as { id: string };

    // Before reading, REST shows 2 unread for b.
    expect((await restUnread(b, convId)).body.data.unreadCount).toBe(2);

    // b reads up to the latest message over WebSocket.
    const wsB = await openSocket(srv.port, b.accessToken);
    await nextMessage(wsB, (m) => m.type === "connection.ready");
    send(wsB, { type: "message.read", conversationId: convId, messageId: lastMsg.id });
    // a's live client observes the read receipt.
    const receipt = await nextMessage(wsA, (m) => m.type === "message.read");
    expect(receipt.conversationId).toBe(convId);
    expect(receipt.userId).toBe(b.userId);

    // The REST unread count now reflects the WS read: 0.
    expect((await restUnread(b, convId)).body.data.unreadCount).toBe(0);

    await closeSocket(wsA);
    await closeSocket(wsB);
  });

  it("a REST read is observed by the partner's live WebSocket client", async () => {
    const a = await registerUser(srv.app);
    const b = await registerUser(srv.app);
    const matchId = await createMatch(a.userId, b.userId);
    const convId = await conversationFor(matchId);

    // a sends a message to b (REST).
    await request(srv.app)
      .post(`/api/matches/${matchId}/messages`)
      .set(...auth(a.accessToken))
      .send({ body: "hello over rest" });

    // a is connected live and should receive b's read receipt.
    const wsA = await openSocket(srv.port, a.accessToken);
    await nextMessage(wsA, (m) => m.type === "connection.ready");
    const receiptP = nextMessage(wsA, (m) => m.type === "message.read");

    // b marks the conversation read via REST.
    const r = await request(srv.app)
      .post(`/api/conversations/${convId}/read`)
      .set(...auth(b.accessToken));
    expect(r.status).toBe(200);
    expect(r.body.data.unreadCount).toBe(0);

    // a's live WS client observed the REST-triggered read receipt.
    const receipt = await receiptP;
    expect(receipt.conversationId).toBe(convId);
    expect(receipt.userId).toBe(b.userId);

    await closeSocket(wsA);
  });
});
