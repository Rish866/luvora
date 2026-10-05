import pino from "pino";
import { config } from "./config";

/** Structured logger. In production, emit JSON for log aggregation. */
export const logger = pino({
  // Level is config-driven (LOG_LEVEL); forced to 'silent' under test.
  level: config.observability.logLevel,
  base: undefined, // omit pid/hostname noise
  redact: {
    // Never log secrets or sensitive content.
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "password",
      "passwordHash",
      "*.password",
      "*.passwordHash",
      "token",
      "refreshToken",
    ],
    censor: "[redacted]",
  },
});
