import { query, withTransaction } from "../db/pool";
import { SessionState, ConsentStatus } from "@luvora/shared";

export interface SessionRow {
  id: string;
  match_id: string;
  scenario_id: string;
  scenario_version: string;
  state: SessionState;
  initiator_id: string;
  invitee_id: string;
  current_scene_id: string | null;
  seq: string;
  created_at: string;
  updated_at: string;
  // Gameplay state (Increment 4).
  scenario_version_id: string | null;
  current_node_id: string | null;
  turn_number: number;
  state_version: number;
  started_at: string | null;
  completed_at: string | null;
}

export interface PlayerRow {
  session_id: string;
  user_id: string;
  consent_status: ConsentStatus;
  participation_agreed_at: string | null;
  joined_at: string | null;
  left_at: string | null;
}

export async function getSession(id: string): Promise<SessionRow | null> {
  const rows = await query<SessionRow>(
    `SELECT * FROM fantasy_sessions WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function getPlayers(sessionId: string): Promise<PlayerRow[]> {
  return query<PlayerRow>(
    `SELECT * FROM fantasy_players WHERE session_id = $1 ORDER BY user_id`,
    [sessionId],
  );
}

/** Create a session + its two player rows atomically, starting in INVITED. */
export async function createInvite(input: {
  matchId: string;
  scenarioId: string;
  scenarioVersion: string;
  initiatorId: string;
  inviteeId: string;
}): Promise<SessionRow> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<SessionRow>(
      `INSERT INTO fantasy_sessions
         (match_id, scenario_id, scenario_version, state, initiator_id, invitee_id)
       VALUES ($1, $2, $3, 'INVITED', $4, $5)
       RETURNING *`,
      [
        input.matchId,
        input.scenarioId,
        input.scenarioVersion,
        input.initiatorId,
        input.inviteeId,
      ],
    );
    const session = rows[0];
    for (const uid of [input.initiatorId, input.inviteeId]) {
      await client.query(
        `INSERT INTO fantasy_players (session_id, user_id) VALUES ($1, $2)`,
        [session.id, uid],
      );
    }
    return session;
  });
}

/** Update session state. Caller is responsible for validating the transition
 *  (see sessionService). Returns the updated row. */
export async function setState(
  id: string,
  state: SessionState,
): Promise<SessionRow> {
  const rows = await query<SessionRow>(
    `UPDATE fantasy_sessions SET state = $2 WHERE id = $1 RETURNING *`,
    [id, state],
  );
  return rows[0];
}

export async function setPlayerConsentStatus(
  sessionId: string,
  userId: string,
  status: ConsentStatus,
  participationAgreed: boolean,
): Promise<void> {
  await query(
    `UPDATE fantasy_players
        SET consent_status = $3,
            participation_agreed_at = CASE WHEN $4 THEN now() ELSE participation_agreed_at END
      WHERE session_id = $1 AND user_id = $2`,
    [sessionId, userId, status, participationAgreed],
  );
}

/** Upsert all consent responses for a player in one transaction. */
export async function saveConsentResponses(input: {
  sessionId: string;
  userId: string;
  consentVersion: string;
  responses: { category: string; response: string }[];
}): Promise<void> {
  await withTransaction(async (client) => {
    for (const r of input.responses) {
      await client.query(
        `INSERT INTO consent_responses (session_id, user_id, category, response, consent_version)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (session_id, user_id, category)
         DO UPDATE SET response = EXCLUDED.response, consent_version = EXCLUDED.consent_version`,
        [input.sessionId, input.userId, r.category, r.response, input.consentVersion],
      );
    }
  });
}

export async function getConsentResponsesForUser(
  sessionId: string,
  userId: string,
): Promise<Record<string, string>> {
  const rows = await query<{ category: string; response: string }>(
    `SELECT category, response FROM consent_responses
      WHERE session_id = $1 AND user_id = $2`,
    [sessionId, userId],
  );
  const map: Record<string, string> = {};
  for (const r of rows) map[r.category] = r.response;
  return map;
}
