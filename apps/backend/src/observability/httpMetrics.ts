import type { NextFunction, Request, Response } from "express";
import {
  runWithContext,
  sanitizeIncomingCorrelationId,
  newCorrelationId,
  setContextFields,
  type RequestContext,
} from "./requestContext";
import { metrics, statusClass } from "./metrics";
import { log } from "./logger";

/** Header carrying the correlation id (accepted inbound, always returned). */
export const CORRELATION_HEADER = "x-correlation-id";

/**
 * Correlation + HTTP metrics middleware (Increment 10).
 *
 * - Establishes a request context with a correlation id: a safe inbound
 *   `X-Correlation-Id` is honoured; anything missing/oversized/malformed gets a
 *   fresh random id. The id is echoed in the response header.
 * - Records http_requests_total / http_errors_total / http_request_duration_ms
 *   on response finish, labelled by a BOUNDED route template (never a raw URL
 *   with ids), method, and status class — so arbitrary UUIDs can't explode
 *   metric cardinality.
 *
 * Observability is best-effort: a metrics/logging failure never breaks the
 * request.
 */
export function correlationAndMetrics(req: Request, res: Response, next: NextFunction): void {
  const incoming = sanitizeIncomingCorrelationId(req.headers[CORRELATION_HEADER]);
  const correlationId = incoming ?? newCorrelationId();
  const ctx: RequestContext = { correlationId };

  // Always return the (validated/generated) id — never echo a raw unsafe value.
  try {
    res.setHeader("X-Correlation-Id", correlationId);
  } catch {
    /* ignore */
  }

  const started = Date.now();
  res.on("finish", () => {
    try {
      const route = normalizedRoute(req);
      const labels = {
        route,
        method: req.method,
        status_class: statusClass(res.statusCode),
      };
      metrics.incr("http_requests_total", labels);
      if (res.statusCode >= 400) {
        metrics.incr("http_errors_total", labels);
      }
      metrics.observe("http_request_duration_ms", Date.now() - started, {
        route,
        method: req.method,
      });
    } catch {
      /* best-effort */
    }
  });

  runWithContext(ctx, () => {
    // Record the normalized route into the context once Express has matched it.
    // req.route is only available after routing; we compute a safe label lazily.
    setContextFields({ route: normalizedRoute(req) });
    next();
  });
}

/**
 * Produce a BOUNDED route label. Prefers Express's matched route pattern
 * (template with :params). Falls back to a conservatively-normalized path that
 * replaces UUIDs/numeric ids with ":id" so a unique id never becomes a label.
 */
export function normalizedRoute(req: Request): string {
  // Express sets req.route.path after matching; combine with baseUrl for nesting.
  const matched = (req as unknown as { route?: { path?: string } }).route?.path;
  const baseUrl = req.baseUrl ?? "";
  if (matched && typeof matched === "string") {
    return `${baseUrl}${matched}` || matched;
  }
  // Fallback: normalize the raw path (strip query, collapse id-like segments).
  const path = (req.originalUrl || req.url || "").split("?")[0];
  return `${req.method === "" ? "" : ""}${collapseIds(path)}`;
}

const UUID_SEG = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const NUMERIC_SEG = /^\d+$/;
const LONG_SEG = /^[^/]{40,}$/; // very long opaque segments (tokens/cursors)

function collapseIds(path: string): string {
  const segments = path.split("/").map((s) => {
    if (UUID_SEG.test(s) || NUMERIC_SEG.test(s) || LONG_SEG.test(s)) return ":id";
    return s;
  });
  const normalized = segments.join("/") || "/";
  // Hard cap the label length as a final cardinality guard.
  return normalized.slice(0, 120);
}

/** Log a completed request at debug level with correlation context. Attached as
 *  a separate finish listener kept minimal to avoid logging bodies/headers. */
export function logRequestOnFinish(req: Request, res: Response): void {
  res.on("finish", () => {
    log.debug(
      { route: normalizedRoute(req), method: req.method, status: res.statusCode },
      "http.request",
    );
  });
}
