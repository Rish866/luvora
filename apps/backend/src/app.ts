import express, { type Express } from "express";
import helmet from "helmet";
import cors from "cors";
import { config } from "./config";
import { authRouter } from "./auth/authRoutes";
import { sessionRouter } from "./fantasy/sessionRoutes";
import { discoveryRouter } from "./discovery/discoveryRoutes";
import { matchRouter } from "./discovery/matchRoutes";
import { userBlockRouter } from "./discovery/blockRoutes";
import { chatRouter } from "./chat/chatRoutes";
import { scenarioRouter } from "./scenario/scenarioRoutes";
import { mediaRouter } from "./media/mediaRoutes";
import { adminRouter } from "./admin/adminRoutes";
import { reportRouter } from "./admin/reportRoutes";
import { notificationRouter } from "./notifications/notificationRoutes";
import { presenceRouter } from "./presence/presenceRoutes";
import { initPresence } from "./presence/presenceService";
import { errorHandler } from "./http/errorHandler";
import { ok } from "./http/respond";
import { Errors } from "./http/errors";
import { makeRateLimiter } from "./http/rateLimiter";
import { pool } from "./db/pool";

/** Build the Express application (no listening) so tests can import it. */
export function createApp(): Express {
  // Wire presence transitions (last-seen persistence + presence.changed events).
  initPresence();

  const app = express();

  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(
    cors({
      origin: config.corsOrigins.length ? config.corsOrigins : false,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: "1mb" }));

  // Global rate limit (pass-through under test).
  app.use(makeRateLimiter(config.rateLimit.max));

  // Health & readiness.
  app.get("/health", (_req, res) => ok(res, { status: "ok" }));
  app.get("/ready", async (_req, res, next) => {
    try {
      await pool.query("SELECT 1");
      ok(res, { status: "ready" });
    } catch (err) {
      next(err);
    }
  });

  app.use("/api/auth", authRouter);
  app.use("/api/sessions", sessionRouter);
  app.use("/api/discovery", discoveryRouter);
  // Chat history/send is nested under a match; mount it BEFORE the match router
  // so /api/matches/:matchId/messages resolves to the chat router.
  app.use("/api/matches/:matchId/messages", chatRouter);
  app.use("/api/matches", matchRouter);
  app.use("/api/users", userBlockRouter);
  app.use("/api/scenarios", scenarioRouter);
  app.use("/api/media", mediaRouter);
  app.use("/api/reports", reportRouter);
  app.use("/api/admin", adminRouter);
  app.use("/api/notifications", notificationRouter);
  // Presence lookups live under /api/users/:userId/presence (coexists with the
  // block routes already mounted at /api/users).
  app.use("/api/users", presenceRouter);

  // 404 for unknown routes.
  app.use((_req, _res, next) => next(Errors.notFound("Route not found.")));

  app.use(errorHandler);
  return app;
}
