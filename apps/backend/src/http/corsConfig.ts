import cors, { type CorsOptions } from "cors";
import type { RequestHandler } from "express";
import { config } from "../config";

/** Normalize an origin for comparison: lowercase + trim trailing slashes. The
 *  allowlist in config is already normalized the same way. */
function normalize(origin: string): string {
  return origin.replace(/\/+$/, "").toLowerCase();
}

const allow = new Set(config.corsOrigins.map(normalize));

/**
 * CORS policy (Increment 11).
 *
 * Strict allowlist. Credentials are permitted, so a wildcard is never used
 * (config fail-fast also forbids `*` with credentials in production). Requests
 * with no Origin header (same-origin, curl, server-to-server, health probes)
 * are allowed through — CORS only governs browser cross-origin reads, and
 * blocking originless requests would break non-browser clients without adding
 * security. Disallowed browser origins are rejected (no CORS headers emitted),
 * which the browser enforces by blocking the response.
 */
export function corsMiddleware(): RequestHandler {
  const options: CorsOptions = {
    origin(origin, callback) {
      if (!origin) {
        // Non-browser / same-origin request: allow, but emit no ACAO header.
        callback(null, false);
        return;
      }
      callback(null, allow.has(normalize(origin)));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Correlation-Id"],
    exposedHeaders: ["X-Correlation-Id", "Retry-After"],
    maxAge: 600,
    optionsSuccessStatus: 204,
  };
  return cors(options);
}
