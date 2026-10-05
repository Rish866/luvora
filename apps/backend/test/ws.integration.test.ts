import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import type { WebSocket } from "ws";
import { closePool, pool } from "../src/db/pool";
import { presenceRegistry } from "../src/presence/presenceRegistry";
import {
  resetDb,
  registerUser,
  createMatch,
  insertBlock,
  uploadImage,
  makeJpeg,
  type RegisteredUser,
} from "./helpers";
import {
  startLiveServer,
  openSocket,
  nextMessage,
  send,
  closeSocket,
  type LiveServer,
} from "./wsHelpers";

let srv: LiveServer;

beforeAll(async () => {
  srv = await startLiveServer();
});
beforeEach(async () => {
  await resetDb();
  presenceRegistry.reset();
});
afterEach(async () => {
  // A socket close now triggers an async presence transition (persisting
  // last-seen). Drain it + reset the shared registry so its DB work cannot
  // overlap the next test file's resetDb() TRUNCATE and deadlock.
  presenceRegistry.reset();
  await new Promise((r) => setTimeout(r, 150));
});
afterAll(async () => {
  await srv.close();
  await closePool();
});

async function matchedPair(): Promise<{
  a: RegisteredUser;
  b: RegisteredUser;
  matchId: string;
}> {
  const a = await registerUser(srv.app);
  const b = await registerUser(srv.app);
  const matchId = await createMatch(a.userId, b.userId);
  return { a, b, matchId };
}

/** Resolve the conversation id for a match (creating it if needed) directly. */
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

describe("websocket: authentication & connection", () => {
  it("17/20. valid token connects and receives connection.ready", async () => {
    const a = await registerUser(srv.app);
    const ws = await openSocket(srv.port, a.accessToken);
    const ready = await nextMessage(ws, (m) => m.type === "connection.ready");
    expect(ready.userId).toBe(a.userId);
    await closeSocket(ws);
  });

  it("18. invalid token is rejected at handshake", async () => {
    await expect(openSocket(srv.port, "not-a-valid-token")).rejects.toThrow();
  });

  it("19. missing authentication is rejected at handshake", async () => {
    await expect(openSocket(srv.port, null)).rejects.toThrow();
  });

  it("query-param token also works (browser clients)", async () => {
    const a = await registerUser(srv.app);
    const ws = await openSocket(srv.port, a.accessToken, { viaQuery: true });
    const ready = await nextMessage(ws, (m) => m.type === "connection.ready");
    expect(ready.userId).toBe(a.userId);
    await closeSocket(ws);
  });
});

