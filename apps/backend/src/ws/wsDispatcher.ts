import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { authenticateUpgrade, upgradePath } from "./wsAuth";

/**
 * A single HTTP `upgrade` dispatcher shared by all WebSocket channels.
 *
 * Each channel registers a path (e.g. "/ws/chat", "/ws/game") and a connection
 * handler. The dispatcher authenticates the handshake ONCE, routes to the
 * matching channel's own WebSocketServer (noServer), and rejects unauthenticated
 * or unknown-path upgrades. Using one `upgrade` listener avoids multiple
 * listeners fighting over (and destroying) each other's sockets.
 */
export interface WsChannel {
  path: string;
  wss: WebSocketServer;
  onConnection: (socket: WebSocket, req: IncomingMessage, userId: string) => void;
}

export interface WsDispatcher {
  register(channel: WsChannel): void;
  closeAll(): Promise<void>;
}

export function attachWsDispatcher(httpServer: HttpServer): WsDispatcher {
  const channels = new Map<string, WsChannel>();

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const path = upgradePath(req);
    const channel = channels.get(path);
    if (!channel) {
      // Unknown WS path: refuse cleanly.
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    void authenticateUpgrade(req).then((userId) => {
      if (!userId) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      channel.wss.handleUpgrade(req, socket, head, (ws) => {
        channel.onConnection(ws, req, userId);
      });
    });
  };

  httpServer.on("upgrade", onUpgrade);

  return {
    register(channel: WsChannel): void {
      channels.set(channel.path, channel);
    },
    closeAll(): Promise<void> {
      httpServer.off("upgrade", onUpgrade);
      return Promise.all(
        [...channels.values()].map(
          (c) => new Promise<void>((resolve) => c.wss.close(() => resolve())),
        ),
      ).then(() => undefined);
    },
  };
}
