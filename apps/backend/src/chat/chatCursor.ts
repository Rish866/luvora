import { z } from "zod";

/**
 * Opaque, tamper-checked message history cursor. Encodes only the deterministic
 * ordering key (created_at + id of the oldest message already seen). It leaks
 * nothing beyond values the client already received, and is always passed to
 * SQL as parameters — this validation is a sanity check, not the security
 * boundary.
 */
export interface MessageCursor {
  createdAt: string;
  id: string;
}

export function encodeCursor(cursor: MessageCursor): string {
  const json = JSON.stringify({ c: cursor.createdAt, i: cursor.id });
  return Buffer.from(json, "utf8").toString("base64url");
}

export function decodeCursor(raw: string): MessageCursor | null {
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as { c?: unknown; i?: unknown };
    if (typeof parsed.c !== "string" || typeof parsed.i !== "string") {
      return null;
    }
    const uuid = z.string().uuid();
    if (!uuid.safeParse(parsed.i).success) return null;
    if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(parsed.c)) return null;
    return { createdAt: parsed.c, id: parsed.i };
  } catch {
    return null;
  }
}
