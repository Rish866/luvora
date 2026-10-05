import { Router, type Request, type Response, type NextFunction } from "express";
import { config } from "../config";
import { metrics } from "./metrics";
import { Errors } from "../http/errors";
import { verifyAccessToken } from "../auth/tokens";
import { assertAccountActive } from "../auth/accountState";
import { UserRole } from "@luvora/shared";

/**
 * `/metrics` endpoint (Increment 10), Prometheus text exposition format.
 *
 * Access is configurable:
 *   - METRICS_ENABLED=false  → 404 (endpoint not present operationally).
 *   - METRICS_REQUIRE_AUTH=true (default) → requires a valid ADMIN access token.
 *
 * The output contains ONLY registered metric names + bounded labels — never
 * application data, PII, tokens, SQL, or payloads. Metrics are process-local
 * (not aggregated across instances).
 */
export const metricsRouter = Router();

metricsRouter.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!config.observability.metricsEnabled) {
      throw Errors.metricsDisabled();
    }
    if (config.observability.metricsRequireAuth) {
      await requireAdminToken(req);
    }
    res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(metrics.renderProm());
  } catch (err) {
    next(err);
  }
});

/** Minimal inline auth for /metrics: an ADMIN access token. Kept separate from
 *  the standard requireAuth chain so the endpoint can live outside /api. */
async function requireAdminToken(req: Request): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw Errors.metricsUnauthorized();
  const token = header.slice("Bearer ".length).trim();
  let claims;
  try {
    claims = verifyAccessToken(token);
  } catch {
    throw Errors.metricsUnauthorized();
  }
  const user = await assertAccountActive(claims.sub);
  if (!user) throw Errors.metricsUnauthorized();
  if (user.role !== UserRole.ADMIN) throw Errors.metricsUnauthorized();
}
