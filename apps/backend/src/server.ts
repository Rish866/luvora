import { createApp } from "./app";
import { config } from "./config";
import { logger } from "./logger";
import { closePool } from "./db/pool";
import { attachWsDispatcher } from "./ws/wsDispatcher";
import { attachChatGateway } from "./chat/chatGateway";
import { attachGameGateway } from "./fantasy/gameGateway";

const app = createApp();

const server = app.listen(config.port, () => {
  logger.info({ port: config.port, env: config.nodeEnv }, "server listening");
});

// A single HTTP `upgrade` dispatcher hosts every WebSocket channel on the SAME
// HTTP server/port, routing /ws/chat and /ws/game by path after one shared
// authenticated handshake.
const wsDispatcher = attachWsDispatcher(server);
const chatGateway = attachChatGateway(wsDispatcher);
const gameGateway = attachGameGateway(wsDispatcher);

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "shutting down");
  // Close WebSocket channels first so no new events arrive mid-shutdown.
  await chatGateway.close();
  await gameGateway.close();
  await wsDispatcher.closeAll();
  server.close(async () => {
    await closePool();
    process.exit(0);
  });
  // Force-exit if graceful shutdown stalls.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
