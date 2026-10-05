import type { RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import { config } from "../config";
import { Errors } from "./errors";

/** Build a rate limiter, or a pass-through when rate limiting is disabled
 *  (test environment). Keeps production behaviour identical to before. */
export function makeRateLimiter(max: number): RequestHandler {
  if (!config.rateLimitEnabled) {
    return (_req, _res, next) => next();
  }
  return rateLimit({
    windowMs: config.rateLimit.windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, _res, next) => next(Errors.rateLimited()),
  });
}
