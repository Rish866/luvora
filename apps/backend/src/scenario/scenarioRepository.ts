import { query } from "../db/pool";

/**
 * Read access for scenarios and their immutable published content. All SQL is
 * parameterized. Only PUBLISHED scenarios/versions are exposed to users; draft
 * content is never selectable through these helpers used by user-facing routes.
 */

export interface ScenarioRow {
  id: string;
  slug: string;
  title: string;
  description: string;
  category: string;
  cover_image_url: string | null;
  tags: string[];
  estimated_minutes: number | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface ScenarioVersionRow {
  id: string;
  scenario_id: string;
  version: number;
  status: string;
  start_node_id: string | null;
  published_at: string | null;
}

export interface NodeRow {
  id: string;
  scenario_version_id: string;
  node_key: string;
  node_type: string;
  title: string;
  content: string;
  sort_order: number;
}

export interface ChoiceRow {
  id: string;
  node_id: string;
  choice_key: string;
  label: string;
  description: string;
  next_node_id: string;
  sort_order: number;
}

export interface PublishedListCursor {
  createdAt: string;
  id: string;
}

/** List PUBLISHED scenarios, deterministic keyset order (created_at, id). */
export async function listPublished(input: {
  limit: number;
  cursor: PublishedListCursor | null;
}): Promise<Array<ScenarioRow & { cursor_created_at: string }>> {
  const params: unknown[] = [];
  let keyset = "";
  if (input.cursor) {
    params.push(input.cursor.createdAt, input.cursor.id);
    keyset = `AND (created_at, id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
  }
  params.push(input.limit);
  const limitParam = `$${params.length}`;
  return query<ScenarioRow & { cursor_created_at: string }>(
    `SELECT *, created_at::text AS cursor_created_at
       FROM scenarios
      WHERE status = 'PUBLISHED'
        ${keyset}
      ORDER BY created_at ASC, id ASC
      LIMIT ${limitParam}`,
    params,
  );
}

export async function getPublishedScenario(
  scenarioId: string,
): Promise<ScenarioRow | null> {
  const rows = await query<ScenarioRow>(
    `SELECT * FROM scenarios WHERE id = $1 AND status = 'PUBLISHED'`,
    [scenarioId],
  );
  return rows[0] ?? null;
}

/** The latest PUBLISHED version of a scenario (highest version number). */
export async function getLatestPublishedVersion(
  scenarioId: string,
): Promise<ScenarioVersionRow | null> {
  const rows = await query<ScenarioVersionRow>(
    `SELECT id, scenario_id, version, status, start_node_id, published_at
       FROM scenario_versions
      WHERE scenario_id = $1 AND status = 'PUBLISHED'
      ORDER BY version DESC
      LIMIT 1`,
    [scenarioId],
  );
  return rows[0] ?? null;
}

export async function getVersionById(
  versionId: string,
): Promise<ScenarioVersionRow | null> {
  const rows = await query<ScenarioVersionRow>(
    `SELECT id, scenario_id, version, status, start_node_id, published_at
       FROM scenario_versions WHERE id = $1`,
    [versionId],
  );
  return rows[0] ?? null;
}

export async function getNodeById(nodeId: string): Promise<NodeRow | null> {
  const rows = await query<NodeRow>(
    `SELECT id, scenario_version_id, node_key, node_type, title, content, sort_order
       FROM scenario_nodes WHERE id = $1`,
    [nodeId],
  );
  return rows[0] ?? null;
}

export async function getChoicesForNode(nodeId: string): Promise<ChoiceRow[]> {
  return query<ChoiceRow>(
    `SELECT id, node_id, choice_key, label, description, next_node_id, sort_order
       FROM scenario_choices WHERE node_id = $1 ORDER BY sort_order ASC, choice_key ASC`,
    [nodeId],
  );
}

/** A single choice by id (used to resolve a submitted choice). */
export async function getChoiceById(choiceId: string): Promise<ChoiceRow | null> {
  const rows = await query<ChoiceRow>(
    `SELECT id, node_id, choice_key, label, description, next_node_id, sort_order
       FROM scenario_choices WHERE id = $1`,
    [choiceId],
  );
  return rows[0] ?? null;
}

/** Required consent categories for a set of choices, grouped by choice id. */
export async function getRequirementsForChoices(
  choiceIds: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (choiceIds.length === 0) return map;
  const rows = await query<{ choice_id: string; consent_category: string }>(
    `SELECT choice_id, consent_category
       FROM scenario_choice_requirements
      WHERE choice_id = ANY($1::uuid[])`,
    [choiceIds],
  );
  for (const r of rows) {
    const list = map.get(r.choice_id) ?? [];
    list.push(r.consent_category);
    map.set(r.choice_id, list);
  }
  return map;
}
