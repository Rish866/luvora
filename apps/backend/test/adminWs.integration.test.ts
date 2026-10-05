import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import request from "supertest";
import { closePool } from "../src/db/pool";
import { presenceRegistry } from "../src/presence/presenceRegistry";
import {
  resetDb,
  registerUser,
  createMatch,
  setUserRole,
  auth,
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
  // Suspension force-closes sockets, which now drives an ASYNchronous presence
  // OFFLINE transition (persisting last-seen). Let any in-flight handler drain
  // and reset the shared registry so its DB work cannot overlap the next test
  // file's resetDb() TRUNCATE (which would deadlock).
  presenceRegistry.reset();
  await new Promise((r) => setTimeout(r, 150));
});
afterAll(async () => {
  await srv.close();
  await closePool();
});

async function admin(): Promise<RegisteredUser> {
  const u = await registerUser(srv.app);
  await setUserRole(u.userId, "ADMIN");
  return u;
}

describe("websocket safety: suspension", () => {
  it("suspended user's live chat socket is closed and cannot send", async () => {
    const a = await admin();
    const u1 = await registerUser(srv.app);
    const u2 = await registerUser(srv.app);
    const matchId = await createMatch(u1.userId, u2.userId);
    // Resolve conversation id.
    await request(srv.app).get(`/api/matches/${matchId}/messages`).set(...auth(u1.accessToken));

    const ws = await openSocket(srv.port, u1.accessToken);
    await nextMessage(ws, (m) => m.type === "connection.ready");

    // Admin suspends u1 -> server closes u1's sockets.
    const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
    await request(srv.app)
      .post(`/api/admin/users/${u1.userId}/suspend`)
      .set(...auth(a.accessToken))
      .send({ reason: "x" });
    // The socket should be force-closed by the server.
    await Promise.race([
      closed,
      new Promise((_r, rej) => setTimeout(() => rej(new Error("socket not closed")), 3000)),
    ]);
    void u2;
    await closeSocket(ws);
  });

  it("a suspended user cannot open a new WebSocket (handshake rejected)", async () => {
    const a = await admin();
    const u = await registerUser(srv.app);
    await request(srv.app).post(`/api/admin/users/${u.userId}/suspend`).set(...auth(a.accessToken)).send({ reason: "x" });
    await expect(openSocket(srv.port, u.accessToken)).rejects.toThrow();
  });

  it("suspended user's live game socket is closed and cannot keep acting", async () => {
    const a = await admin();
    const u = await registerUser(srv.app);
    const ws = await openSocket(srv.port, u.accessToken, { path: "/ws/game" });
    await nextMessage(ws, (m) => m.type === "game.ready");

    // Track closure from the moment we suspend.
    const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
    await request(srv.app)
      .post(`/api/admin/users/${u.userId}/suspend`)
      .set(...auth(a.accessToken))
      .send({ reason: "x" });

    // The server force-closes the suspended user's game socket.
    await Promise.race([
      closed,
      new Promise((_r, rej) => setTimeout(() => rej(new Error("socket not closed")), 3000)),
    ]);
    // readyState is CLOSING/CLOSED — further sends cannot reach the gameplay engine.
    expect(ws.readyState).toBeGreaterThanOrEqual(2); // 2=CLOSING, 3=CLOSED
    await closeSocket(ws);
  });

  it("existing /ws/chat and /ws/game still work for active users (regression)", async () => {
    const u = await registerUser(srv.app);
    const chat = await openSocket(srv.port, u.accessToken, { path: "/ws/chat" });
    expect((await nextMessage(chat, (m) => m.type === "connection.ready")).userId).toBe(u.userId);
    const game = await openSocket(srv.port, u.accessToken, { path: "/ws/game" });
    expect((await nextMessage(game, (m) => m.type === "game.ready")).userId).toBe(u.userId);
    await closeSocket(chat);
    await closeSocket(game);
  });
});
