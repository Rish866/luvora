import { z } from "zod";

/** Opaque, tamper-checked keyset cursor for the scenario library (created_at +
 *  id). Mirrors the discovery/chat cursor convention; always passed to SQL as
 *  parameters. */
export interface ScenarioCursor {
  createdAt: string;
  id: string;
}

export function encodeCursor(cursor: ScenarioCursor): string {
  return Buffer.from(
    JSON.stringify({ c: cursor.createdAt, i: cursor.id }),
    "utf8",
  ).toString("base64url");
}

export function decodeCursor(raw: string): ScenarioCursor | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as { c?: unknown; i?: unknown };
    if (typeof parsed.c !== "string" || typeof parsed.i !== "string") return null;
    if (!z.string().uuid().safeParse(parsed.i).success) return null;
    if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(parsed.c)) return null;
    return { createdAt: parsed.c, id: parsed.i };
  } catch {
    return null;
  }
}
