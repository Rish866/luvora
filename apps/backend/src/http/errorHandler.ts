import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { AppError, Errors } from "./errors";
import { fail } from "./respond";
import { logger } from "../logger";

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

  // Unknown / unexpected: log full detail server-side, return opaque 500.
  logger.error({ err }, "unhandled error");
  const internal = Errors.internal();
  fail(res, internal.httpStatus, internal.code, internal.message);
}
