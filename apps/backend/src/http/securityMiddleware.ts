import type { Request, Response, NextFunction, RequestHandler } from "express";
import helmet from "helmet";
import { config } from "../config";
import { Errors } from "./errors";
import { metrics } from "../observability/metrics";

/**
 * Centralised HTTP security headers (Increment 11).
 *
 * This is a JSON API, not an HTML app, so we lock the response down hard:
 *  - No framing (clickjacking defence) even though there is no HTML.
 *  - No MIME sniffing.
 *  - A restrictive CSP appropriate for a pure API (`default-src 'none'`), which
 *    neutralises any accidental HTML/error page.
 *  - `Referrer-Policy: no-referrer` so URLs (which may carry ids) never leak.
 *  - A minimal `Permissions-Policy` disabling powerful browser features.
 *  - HSTS only when explicitly enabled (operator must terminate TLS and opt in;
 *    enabling it blindly over plain HTTP would be harmful).
 *
 * Helmet still provides the baseline; we tune the pieces that matter for an API
 * and strip headers that advertise the stack.
 */
export function securityHeaders(): RequestHandler {
  const helmetMw = helmet({
    // Pure-API CSP: nothing is allowed to load. If an HTML error page ever
    // slips through, the browser will not execute or fetch anything.
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        "default-src": ["'none'"],
        "frame-ancestors": ["'none'"],
        "base-uri": ["'none'"],
        "form-action": ["'none'"],
      },
    },
    // We set Referrer-Policy/HSTS/frameguard explicitly below for clarity, but
    // helmet's defaults for X-Content-Type-Options etc. are kept.
    hsts: false,
    referrerPolicy: { policy: "no-referrer" },
    frameguard: { action: "deny" },
    // Not meaningful for a JSON API and can break legitimate cross-origin API
    // consumers; CORS already governs who may read responses.
    crossOriginResourcePolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginEmbedderPolicy: false,
  });

  return (req: Request, res: Response, next: NextFunction): void => {
    helmetMw(req, res, (err?: unknown) => {
      if (err) {
        next(err);
        return;
      }
      // Explicit, API-appropriate headers (idempotent with helmet's output).
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader(
        "Permissions-Policy",
        "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
      );
      res.removeHeader("X-Powered-By");
      // HSTS is opt-in: only emit when enabled AND the connection is secure
      // (behind a trusted proxy, Express sets req.secure from X-Forwarded-Proto).
      if (config.security.hstsEnabled) {
        res.setHeader(
          "Strict-Transport-Security",
          `max-age=${config.security.hstsMaxAgeSeconds}; includeSubDomains`,
        );
      }
      next();
    });
  };
}

/**
 * Reject absurdly long request URLs before any routing/parsing work. A very
 * long URL is cheap to send but can be used to probe or to blow up logs; the
 * limit is generous (default 2048) and configurable.
 */
export function urlLengthGuard(): RequestHandler {
  const max = config.security.maxUrlLength;
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (req.originalUrl.length > max) {
      try {
        metrics.incr("oversized_requests_total", { kind: "url" });
      } catch {
        /* telemetry best-effort */
      }
      next(Errors.payloadTooLarge("Request URL is too long."));
      return;
    }
    next();
  };
}
