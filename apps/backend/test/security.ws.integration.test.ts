import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import type { WebSocket } from "ws";
import { ChatCloseCodes } from "@luvora/shared";
import { closePool } from "../src/db/pool";
import { presenceRegistry } from "../src/presence/presenceRegistry";
import { resetDb, registerUser } from "./helpers";
import {
  startLiveServer,
  openSocket,
  nextMessage,
  closeSocket,
  type LiveServer,
} from "./wsHelpers";

/**
 * WebSocket hardening (Increment 11). verify.ts sets
 * WS_MAX_CONNECTIONS_PER_USER=3 and WS_MAX_FRAME_BYTES=4096.
 *
 * NOTE: the per-connection EVENT throttle is intentionally disabled under
 * NODE_ENV=test (config.rateLimitEnabled === false) so the suite can drive many
 * events; it is exercised by the live smoke run instead. The connection cap and
 * frame-size limit are NOT gated by that switch and are tested here.
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

/** Wait for a socket to close, resolving with the close code. */
function closeCodeOf(ws: WebSocket, timeoutMs = 3000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("socket did not close")), timeoutMs);
    ws.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

describe("ws: per-user connection cap", () => {
  it("allows up to the configured max concurrent connections", async () => {
    const u = await registerUser(srv.app);
    const sockets: WebSocket[] = [];
    for (let i = 0; i < 3; i++) {
      const ws = await openSocket(srv.port, u.accessToken);
      await nextMessage(ws, (m) => m.type === "connection.ready");
      sockets.push(ws);
    }
    expect(sockets.length).toBe(3);
    for (const ws of sockets) await closeSocket(ws);
  });

  it("rejects the connection beyond the cap with TOO_MANY_CONNECTIONS (4429)", async () => {
    const u = await registerUser(srv.app);
    const sockets: WebSocket[] = [];
    for (let i = 0; i < 3; i++) {
      const ws = await openSocket(srv.port, u.accessToken);
      await nextMessage(ws, (m) => m.type === "connection.ready");
      sockets.push(ws);
    }
    // The 4th connection opens (handshake succeeds) then is closed by the cap.
    const extra = await openSocket(srv.port, u.accessToken);
    const code = await closeCodeOf(extra);
    expect(code).toBe(ChatCloseCodes.TOO_MANY_CONNECTIONS);
    for (const ws of sockets) await closeSocket(ws);
  });

  it("frees a slot after a connection closes", async () => {
    const u = await registerUser(srv.app);
    const sockets: WebSocket[] = [];
    for (let i = 0; i < 3; i++) {
      const ws = await openSocket(srv.port, u.accessToken);
      await nextMessage(ws, (m) => m.type === "connection.ready");
      sockets.push(ws);
    }
    // Close one, wait for the server to observe the close, then reconnect.
    await closeSocket(sockets[0]);
    await new Promise((r) => setTimeout(r, 150));
    const reconnect = await openSocket(srv.port, u.accessToken);
    const ready = await nextMessage(reconnect, (m) => m.type === "connection.ready");
    expect(ready.userId).toBe(u.userId);
    await closeSocket(reconnect);
    await closeSocket(sockets[1]);
    await closeSocket(sockets[2]);
  });

  it("caps are per-user (one user does not consume another's budget)", async () => {
    const a = await registerUser(srv.app);
    const b = await registerUser(srv.app);
    const aSockets: WebSocket[] = [];
    for (let i = 0; i < 3; i++) {
      const ws = await openSocket(srv.port, a.accessToken);
      await nextMessage(ws, (m) => m.type === "connection.ready");
      aSockets.push(ws);
    }
    // b still has a full budget.
    const bWs = await openSocket(srv.port, b.accessToken);
    const ready = await nextMessage(bWs, (m) => m.type === "connection.ready");
    expect(ready.userId).toBe(b.userId);
    await closeSocket(bWs);
    for (const ws of aSockets) await closeSocket(ws);
  });
});

describe("ws: inbound frame-size limit", () => {
  it("closes the socket when an oversized frame is sent (maxPayload)", async () => {
    const u = await registerUser(srv.app);
    const ws = await openSocket(srv.port, u.accessToken);
    await nextMessage(ws, (m) => m.type === "connection.ready");
    // Send a frame well above WS_MAX_FRAME_BYTES (4096). `ws` closes with 1009.
    const huge = JSON.stringify({ type: "noise", blob: "x".repeat(20000) });
    const closed = closeCodeOf(ws, 3000);
    ws.send(huge);
    const code = await closed;
    expect(code).toBe(1009); // 1009 = message too big
  });

  it("accepts a normal-sized frame", async () => {
    const u = await registerUser(srv.app);
    const ws = await openSocket(srv.port, u.accessToken);
    await nextMessage(ws, (m) => m.type === "connection.ready");
    // A small, well-formed (but unsupported) event should NOT close the socket;
    // the gateway replies with an error event instead.
    ws.send(JSON.stringify({ type: "totally.unknown" }));
    const err = await nextMessage(ws, (m) => m.type === "error");
    expect(err.code).toBe("INVALID_WEBSOCKET_MESSAGE");
    await closeSocket(ws);
  });
});
