import express, { type Express } from "express";
import helmet from "helmet";
import cors from "cors";
import { config } from "./config";
import { authRouter } from "./auth/authRoutes";
import { sessionRouter } from "./fantasy/sessionRoutes";
import { discoveryRouter } from "./discovery/discoveryRoutes";
import { matchRouter } from "./discovery/matchRoutes";
import { userBlockRouter } from "./discovery/blockRoutes";
import { errorHandler } from "./http/errorHandler";
import { ok } from "./http/respond";
import { Errors } from "./http/errors";
import { makeRateLimiter } from "./http/rateLimiter";
import { pool } from "./db/pool";

/** Build the Express application (no listening) so tests can import it. */
export function createApp(): Express {
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
  app.use("/api/matches", matchRouter);
  app.use("/api/users", userBlockRouter);

  // 404 for unknown routes.
  app.use((_req, _res, next) => next(Errors.notFound("Route not found.")));

  app.use(errorHandler);
  return app;
}
