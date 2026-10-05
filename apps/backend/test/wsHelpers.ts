import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import type { Express } from "express";
import { createApp } from "../src/app";
import { attachWsDispatcher, type WsDispatcher } from "../src/ws/wsDispatcher";
import { attachChatGateway, type ChatGateway } from "../src/chat/chatGateway";
import { attachGameGateway, type GameGateway } from "../src/fantasy/gameGateway";

/** Boot a real HTTP server + both WS channels on an ephemeral port for tests. */
export interface LiveServer {
  app: Express;
  server: Server;
  dispatcher: WsDispatcher;
  gateway: ChatGateway;
  gameGateway: GameGateway;
  port: number;
  close: () => Promise<void>;
}

export async function startLiveServer(): Promise<LiveServer> {
  const app = createApp();
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const dispatcher = attachWsDispatcher(server);
  const gateway = attachChatGateway(dispatcher);
  const gameGateway = attachGameGateway(dispatcher);
  const port = (server.address() as AddressInfo).port;
  return {
    app,
    server,
    dispatcher,
    gateway,
    gameGateway,
    port,
    close: async () => {
      await gateway.close();
      await gameGateway.close();
      await dispatcher.closeAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * A test WebSocket that BUFFERS every inbound message from the moment the
 * socket is created. This avoids a race where the server's immediate
 * `connection.ready` (and any fast follow-up) arrives before a test attaches a
 * listener. `waitFor` drains the buffer first, then waits for new messages.
 */
export interface TestSocket {
  ws: WebSocket;
  waitFor: (
    predicate?: (msg: Record<string, unknown>) => boolean,
    timeoutMs?: number,
  ) => Promise<Record<string, unknown>>;
}

interface Waiter {
  predicate: (msg: Record<string, unknown>) => boolean;
  resolve: (msg: Record<string, unknown>) => void;
  timer: NodeJS.Timeout;
}

const bufferBySocket = new WeakMap<WebSocket, Record<string, unknown>[]>();
const waitersBySocket = new WeakMap<WebSocket, Waiter[]>();

/** Open an authenticated WebSocket to the chat gateway. Resolves once the
 *  socket is open. A SINGLE message handler (attached before open) buffers
 *  every inbound message and matches it against pending waiters in FIFO order,
 *  so no message is missed and each is consumed exactly once. */
export function openSocket(
  port: number,
  token: string | null,
  opts: { viaQuery?: boolean; path?: string } = {},
): Promise<WebSocket> {
  const base = `ws://127.0.0.1:${port}${opts.path ?? "/ws/chat"}`;
  const url = token && opts.viaQuery ? `${base}?access_token=${encodeURIComponent(token)}` : base;
  const headers =
    token && !opts.viaQuery ? { Authorization: `Bearer ${token}` } : undefined;
  const ws = new WebSocket(url, { headers });
  bufferBySocket.set(ws, []);
  waitersBySocket.set(ws, []);

  ws.on("message", (data) => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(String(data));
    } catch {
      return;
    }
    const waiters = waitersBySocket.get(ws)!;
    // First-matching pending waiter (FIFO) consumes the message.
    const idx = waiters.findIndex((w) => w.predicate(parsed));
    if (idx !== -1) {
      const [w] = waiters.splice(idx, 1);
      clearTimeout(w.timer);
      w.resolve(parsed);
    } else {
      bufferBySocket.get(ws)!.push(parsed);
    }
  });

  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", (err) => reject(err));
    ws.once("unexpected-response", (_req, res) => {
      reject(new Error(`unexpected-response ${res.statusCode}`));
    });
  });
}

/** Wait for a buffered-or-future message matching the predicate (consumed once). */
export function nextMessage(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean = () => true,
  timeoutMs = 3000,
): Promise<Record<string, unknown>> {
  const buffer = bufferBySocket.get(ws) ?? [];
  const idx = buffer.findIndex((m) => predicate(m));
  if (idx !== -1) {
    const [msg] = buffer.splice(idx, 1);
    return Promise.resolve(msg);
  }
  return new Promise((resolve, reject) => {
    const waiters = waitersBySocket.get(ws)!;
    const timer = setTimeout(() => {
      const i = waiters.indexOf(waiter);
      if (i !== -1) waiters.splice(i, 1);
      reject(new Error("timed out waiting for message"));
    }, timeoutMs);
    const waiter: Waiter = { predicate, resolve, timer };
    waiters.push(waiter);
  });
}

export function send(ws: WebSocket, obj: unknown): void {
  ws.send(JSON.stringify(obj));
}

export function closeSocket(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once("close", () => resolve());
    ws.close();
  });
}
