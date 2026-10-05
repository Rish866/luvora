import express, { type Express } from "express";
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
import { deviceRouter } from "./notifications/deviceRoutes";
import { presenceRouter } from "./presence/presenceRoutes";
import { initPresence } from "./presence/presenceService";
import { attachRealtimeSink } from "./notifications/realtime";
import { errorHandler } from "./http/errorHandler";
import { ok } from "./http/respond";
import { Errors } from "./http/errors";
import { makeRateLimiter } from "./http/rateLimiter";
import { securityHeaders, urlLengthGuard } from "./http/securityMiddleware";
import { corsMiddleware } from "./http/corsConfig";
import { correlationAndMetrics } from "./observability/httpMetrics";
import { buildReadiness, uptimeSeconds } from "./observability/health";
import { metricsRouter } from "./observability/metricsRoutes";

/** Build the Express application (no listening) so tests can import it. */
export function createApp(): Express {
  // Wire presence transitions (last-seen persistence + presence.changed events).
  initPresence();
  // Subscribe this process to the realtime bus so published notification/
  // presence events are fanned out to local sockets (Increment 8).
  attachRealtimeSink();

  const app = express();

  // Trust exactly the configured number of proxy hops so req.ip reflects the
  // real client without letting a client forge X-Forwarded-For. Default 0 means
  // "trust nothing" (direct connection); operators set TRUST_PROXY_HOPS to the
  // number of trusted reverse proxies in front of the app.
  app.set("trust proxy", config.security.trustProxyHops);
  // Centralised, API-appropriate security headers (helmet + explicit tuning).
  app.use(securityHeaders());
  // Strict CORS allowlist (credentials allowed, never a wildcard).
  app.use(corsMiddleware());
  // Reject absurdly long URLs before routing.
  app.use(urlLengthGuard());
  // JSON body limit (configurable; oversized bodies -> 413 via errorHandler).
  app.use(express.json({ limit: config.security.jsonBodyLimitBytes }));

  // Correlation id + request context + HTTP metrics (Increment 10). Runs early
  // so every downstream log/metric/error carries the correlation id, and so the
  // X-Correlation-Id response header is always set.
  app.use(correlationAndMetrics);

  // Global rate limit (pass-through under test).
  app.use(makeRateLimiter(config.rateLimit.max));

  // Liveness: cheap, does not depend on optional components (worker/push/etc.).
  app.get("/health", (_req, res) => ok(res, { status: "ok", uptimeSeconds: uptimeSeconds() }));
  // Readiness: verifies critical dependencies (DB reachable + schema). Returns a
  // structured report; 503 when not ready. Never leaks connection strings/SQL.
  app.get("/ready", async (_req, res, next) => {
    try {
      const report = await buildReadiness();
      ok(res, report, report.status === "ready" ? 200 : 503);
    } catch (err) {
      next(err);
    }
  });

  // Prometheus-compatible metrics (configurable: disabled => 404, auth optional).
  app.use("/metrics", metricsRouter);

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
  // Device registration is nested under notifications; mount it BEFORE the
  // notification router so /api/notifications/devices resolves here (and is not
  // captured by the notification router's /:id routes).
  app.use("/api/notifications/devices", deviceRouter);
  app.use("/api/notifications", notificationRouter);
  // Presence lookups live under /api/users/:userId/presence (coexists with the
  // block routes already mounted at /api/users).
  app.use("/api/users", presenceRouter);

  // 404 for unknown routes.
  app.use((_req, _res, next) => next(Errors.notFound("Route not found.")));

  app.use(errorHandler);
  return app;
}
