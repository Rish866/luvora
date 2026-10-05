import { z } from "zod";

/** Opaque keyset cursor (created_at + id) shared by admin list endpoints. */
export interface AdminCursor {
  createdAt: string;
  id: string;
}

export function encodeCursor(c: AdminCursor): string {
  return Buffer.from(JSON.stringify({ c: c.createdAt, i: c.id }), "utf8").toString("base64url");
}

export function decodeCursor(raw: string): AdminCursor | null {
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
