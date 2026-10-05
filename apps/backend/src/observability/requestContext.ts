import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/**
 * Request/execution context (Increment 10).
 *
 * Carries a correlation id (and optional user id, route template, job context)
 * through async call chains WITHOUT threading a string through every function
 * or using global mutable state. Backed by Node's AsyncLocalStorage.
 *
 * The correlation id is safe to log and to return in a response header. It is
 * NEVER a trusted security identifier — authorization always uses the
 * authenticated user, never the correlation id.
 */
export interface RequestContext {
  correlationId: string;
  userId?: string;
  /** Normalized route template (e.g. "GET /api/matches/:matchId"), never a raw
   *  user-supplied URL — keeps metric cardinality bounded. */
  route?: string;
  /** Set when the context belongs to a background job execution. */
  jobId?: string;
  workerId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Max accepted length of an incoming correlation id. Oversized values are
 *  rejected (a fresh id is generated instead) to prevent log/memory abuse. */
export const MAX_CORRELATION_ID_LENGTH = 128;
/** Allowed characters in an incoming correlation id — alphanumerics plus a few
 *  safe separators. Anything else (incl. newlines/control chars) is rejected,
 *  preventing log-injection via the header. */
const CORRELATION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Validate+normalize a client-supplied correlation id. Returns the id when it
 * is safe, otherwise null (caller generates a fresh one). Trims, length-bounds,
 * and character-restricts — never trusts arbitrary oversized/raw values.
 */
export function sanitizeIncomingCorrelationId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_CORRELATION_ID_LENGTH) return null;
  if (!CORRELATION_ID_RE.test(trimmed)) return null;
  return trimmed;
}

/** Generate a fresh, cryptographically-random correlation id. */
export function newCorrelationId(): string {
  return randomUUID();
}

/** Run `fn` within a request context. */
export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** The current context, or undefined when outside any run(). */
export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

/** The current correlation id, or undefined. */
export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

/** Merge fields into the current context (no-op outside a run()). */
export function setContextFields(fields: Partial<RequestContext>): void {
  const ctx = storage.getStore();
  if (ctx) Object.assign(ctx, fields);
}
