import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import request from "supertest";
import { closePool, pool } from "../src/db/pool";
import {
  resetDb,
  registerUser,
  createMatch,
  insertBlock,
  setUserRole,
  auth,
  type RegisteredUser,
} from "./helpers";
import {
  startLiveServer,
  openSocket,
  nextMessage,
  closeSocket,
  type LiveServer,
} from "./wsHelpers";
import { presenceRegistry } from "../src/presence/presenceRegistry";

/**
 * Presence + real-time event integration tests (Increment 7).
 *
 * Covers: process-local ONLINE/OFFLINE accounting across both WS channels,
 * last-seen persistence on the final disconnect, the matched + not-blocked
 * visibility rule for the presence API and `presence.changed` fan-out, the
 * `notification.created` real-time optimization, IDOR on the presence lookup,
 * and that suspension (which force-closes sockets) flips the user OFFLINE.
 */

let srv: LiveServer;

beforeAll(async () => {
  srv = await startLiveServer();
});
beforeEach(async () => {
  await resetDb();
  // The registry is a process-wide singleton shared by the live server; reset
  // between tests so counts never leak across cases.
  presenceRegistry.reset();
});
afterEach(async () => {
  // Presence transition handlers persist last-seen + emit events ASYNchronously
  // after a socket closes. If a test returns while one is in flight, that query
  // can overlap the NEXT test file's resetDb() TRUNCATE and deadlock. Reset the
  // registry and let any pending handler drain before yielding to the next file.
  presenceRegistry.reset();
  await new Promise((r) => setTimeout(r, 150));
});
afterAll(async () => {
  await srv.close();
  await closePool();
});

const H = (u: RegisteredUser) => auth(u.accessToken);
const getPresence = (viewer: RegisteredUser, targetId: string) =>
  request(srv.app).get(`/api/users/${targetId}/presence`).set(...H(viewer));

/** Register two users and make them an ACTIVE match (mutual observers). */
async function matchedPair(): Promise<[RegisteredUser, RegisteredUser]> {
  const a = await registerUser(srv.app);
  const b = await registerUser(srv.app);
  await createMatch(a.userId, b.userId);
  return [a, b];
}

// ===========================================================================
describe("presence: registry accounting across channels", () => {
  it("a user is ONLINE while any socket is open and OFFLINE only on the final close", async () => {
    const [a, b] = await matchedPair();

    // b sees a OFFLINE before any connection.
    expect((await getPresence(b, a.userId)).body.data.status).toBe("OFFLINE");

    // a opens a chat socket -> ONLINE.
    const chat = await openSocket(srv.port, a.accessToken, { path: "/ws/chat" });
    await nextMessage(chat, (m) => m.type === "connection.ready");
    expect((await getPresence(b, a.userId)).body.data.status).toBe("ONLINE");

    // a opens a SECOND socket on the game channel -> still ONLINE.
    const game = await openSocket(srv.port, a.accessToken, { path: "/ws/game" });
    await nextMessage(game, (m) => m.type === "game.ready");
    expect((await getPresence(b, a.userId)).body.data.status).toBe("ONLINE");

    // Close the first socket -> the user is still ONLINE (one socket remains).
    await closeSocket(chat);
    // The game socket still counts, so the user must remain ONLINE.
    expect(presenceRegistry.isOnline(a.userId)).toBe(true);
    expect((await getPresence(b, a.userId)).body.data.status).toBe("ONLINE");

    // Close the final socket -> OFFLINE + last-seen persisted. Wait for the
    // durable DB effect rather than racing the in-memory flag.
    await closeSocket(game);
    expect(await waitForLastSeenPersisted(a.userId)).toBe(true);
    const view = (await getPresence(b, a.userId)).body.data;
    expect(view.status).toBe("OFFLINE");
    expect(view.lastSeenAt).toBeTruthy();
  });

  it("last-seen is persisted only on the ONLINE->OFFLINE transition", async () => {
    const [a, b] = await matchedPair();
    void b;
    // No last_seen before connecting.
    const before = await pool.query<{ last_seen_at: string | null }>(
      `SELECT last_seen_at FROM users WHERE id=$1`,
      [a.userId],
    );
    expect(before.rows[0].last_seen_at).toBeNull();

    const chat = await openSocket(srv.port, a.accessToken, { path: "/ws/chat" });
    await nextMessage(chat, (m) => m.type === "connection.ready");
    // Still null while ONLINE.
    const during = await pool.query<{ last_seen_at: string | null }>(
      `SELECT last_seen_at FROM users WHERE id=$1`,
      [a.userId],
    );
    expect(during.rows[0].last_seen_at).toBeNull();

    await closeSocket(chat);
    // Wait for the durable write (the OFFLINE transition handler is async).
    expect(await waitForLastSeenPersisted(a.userId)).toBe(true);
    const after = await pool.query<{ last_seen_at: string | null }>(
      `SELECT last_seen_at FROM users WHERE id=$1`,
      [a.userId],
    );
    expect(after.rows[0].last_seen_at).not.toBeNull();
  });
});

