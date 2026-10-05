import { createApp } from "./app";
import { config } from "./config";
import { logger } from "./logger";
import { closePool } from "./db/pool";
import { attachWsDispatcher } from "./ws/wsDispatcher";
import { attachChatGateway } from "./chat/chatGateway";
import { attachGameGateway } from "./fantasy/gameGateway";
import { startWorkerProcess } from "./jobs/workerMain";
import { setActiveWorker } from "./jobs/workerRegistry";
import { initAbuseBackend } from "./http/abuseInit";
import { closeRedis } from "./http/redisClient";

const app = createApp();

// Initialise the distributed abuse backend (Increment 12). For ABUSE_BACKEND=
// redis this connects and installs the Redis backend; for memory it is a no-op.
// Fire-and-forget: startup proceeds and readiness reflects Redis health.
void initAbuseBackend();

const server = app.listen(config.port, () => {
  logger.info({ port: config.port, env: config.nodeEnv }, "server listening");
});

// A single HTTP `upgrade` dispatcher hosts every WebSocket channel on the SAME
// HTTP server/port, routing /ws/chat and /ws/game by path after one shared
// authenticated handshake.
const wsDispatcher = attachWsDispatcher(server);
const chatGateway = attachChatGateway(wsDispatcher);
const gameGateway = attachGameGateway(wsDispatcher);

// Optionally run the job worker EMBEDDED in the API process. Off by default:
// the recommended production topology runs `npm run worker` as a separate
// process. When enabled, the queue is drained by this process too.
let embeddedWorkerStop: (() => Promise<void>) | null = null;
if (config.jobs.workerEnabled) {
  const { worker, stop } = startWorkerProcess();
  setActiveWorker(worker);
  embeddedWorkerStop = stop;
  logger.info({ workerId: worker.workerId }, "embedded job worker started");
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "shutting down");
  // Close WebSocket channels first so no new events arrive mid-shutdown.
  await chatGateway.close();
  await gameGateway.close();
  await wsDispatcher.closeAll();
  // Stop the embedded worker gracefully (if running).
  if (embeddedWorkerStop) {
    await embeddedWorkerStop();
    setActiveWorker(null);
  }
  server.close(async () => {
    // Drain the abuse Redis connection (if any) alongside the PG pool.
    await closeRedis();
    await closePool();
    process.exit(0);
  });
  // Force-exit if graceful shutdown stalls.
  setTimeout(() => process.exit(1), 15_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
