import { z } from "zod";
import type { FeedCursor } from "./discoveryRepository";

/** Pagination bounds for the discovery feed. */
export const DISCOVERY_LIMIT_MIN = 1;
export const DISCOVERY_LIMIT_MAX = 50;
export const DISCOVERY_LIMIT_DEFAULT = 20;

export const feedQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(DISCOVERY_LIMIT_MIN)
    .max(DISCOVERY_LIMIT_MAX)
    .default(DISCOVERY_LIMIT_DEFAULT),
  cursor: z.string().min(1).optional(),
});

/** UUID path param used by like/pass/block routes. */
export const userIdParamSchema = z.object({
  userId: z.string().uuid({ message: "Invalid user id." }),
});

export const matchIdParamSchema = z.object({
  matchId: z.string().uuid({ message: "Invalid match id." }),
});

/**
 * The discovery cursor is an OPAQUE base64url token encoding only the
 * deterministic ordering key (createdAt + id of the last returned candidate).
 * It carries no private information beyond values the client already received
 * (a public user id and that user's created_at). It is validated on decode so
 * a tampered cursor is rejected rather than reaching SQL unchecked.
 */
export function encodeCursor(cursor: FeedCursor): string {
  const json = JSON.stringify({ c: cursor.createdAt, i: cursor.id });
  return Buffer.from(json, "utf8").toString("base64url");
}

export function decodeCursor(raw: string): FeedCursor | null {
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as { c?: unknown; i?: unknown };
    if (typeof parsed.c !== "string" || typeof parsed.i !== "string") {
      return null;
    }
    // Validate the shape strictly: id must be a UUID; createdAt must look like
    // a timestamp (ISO or PostgreSQL text form, e.g. "2026-10-05 09:51:18.12+00").
    // It is always passed to SQL as a parameter cast to ::timestamptz, so this
    // is a sanity check, not the security boundary.
    const uuid = z.string().uuid();
    if (!uuid.safeParse(parsed.i).success) return null;
    if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(parsed.c)) return null;
    return { createdAt: parsed.c, id: parsed.i };
  } catch {
    return null;
  }
}