describe("presence: visibility privacy", () => {
  it("a matched, non-blocked observer can see presence", async () => {
    const [a, b] = await matchedPair();
    const res = await getPresence(b, a.userId);
    expect(res.status).toBe(200);
    expect(["ONLINE", "OFFLINE"]).toContain(res.body.data.status);
  });

  it("a stranger (no match) cannot see presence and gets a generic error", async () => {
    const a = await registerUser(srv.app);
    const stranger = await registerUser(srv.app);
    const res = await getPresence(stranger, a.userId);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("PRESENCE_NOT_AUTHORIZED");
    // Must not leak whether the user is online or exists.
    expect(JSON.stringify(res.body)).not.toContain("lastSeen");
  });

  it("a blocked match (block in either direction) cannot see presence", async () => {
    const [a, b] = await matchedPair();
    await insertBlock(a.userId, b.userId); // a blocks b
    expect((await getPresence(b, a.userId)).status).toBe(403);
    expect((await getPresence(a, b.userId)).status).toBe(403);
  });

  it("a user can always see their own presence", async () => {
    const a = await registerUser(srv.app);
    const res = await getPresence(a, a.userId);
    expect(res.status).toBe(200);
  });

  it("presence lookup requires authentication", async () => {
    const a = await registerUser(srv.app);
    const res = await request(srv.app).get(`/api/users/${a.userId}/presence`);
    expect(res.status).toBe(401);
  });

  it("a non-UUID target id is rejected", async () => {
    const a = await registerUser(srv.app);
    const res = await request(srv.app).get(`/api/users/not-a-uuid/presence`).set(...H(a));
    expect(res.status).toBe(400);
  });
});

describe("presence: real-time presence.changed fan-out", () => {
  it("an authorized observer who is online receives presence.changed when a match connects/disconnects", async () => {
    const [a, b] = await matchedPair();

    // b connects first and listens.
    const bSock = await openSocket(srv.port, b.accessToken, { path: "/ws/chat" });
    await nextMessage(bSock, (m) => m.type === "connection.ready");

    // a connects -> b should observe a going ONLINE.
    const aSock = await openSocket(srv.port, a.accessToken, { path: "/ws/chat" });
    await nextMessage(aSock, (m) => m.type === "connection.ready");
    const online = await nextMessage(
      bSock,
      (m) => m.type === "presence.changed" && m.userId === a.userId,
    );
    expect(online.status).toBe("ONLINE");

    // a disconnects -> b should observe a going OFFLINE with lastSeenAt.
    await closeSocket(aSock);
    const offline = await nextMessage(
      bSock,
      (m) => m.type === "presence.changed" && m.userId === a.userId && m.status === "OFFLINE",
    );
    expect(offline.status).toBe("OFFLINE");
    expect(offline.lastSeenAt).toBeTruthy();

    await closeSocket(bSock);
  });

  it("a stranger's socket never receives presence.changed for an unrelated user", async () => {
    const a = await registerUser(srv.app);
    const stranger = await registerUser(srv.app);

    const sSock = await openSocket(srv.port, stranger.accessToken, { path: "/ws/chat" });
    await nextMessage(sSock, (m) => m.type === "connection.ready");

    const aSock = await openSocket(srv.port, a.accessToken, { path: "/ws/chat" });
    await nextMessage(aSock, (m) => m.type === "connection.ready");

    // The stranger must NOT receive any presence.changed about a.
    await expect(
      nextMessage(sSock, (m) => m.type === "presence.changed" && m.userId === a.userId, 500),
    ).rejects.toThrow();

    await closeSocket(aSock);
    await closeSocket(sSock);
  });
});

