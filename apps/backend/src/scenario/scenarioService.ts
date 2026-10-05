import { z } from "zod";
import type { ScenarioSummary } from "@luvora/shared";
import { Errors } from "../http/errors";
import * as repo from "./scenarioRepository";
import { encodeCursor, decodeCursor } from "./scenarioCursor";

/** User-facing scenario library (published only). */

export const LIBRARY_LIMIT_MIN = 1;
export const LIBRARY_LIMIT_MAX = 50;
export const LIBRARY_LIMIT_DEFAULT = 20;

export const libraryQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(LIBRARY_LIMIT_MIN)
    .max(LIBRARY_LIMIT_MAX)
    .default(LIBRARY_LIMIT_DEFAULT),
  cursor: z.string().min(1).optional(),
});

export const scenarioIdParamSchema = z.object({
  scenarioId: z.string().uuid({ message: "Invalid scenario id." }),
});

function toSummary(row: repo.ScenarioRow): ScenarioSummary {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    category: row.category,
    coverImageUrl: row.cover_image_url,
    tags: row.tags ?? [],
    estimatedMinutes: row.estimated_minutes,
  };
}

export interface LibraryPage {
  scenarios: ScenarioSummary[];
  nextCursor: string | null;
}

export async function listScenarios(input: {
  limit: number;
  cursorRaw?: string;
}): Promise<LibraryPage> {
  let cursor = null as ReturnType<typeof decodeCursor>;
  if (input.cursorRaw) {
    cursor = decodeCursor(input.cursorRaw);
    if (!cursor) throw Errors.invalidCursor();
  }
  const rows = await repo.listPublished({ limit: input.limit, cursor });
  const scenarios = rows.map(toSummary);
  const nextCursor =
    rows.length === input.limit
      ? encodeCursor({
          createdAt: rows[rows.length - 1].cursor_created_at,
          id: rows[rows.length - 1].id,
        })
      : null;
  return { scenarios, nextCursor };
}

export async function getScenario(scenarioId: string): Promise<ScenarioSummary> {
  const row = await repo.getPublishedScenario(scenarioId);
  if (!row) throw Errors.scenarioNotFound();
  return toSummary(row);
}