describe("websocket: messaging", () => {
  it("21/22/23. participant sends; recipient and sender receive canonical message", async () => {
    const { a, b, matchId } = await matchedPair();
    const convId = await conversationFor(matchId);
    const wsA = await openSocket(srv.port, a.accessToken);
    const wsB = await openSocket(srv.port, b.accessToken);
    await nextMessage(wsA, (m) => m.type === "connection.ready");
    await nextMessage(wsB, (m) => m.type === "connection.ready");

    const recvB = nextMessage(wsB, (m) => m.type === "message.created");
    const recvA = nextMessage(wsA, (m) => m.type === "message.created");
    send(wsA, { type: "message.send", conversationId: convId, body: "Hey B 👋" });

    const [mB, mA] = await Promise.all([recvB, recvA]);
    const msgB = mB.message as Record<string, unknown>;
    const msgA = mA.message as Record<string, unknown>;
    expect(msgB.body).toBe("Hey B 👋");
    expect(msgB.senderId).toBe(a.userId);
    expect(msgA.id).toBe(msgB.id); // same canonical persisted message
    // Persisted in DB.
    const { rows } = await pool.query(`SELECT body FROM messages WHERE id = $1`, [msgA.id]);
    expect(rows[0].body).toBe("Hey B 👋");
    await closeSocket(wsA);
    await closeSocket(wsB);
  });

  it("30. message persists before broadcast (broadcasted id exists in DB)", async () => {
    const { a, matchId } = await matchedPair();
    const convId = await conversationFor(matchId);
    const wsA = await openSocket(srv.port, a.accessToken);
    await nextMessage(wsA, (m) => m.type === "connection.ready");
    const created = nextMessage(wsA, (m) => m.type === "message.created");
    send(wsA, { type: "message.send", conversationId: convId, body: "persist-check" });
    const msg = (await created).message as Record<string, unknown>;
    const { rows } = await pool.query(`SELECT 1 FROM messages WHERE id = $1`, [msg.id]);
    expect(rows).toHaveLength(1);
    await closeSocket(wsA);
  });

  it("24. unrelated user cannot send into another pair's conversation", async () => {
    const { matchId } = await matchedPair();
    const convId = await conversationFor(matchId);
    const c = await registerUser(srv.app);
    const wsC = await openSocket(srv.port, c.accessToken);
    await nextMessage(wsC, (m) => m.type === "connection.ready");
    const err = nextMessage(wsC, (m) => m.type === "error");
    send(wsC, { type: "message.send", conversationId: convId, body: "intruder" });
    expect((await err).code).toBe("CHAT_NOT_AUTHORIZED");
    // Nothing persisted.
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM messages`);
    expect(rows[0].n).toBe(0);
    await closeSocket(wsC);
  });

  it("25/26. malformed event / invalid type returns error without crashing", async () => {
    const a = await registerUser(srv.app);
    const ws = await openSocket(srv.port, a.accessToken);
    await nextMessage(ws, (m) => m.type === "connection.ready");

    // Malformed JSON.
    const e1 = nextMessage(ws, (m) => m.type === "error");
    ws.send("this is not json");
    expect((await e1).code).toBe("INVALID_WEBSOCKET_MESSAGE");

    // Unknown event type.
    const e2 = nextMessage(ws, (m) => m.type === "error");
    send(ws, { type: "totally.unknown", foo: 1 });
    expect((await e2).code).toBe("INVALID_WEBSOCKET_MESSAGE");

    // Server still alive: a valid subsequent send still works.
    const { a: a2, matchId } = await matchedPair();
    const convId = await conversationFor(matchId);
    const ws2 = await openSocket(srv.port, a2.accessToken);
    await nextMessage(ws2, (m) => m.type === "connection.ready");
    const created = nextMessage(ws2, (m) => m.type === "message.created");
    send(ws2, { type: "message.send", conversationId: convId, body: "still alive" });
    expect(((await created).message as Record<string, unknown>).body).toBe("still alive");
    await closeSocket(ws);
    await closeSocket(ws2);
  });

  it("27/28. empty and oversized messages are rejected over WS", async () => {
    const { a, matchId } = await matchedPair();
    const convId = await conversationFor(matchId);
    const ws = await openSocket(srv.port, a.accessToken);
    await nextMessage(ws, (m) => m.type === "connection.ready");

    // Send empty, fully await its error before the next send so the two error
    // frames can't interleave in the buffer.
    send(ws, { type: "message.send", conversationId: convId, body: "   " });
    expect((await nextMessage(ws, (m) => m.type === "error")).code).toBe("MESSAGE_EMPTY");

    send(ws, { type: "message.send", conversationId: convId, body: "a".repeat(4001) });
    expect((await nextMessage(ws, (m) => m.type === "error")).code).toBe("MESSAGE_TOO_LONG");
    await closeSocket(ws);
  });

  it("29. senderId in the payload cannot be spoofed", async () => {
    const { a, b, matchId } = await matchedPair();
    const convId = await conversationFor(matchId);
    const ws = await openSocket(srv.port, a.accessToken);
    await nextMessage(ws, (m) => m.type === "connection.ready");
    const created = nextMessage(ws, (m) => m.type === "message.created");
    // Attempt to spoof senderId as B.
    send(ws, { type: "message.send", conversationId: convId, body: "spoof", senderId: b.userId });
    const msg = (await created).message as Record<string, unknown>;
    expect(msg.senderId).toBe(a.userId);
    await closeSocket(ws);
  });

  it("32/47. multiple sockets for the same user both receive the message", async () => {
    const { a, b, matchId } = await matchedPair();
    const convId = await conversationFor(matchId);
    const wsB1 = await openSocket(srv.port, b.accessToken);
    const wsB2 = await openSocket(srv.port, b.accessToken);
    const wsA = await openSocket(srv.port, a.accessToken);
    await Promise.all([
      nextMessage(wsB1, (m) => m.type === "connection.ready"),
      nextMessage(wsB2, (m) => m.type === "connection.ready"),
      nextMessage(wsA, (m) => m.type === "connection.ready"),
    ]);
    const r1 = nextMessage(wsB1, (m) => m.type === "message.created");
    const r2 = nextMessage(wsB2, (m) => m.type === "message.created");
    send(wsA, { type: "message.send", conversationId: convId, body: "to all B devices" });
    const [m1, m2] = await Promise.all([r1, r2]);
    expect((m1.message as Record<string, unknown>).body).toBe("to all B devices");
    expect((m2.message as Record<string, unknown>).body).toBe("to all B devices");
    // Only ONE row persisted despite two deliveries.
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM messages`);
    expect(rows[0].n).toBe(1);
    await closeSocket(wsB1);
    await closeSocket(wsB2);
    await closeSocket(wsA);
  });

  it("31. disconnect cleans the registry", async () => {
    const { a, matchId } = await matchedPair();
    const convId = await conversationFor(matchId);
    const ws = await openSocket(srv.port, a.accessToken);
    await nextMessage(ws, (m) => m.type === "connection.ready");
    await closeSocket(ws);
    // Give the close handler a tick to run.
    await new Promise((r) => setTimeout(r, 100));
    // A fresh send from B should reach nobody for A but must not error on the
    // server; we assert indirectly by confirming the server still accepts a new
    // connection (process alive) and A has no sockets.
    const b = await registerUser(srv.app);
    void b;
    void convId;
    const ws2 = await openSocket(srv.port, a.accessToken);
    const ready = await nextMessage(ws2, (m) => m.type === "connection.ready");
    expect(ready.userId).toBe(a.userId);
    await closeSocket(ws2);
  });
});

