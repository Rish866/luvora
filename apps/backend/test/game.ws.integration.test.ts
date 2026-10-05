import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { closePool, pool } from "../src/db/pool";
import { seedScenarios } from "../src/db/scenarioSeed";
import {
  resetDb,
  registerUser,
  createMatch,
  createPlayingSession,
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
import request from "supertest";

let srv: LiveServer;

beforeAll(async () => {
  srv = await startLiveServer();
});
beforeEach(async () => {
  await resetDb();
  await seedScenarios();
});
afterAll(async () => {
  await srv.close();
  await closePool();
});

const uuid = () =>
  "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });

async function scenarioId(slug: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM scenarios WHERE slug = $1`, [slug]);
  return rows[0].id;
}

/** A PLAYING session with a selected scenario, plus the first node's choices. */
async function startedGame(): Promise<{
  a: RegisteredUser;
  b: RegisteredUser;
  sessionId: string;
  choices: { id: string; key: string }[];
}> {
  const a = await registerUser(srv.app);
  const b = await registerUser(srv.app);
  const matchId = await createMatch(a.userId, b.userId);
  const sessionId = await createPlayingSession(srv.app, a, b, matchId, [
    "flirting",
    "teasing",
    "roleplay",
    "mystery",
  ]);
  const sel = await request(srv.app)
    .post(`/api/sessions/${sessionId}/scenario`)
    .set(...auth(a.accessToken))
    .send({ scenarioId: await scenarioId("the-midnight-masquerade") });
  return { a, b, sessionId, choices: sel.body.data.state.node.choices };
}

const openGame = (token: string | null) =>
  openSocket(srv.port, token, { path: "/ws/game" });

describe("game websocket: connection & auth", () => {
  it("authenticated connection receives game.ready", async () => {
    const a = await registerUser(srv.app);
    const ws = await openGame(a.accessToken);
    const ready = await nextMessage(ws, (m) => m.type === "game.ready");
    expect(ready.userId).toBe(a.userId);
    await closeSocket(ws);
  });

  it("invalid and missing tokens are rejected at handshake", async () => {
    await expect(openGame("bogus")).rejects.toThrow();
    await expect(openGame(null)).rejects.toThrow();
  });

  it("chat and game channels coexist on the same server", async () => {
    const a = await registerUser(srv.app);
    const chatWs = await openSocket(srv.port, a.accessToken, { path: "/ws/chat" });
    const gameWs = await openGame(a.accessToken);
    expect((await nextMessage(chatWs, (m) => m.type === "connection.ready")).userId).toBe(a.userId);
    expect((await nextMessage(gameWs, (m) => m.type === "game.ready")).userId).toBe(a.userId);
    await closeSocket(chatWs);
    await closeSocket(gameWs);
  });
});

describe("game websocket: subscribe & choose", () => {
  it("subscribe returns authoritative state (reconnect-safe)", async () => {
    const { a, sessionId } = await startedGame();
    const ws = await openGame(a.accessToken);
    await nextMessage(ws, (m) => m.type === "game.ready");
    send(ws, { type: "game.subscribe", sessionId });
    const state = await nextMessage(ws, (m) => m.type === "game.state");
    const s = state.state as Record<string, unknown>;
    expect(s.sessionId).toBe(sessionId);
    expect((s.node as { key: string }).key).toBe("start");
    await closeSocket(ws);
  });

  it("choose broadcasts a state change to BOTH participants", async () => {
    const { a, b, sessionId, choices } = await startedGame();
    const wsA = await openGame(a.accessToken);
    const wsB = await openGame(b.accessToken);
    await nextMessage(wsA, (m) => m.type === "game.ready");
    await nextMessage(wsB, (m) => m.type === "game.ready");

    const takeHand = choices.find((c) => c.key === "take_hand")!;
    const recvA = nextMessage(wsA, (m) => m.type === "game.state.changed");
    const recvB = nextMessage(wsB, (m) => m.type === "game.state.changed");
    send(wsA, {
      type: "game.choose",
      sessionId,
      choiceId: takeHand.id,
      clientActionId: uuid(),
    });
    const [ea, eb] = await Promise.all([recvA, recvB]);
    expect((ea.state as { node: { key: string } }).node.key).toBe("dance");
    expect((eb.state as { node: { key: string } }).node.key).toBe("dance");
    // Persisted.
    const { rows } = await pool.query(`SELECT turn_number FROM fantasy_sessions WHERE id = $1`, [
      sessionId,
    ]);
    expect(rows[0].turn_number).toBe(1);
    await closeSocket(wsA);
    await closeSocket(wsB);
  });

  it("reaching an ending emits game.completed", async () => {
    const { a, sessionId, choices } = await startedGame();
    const ws = await openGame(a.accessToken);
    await nextMessage(ws, (m) => m.type === "game.ready");
    // start -> step_back -> balcony
    const stepBack = choices.find((c) => c.key === "step_back")!;
    const afterStep = nextMessage(ws, (m) => m.type === "game.state.changed");
    send(ws, { type: "game.choose", sessionId, choiceId: stepBack.id, clientActionId: uuid() });
    const balcony = (await afterStep).state as { node: { choices: { id: string; key: string }[] } };
    const keepDistance = balcony.node.choices.find((c) => c.key === "keep_distance")!;
    const completed = nextMessage(ws, (m) => m.type === "game.completed");
    send(ws, { type: "game.choose", sessionId, choiceId: keepDistance.id, clientActionId: uuid() });
    const evt = await completed;
    expect((evt.state as { completed: boolean }).completed).toBe(true);
    await closeSocket(ws);
  });

  it("unrelated user's choose over WS is rejected and receives nothing private", async () => {
    const { sessionId, choices } = await startedGame();
    const c = await registerUser(srv.app);
    const wsC = await openGame(c.accessToken);
    await nextMessage(wsC, (m) => m.type === "game.ready");
    const err = nextMessage(wsC, (m) => m.type === "game.error");
    send(wsC, {
      type: "game.choose",
      sessionId,
      choiceId: choices[0].id,
      clientActionId: uuid(),
    });
    expect((await err).code).toBe("GAME_NOT_AUTHORIZED");
    await closeSocket(wsC);
  });

  it("malformed / invalid events return structured game.error without crashing", async () => {
    const a = await registerUser(srv.app);
    const ws = await openGame(a.accessToken);
    await nextMessage(ws, (m) => m.type === "game.ready");

    ws.send("not json");
    expect((await nextMessage(ws, (m) => m.type === "game.error")).code).toBe(
      "INVALID_WEBSOCKET_MESSAGE",
    );
    send(ws, { type: "game.unknown" });
    expect((await nextMessage(ws, (m) => m.type === "game.error")).code).toBe(
      "INVALID_WEBSOCKET_MESSAGE",
    );
    // Still alive: a valid subscribe to a session we don't own returns an error,
    // not a crash.
    send(ws, { type: "game.subscribe", sessionId: "00000000-0000-0000-0000-000000000000" });
    expect((await nextMessage(ws, (m) => m.type === "game.error")).code).toBe("GAME_NOT_AUTHORIZED");
    await closeSocket(ws);
  });

  it("duplicate clientActionId over WS does not double-advance", async () => {
    const { a, sessionId, choices } = await startedGame();
    const ws = await openGame(a.accessToken);
    await nextMessage(ws, (m) => m.type === "game.ready");
    const takeHand = choices.find((c) => c.key === "take_hand")!;
    const cid = uuid();
    const first = nextMessage(ws, (m) => m.type === "game.state.changed");
    send(ws, { type: "game.choose", sessionId, choiceId: takeHand.id, clientActionId: cid });
    await first;
    // Second identical action: broadcasts current (unchanged) state.
    const second = nextMessage(ws, (m) => m.type === "game.state.changed");
    send(ws, { type: "game.choose", sessionId, choiceId: takeHand.id, clientActionId: cid });
    const evt = await second;
    expect((evt.state as { turnNumber: number }).turnNumber).toBe(1);
    const { rows } = await pool.query(`SELECT turn_number FROM fantasy_sessions WHERE id = $1`, [
      sessionId,
    ]);
    expect(rows[0].turn_number).toBe(1);
    await closeSocket(ws);
  });
});
