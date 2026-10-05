import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { AppError, Errors } from "./errors";
import { fail } from "./respond";
import { logger } from "../logger";
import { metrics } from "../observability/metrics";

/**
 * Central error handler. Converts known error types into the standard envelope
 * and, crucially, never leaks internals (stack traces, SQL, driver messages)
 * to clients. Unknown errors become a generic 500.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    // Emit a Retry-After header for throttling responses when the error carries
    // a hint (set by the abuse guard / brute-force gate).
    if (typeof err.retryAfterSeconds === "number" && !res.headersSent) {
      res.setHeader("Retry-After", String(err.retryAfterSeconds));
    }
    fail(res, err.httpStatus, err.code, err.message, err.details);
    return;
  }

  if (err instanceof ZodError) {
    const safe = err.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    }));
    fail(res, 400, "VALIDATION_ERROR", "Invalid request.", safe);
    return;
  }

  // body-parser signals an oversized request body with a typed error; map it to
  // our standard 413 envelope instead of a generic 500 (and never echo size).
  if (
    typeof err === "object" &&
    err !== null &&
    (err as { type?: string }).type === "entity.too.large"
  ) {
    try {
      metrics.incr("oversized_requests_total", { kind: "body" });
    } catch {
      /* telemetry best-effort */
    }
    const e = Errors.payloadTooLarge("Request body is too large.");
    fail(res, e.httpStatus, e.code, e.message);
    return;
  }

  // Unknown / unexpected: log full detail server-side, return opaque 500.
  logger.error({ err }, "unhandled error");
  const internal = Errors.internal();
  fail(res, internal.httpStatus, internal.code, internal.message);
}