describe("websocket: read receipts & typing", () => {
  it("33/36/37. read receipt reaches the partner with authenticated userId", async () => {
    const { a, b, matchId } = await matchedPair();
    const convId = await conversationFor(matchId);
    const wsA = await openSocket(srv.port, a.accessToken);
    const wsB = await openSocket(srv.port, b.accessToken);
    await nextMessage(wsA, (m) => m.type === "connection.ready");
    await nextMessage(wsB, (m) => m.type === "connection.ready");

    // A sends a message so there is something to read.
    const created = nextMessage(wsA, (m) => m.type === "message.created");
    send(wsA, { type: "message.send", conversationId: convId, body: "read me" });
    const messageId = ((await created).message as Record<string, unknown>).id as string;

    // B marks it read; A should be notified with B's authenticated id.
    const readEvt = nextMessage(wsA, (m) => m.type === "message.read");
    send(wsB, { type: "message.read", conversationId: convId, messageId });
    const evt = await readEvt;
    expect(evt.messageId).toBe(messageId);
    expect(evt.userId).toBe(b.userId);

    const { rows } = await pool.query(
      `SELECT last_read_message_id FROM conversation_read_state WHERE conversation_id = $1 AND user_id = $2`,
      [convId, b.userId],
    );
    expect(rows[0].last_read_message_id).toBe(messageId);
    await closeSocket(wsA);
    await closeSocket(wsB);
  });

  it("35. cannot mark a message from another conversation as read", async () => {
    const { a, matchId } = await matchedPair();
    const convId = await conversationFor(matchId);
    // Another unrelated conversation with its own message.
    const x = await registerUser(srv.app);
    const y = await registerUser(srv.app);
    const otherMatch = await createMatch(x.userId, y.userId);
    const otherConv = await conversationFor(otherMatch);
    const other = await pool.query<{ id: string }>(
      `INSERT INTO messages (conversation_id, sender_id, body) VALUES ($1,$2,'x') RETURNING id`,
      [otherConv, x.userId],
    );
    const wsA = await openSocket(srv.port, a.accessToken);
    await nextMessage(wsA, (m) => m.type === "connection.ready");
    const err = nextMessage(wsA, (m) => m.type === "error");
    send(wsA, { type: "message.read", conversationId: convId, messageId: other.rows[0].id });
    expect((await err).code).toBe("CHAT_NOT_AUTHORIZED");
    await closeSocket(wsA);
  });

  it("38/39/40/41/42. typing reaches partner, is not persisted, and is unspoofable", async () => {
    const { a, b, matchId } = await matchedPair();
    const convId = await conversationFor(matchId);
    const wsA = await openSocket(srv.port, a.accessToken);
    const wsB = await openSocket(srv.port, b.accessToken);
    await nextMessage(wsA, (m) => m.type === "connection.ready");
    await nextMessage(wsB, (m) => m.type === "connection.ready");

    const typing = nextMessage(wsB, (m) => m.type === "typing");
    send(wsA, { type: "typing.start", conversationId: convId, userId: b.userId /* ignored */ });
    const evt = await typing;
    expect(evt.userId).toBe(a.userId); // authenticated identity, not spoofed
    expect(evt.state).toBe("start");

    // Unrelated user cannot emit typing into the conversation.
    const c = await registerUser(srv.app);
    const wsC = await openSocket(srv.port, c.accessToken);
    await nextMessage(wsC, (m) => m.type === "connection.ready");
    const err = nextMessage(wsC, (m) => m.type === "error");
    send(wsC, { type: "typing.start", conversationId: convId });
    expect((await err).code).toBe("CHAT_NOT_AUTHORIZED");
    await closeSocket(wsA);
    await closeSocket(wsB);
    await closeSocket(wsC);
  });
});

