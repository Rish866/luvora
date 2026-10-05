import { createApp } from "./app";
import { config } from "./config";
import { logger } from "./logger";
import { closePool } from "./db/pool";
import { attachChatGateway } from "./chat/chatGateway";

const app = createApp();

const server = app.listen(config.port, () => {
  logger.info({ port: config.port, env: config.nodeEnv }, "server listening");
});

// Attach the WebSocket chat gateway to the SAME HTTP server (shared port).
const chatGateway = attachChatGateway(server);

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "shutting down");
  // Close WebSocket connections first so no new events arrive mid-shutdown.
  await chatGateway.close();
  server.close(async () => {
    await closePool();
    process.exit(0);
  });
  // Force-exit if graceful shutdown stalls.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
