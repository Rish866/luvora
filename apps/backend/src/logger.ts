import pino from "pino";
import { config } from "./config";

/** Structured logger. In production, emit JSON for log aggregation. */
export const logger = pino({
  level: config.isTest ? "silent" : config.isProduction ? "info" : "debug",
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
