import { logger as baseLogger } from "../logger";
import { config } from "../config";
import { currentContext } from "./requestContext";

/**
 * Centralized structured logger (Increment 10).
 *
 * Wraps the base pino logger to:
 *  - automatically attach the current correlation/request context
 *    (correlationId / userId / route / jobId / workerId) when present,
 *  - add stable service/environment fields,
 *  - serialize errors SAFELY (code + bounded message only — never a raw Error
 *    whose arbitrary properties might carry sensitive data).
 *
 * Logging is best-effort: a serialization problem must never break a request.
 * The base pino instance already redacts auth headers/password/token fields.
 */

const SERVICE = "luvora-backend";

export type LogLevel = "debug" | "info" | "warn" | "error";

interface LogFields {
  [k: string]: unknown;
}

/** Keys that must never be logged even if a caller passes them by mistake. */
const FORBIDDEN_FIELD = /(password|passwordhash|authorization|cookie|refresh|access_?token|push_?token|storage_?key|secret|credential|consent|^body$|message_?body)/i;

/** Safely serialize an Error to { errorName, errorMessage } — bounded, no stack
 *  with sensitive data, no arbitrary enumerable props. */
export function serializeError(err: unknown): {
  errorName: string;
  errorMessage: string;
} {
  if (err instanceof Error) {
    return {
      errorName: err.name,
      errorMessage: (err.message ?? "").replace(/[\r\n]+/g, " ").slice(0, 300),
    };
  }
  return { errorName: "UnknownError", errorMessage: String(err).slice(0, 300) };
}

/** Strip forbidden keys from caller-supplied fields (defense in depth on top of
 *  pino's redaction). Exported for tests. */
export function sanitizeFields(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (FORBIDDEN_FIELD.test(k)) continue;
    // If a raw Error slipped in under `err`, serialize it safely.
    if (v instanceof Error) {
      Object.assign(out, serializeError(v));
      continue;
    }
    out[k] = v;
  }
  return out;
}

function baseContext(): LogFields {
  const ctx = currentContext();
  const base: LogFields = { service: SERVICE, environment: config.nodeEnv };
  if (ctx) {
    if (ctx.correlationId) base.correlationId = ctx.correlationId;
    if (ctx.userId) base.userId = ctx.userId;
    if (ctx.route) base.route = ctx.route;
    if (ctx.jobId) base.jobId = ctx.jobId;
    if (ctx.workerId) base.workerId = ctx.workerId;
  }
  return base;
}

function emit(level: LogLevel, fields: LogFields, message: string): void {
  try {
    baseLogger[level]({ ...baseContext(), ...sanitizeFields(fields) }, message);
  } catch {
    // Never let logging break application flow.
  }
}

/** Structured logger with automatic correlation context + safe serialization. */
export const log = {
  debug: (fields: LogFields, message: string) => emit("debug", fields, message),
  info: (fields: LogFields, message: string) => emit("info", fields, message),
  warn: (fields: LogFields, message: string) => emit("warn", fields, message),
  error: (fields: LogFields, message: string) => emit("error", fields, message),
};