describe("presence: notification.created real-time optimization", () => {
  it("a connected user receives a notification.created event mirroring the persisted notification", async () => {
    const [a, b] = await matchedPair();

    const bSock = await openSocket(srv.port, b.accessToken, { path: "/ws/chat" });
    await nextMessage(bSock, (m) => m.type === "connection.ready");

    // a sends b a message -> b gets MESSAGE_RECEIVED notification + WS event.
    const matchRow = await pool.query<{ id: string }>(
      `SELECT id FROM matches WHERE (user_a=$1 OR user_b=$1) LIMIT 1`,
      [a.userId],
    );
    const matchId = matchRow.rows[0].id;
    await request(srv.app)
      .post(`/api/matches/${matchId}/messages`)
      .set(...H(a))
      .send({ body: "hello there" });

    const evt = await nextMessage(bSock, (m) => m.type === "notification.created");
    const notif = evt.notification as Record<string, unknown>;
    expect(notif.type).toBe("MESSAGE_RECEIVED");
    // The event carries the SAME safe DTO: no message body leaked.
    expect(JSON.stringify(evt)).not.toContain("hello there");

    // It mirrors a persisted row (PostgreSQL is authoritative).
    const persisted = await pool.query(
      `SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND type='MESSAGE_RECEIVED'`,
      [b.userId],
    );
    expect(persisted.rows[0].n).toBe(1);

    await closeSocket(bSock);
  });
});

describe("presence: suspension flips user offline", () => {
  it("suspending a user force-closes their sockets and they become OFFLINE", async () => {
    const adminUser = await registerUser(srv.app);
    await setUserRole(adminUser.userId, "ADMIN");
    const [a, b] = await matchedPair();

    const aSock = await openSocket(srv.port, a.accessToken, { path: "/ws/chat" });
    await nextMessage(aSock, (m) => m.type === "connection.ready");
    expect((await getPresence(b, a.userId)).body.data.status).toBe("ONLINE");

    const closed = new Promise<void>((resolve) => aSock.once("close", () => resolve()));
    await request(srv.app)
      .post(`/api/admin/users/${a.userId}/suspend`)
      .set(...H(adminUser))
      .send({ reason: "x" });
    await Promise.race([
      closed,
      new Promise((_r, rej) => setTimeout(() => rej(new Error("socket not closed")), 3000)),
    ]);
    expect(aSock.readyState).toBeGreaterThanOrEqual(2);

    // After the forced close, presence accounting shows OFFLINE (wait for the
    // durable last-seen write driven by the OFFLINE transition).
    expect(await waitForLastSeenPersisted(a.userId)).toBe(true);
    expect(presenceRegistry.isOnline(a.userId)).toBe(false);
    // b can no longer observe a's presence (a is suspended -> match still ACTIVE,
    // so the lookup is authorized but reports OFFLINE).
    expect((await getPresence(b, a.userId)).body.data.status).toBe("OFFLINE");
    await closeSocket(aSock);
  });
});

/** Poll an async predicate until true or timeout (durable, DB-observable effects). */
async function waitForAsync(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (await predicate()) return true;
    if (Date.now() - start >= timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Durable signal that a user's final socket close has been fully processed by
 *  the server: last_seen_at has been persisted. Avoids racing the in-memory flag
 *  (which flips before the async transition handler commits its DB write). */
async function waitForLastSeenPersisted(userId: string, timeoutMs = 3000): Promise<boolean> {
  return waitForAsync(async () => {
    const { rows } = await pool.query<{ last_seen_at: string | null }>(
      `SELECT last_seen_at FROM users WHERE id=$1`,
      [userId],
    );
    return rows[0]?.last_seen_at != null;
  }, timeoutMs);
}