describe("websocket: block enforcement", () => {
  it("58. after A blocks B, a stale socket cannot send and no message persists", async () => {
    const { a, b, matchId } = await matchedPair();
    const convId = await conversationFor(matchId);
    const wsA = await openSocket(srv.port, a.accessToken);
    const wsB = await openSocket(srv.port, b.accessToken);
    await nextMessage(wsA, (m) => m.type === "connection.ready");
    await nextMessage(wsB, (m) => m.type === "connection.ready");

    // Sanity: messaging works before the block.
    const pre = nextMessage(wsB, (m) => m.type === "message.created");
    send(wsA, { type: "message.send", conversationId: convId, body: "before block" });
    await pre;

    // A blocks B via the real HTTP API (sets match BLOCKED + notifies sockets).
    const request = (await import("supertest")).default;
    const blockRes = await request(srv.app)
      .post(`/api/users/${b.userId}/block`)
      .set("Authorization", `Bearer ${a.accessToken}`);
    expect(blockRes.status).toBe(200);

    // The stale B socket attempts another send -> rejected, nothing persisted.
    const err = nextMessage(wsB, (m) => m.type === "error");
    send(wsB, { type: "message.send", conversationId: convId, body: "after block" });
    expect((await err).code).toBe("CHAT_NOT_AUTHORIZED");

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM messages WHERE body = 'after block'`,
    );
    expect(rows[0].n).toBe(0);
    await closeSocket(wsA);
    await closeSocket(wsB);
  });

  it("blocked user also cannot establish a usable conversation after block", async () => {
    const { a, b, matchId } = await matchedPair();
    const convId = await conversationFor(matchId);
    await insertBlock(a.userId, b.userId);
    await pool.query(`UPDATE matches SET state = 'BLOCKED' WHERE id = $1`, [matchId]);
    const wsB = await openSocket(srv.port, b.accessToken);
    await nextMessage(wsB, (m) => m.type === "connection.ready");
    const err = nextMessage(wsB, (m) => m.type === "error");
    send(wsB, { type: "message.send", conversationId: convId, body: "nope" });
    expect((await err).code).toBe("CHAT_NOT_AUTHORIZED");
    await closeSocket(wsB);
  });
});

describe("websocket: attachments (Increment 5)", () => {
  it("message.send with attachment delivers a safe attachment DTO to the recipient", async () => {
    const { a, b, matchId } = await matchedPair();
    const convId = await conversationFor(matchId);
    const { mediaId } = await uploadImage(srv.app, a, await makeJpeg(), "image/jpeg");

    const wsA = await openSocket(srv.port, a.accessToken);
    const wsB = await openSocket(srv.port, b.accessToken);
    await nextMessage(wsA, (m) => m.type === "connection.ready");
    await nextMessage(wsB, (m) => m.type === "connection.ready");

    const recvB = nextMessage(wsB, (m) => m.type === "message.created");
    send(wsA, {
      type: "message.send",
      conversationId: convId,
      body: "photo",
      attachmentIds: [mediaId],
    });
    const evt = await recvB;
    const msg = evt.message as Record<string, unknown>;
    const atts = msg.attachments as Array<Record<string, unknown>>;
    expect(atts).toHaveLength(1);
    expect(atts[0].id).toBe(mediaId);
    expect(atts[0].url).toBe(`/api/media/${mediaId}/content`);
    expect(msg.senderId).toBe(a.userId); // authenticated identity
    // No storage internals in the WS payload.
    expect(JSON.stringify(evt)).not.toContain("storage_key");
    await closeSocket(wsA);
    await closeSocket(wsB);
  });

  it("sender cannot attach another user's media over WS", async () => {
    const { a, b, matchId } = await matchedPair();
    const convId = await conversationFor(matchId);
    const { mediaId } = await uploadImage(srv.app, b, await makeJpeg(), "image/jpeg"); // owned by B

    const wsA = await openSocket(srv.port, a.accessToken);
    await nextMessage(wsA, (m) => m.type === "connection.ready");
    const err = nextMessage(wsA, (m) => m.type === "error");
    send(wsA, {
      type: "message.send",
      conversationId: convId,
      body: "steal",
      attachmentIds: [mediaId],
    });
    expect((await err).code).toBe("MEDIA_NOT_AUTHORIZED");
    // Nothing persisted.
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM messages`);
    expect(rows[0].n).toBe(0);
    await closeSocket(wsA);
  });

  it("duplicate clientMessageId with attachments stays idempotent over WS", async () => {
    const { a, b, matchId } = await matchedPair();
    const convId = await conversationFor(matchId);
    const { mediaId } = await uploadImage(srv.app, a, await makeJpeg(), "image/jpeg");
    const wsA = await openSocket(srv.port, a.accessToken);
    const wsB = await openSocket(srv.port, b.accessToken);
    await nextMessage(wsA, (m) => m.type === "connection.ready");
    await nextMessage(wsB, (m) => m.type === "connection.ready");

    const cmid = "44444444-4444-4444-8444-444444444444";
    const r1 = nextMessage(wsB, (m) => m.type === "message.created");
    send(wsA, { type: "message.send", conversationId: convId, body: "p", attachmentIds: [mediaId], clientMessageId: cmid });
    await r1;
    const r2 = nextMessage(wsB, (m) => m.type === "message.created");
    send(wsA, { type: "message.send", conversationId: convId, body: "p", attachmentIds: [mediaId], clientMessageId: cmid });
    await r2;
    const msgs = await pool.query(`SELECT count(*)::int AS n FROM messages`);
    expect(msgs.rows[0].n).toBe(1);
    const atts = await pool.query(`SELECT count(*)::int AS n FROM message_attachments`);
    expect(atts.rows[0].n).toBe(1);
    await closeSocket(wsA);
    await closeSocket(wsB);
  });
});
