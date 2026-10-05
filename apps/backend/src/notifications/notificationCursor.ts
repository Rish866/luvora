import { z } from "zod";

/** Opaque keyset cursor (created_at + id) for the notification feed. Mirrors
 *  the discovery/chat/admin cursor convention; always passed to SQL as params. */
export interface NotificationCursor {
  createdAt: string;
  id: string;
}

export function encodeCursor(c: NotificationCursor): string {
  return Buffer.from(JSON.stringify({ c: c.createdAt, i: c.id }), "utf8").toString("base64url");
}

export function decodeCursor(raw: string): NotificationCursor | null {
  try {
    const p = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as {
      c?: unknown;
      i?: unknown;
    };
    if (typeof p.c !== "string" || typeof p.i !== "string") return null;
    if (!z.string().uuid().safeParse(p.i).success) return null;
    if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(p.c)) return null;
    return { createdAt: p.c, id: p.i };
  } catch {
    return null;
  }
}
