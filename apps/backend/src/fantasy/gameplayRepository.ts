import { withTransaction } from "../db/pool";
import type { PoolClient } from "pg";
import type { SessionRow } from "./sessionRepository";

/**
 * Gameplay persistence. All authoritative transitions run inside a transaction
 * with `SELECT ... FOR UPDATE` on the session row (pessimistic lock) AND an
 * optimistic `state_version` guard, so one logical turn transition happens
 * exactly once even under concurrent submissions.
 */

export interface SessionActionRow {
  id: string;
  session_id: string;
  user_id: string;
  client_action_id: string;
  action_type: string;
  result_node_id: string | null;
  result_turn: number | null;
}

/** Lock a session row for update within a transaction. */
async function lockSession(
  client: PoolClient,
  sessionId: string,
): Promise<SessionRow | null> {
  const { rows } = await client.query<SessionRow>(
    `SELECT * FROM fantasy_sessions WHERE id = $1 FOR UPDATE`,
    [sessionId],
  );
  return rows[0] ?? null;
}

/**
 * Assign a scenario version to a session and set the start node, bumping
 * state_version. Idempotent-safe: only applies when scenario_version_id is NULL
 * and the expected state_version matches. Returns the updated row or null on a
 * version conflict.
 */
export async function assignScenario(input: {
  sessionId: string;
  scenarioVersionId: string;
  startNodeId: string;
  expectedStateVersion: number;
}): Promise<SessionRow | null> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<SessionRow>(
      `UPDATE fantasy_sessions
          SET scenario_version_id = $2,
              current_node_id     = $3,
              turn_number         = 0,
              state_version       = state_version + 1
        WHERE id = $1
          AND state_version = $4
          AND scenario_version_id IS NULL
        RETURNING *`,
      [
        input.sessionId,
        input.scenarioVersionId,
        input.startNodeId,
        input.expectedStateVersion,
      ],
    );
    return rows[0] ?? null;
  });
}

/** Mark the session started (started_at); sets state PLAYING timestamp only. */
export async function markStarted(sessionId: string): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE fantasy_sessions
          SET started_at = COALESCE(started_at, now())
        WHERE id = $1`,
      [sessionId],
    );
  });
}

export interface AdvanceResult {
  outcome: "ADVANCED" | "CONFLICT" | "DUPLICATE";
  session?: SessionRow;
  /** For DUPLICATE: the previously recorded result node + turn. */
  duplicateResultNodeId?: string | null;
  duplicateResultTurn?: number | null;
}

/**
 * Advance the session to `nextNodeId` as a single atomic turn, enforcing:
 *  - the session row is locked FOR UPDATE,
 *  - the optimistic state_version guard,
 *  - idempotency via session_actions UNIQUE(session,user,client_action_id).
 *
 * `work` is a callback allowing the caller to re-validate inside the lock
 * (e.g. confirm current_node_id, state, and the choice) using the locked row.
 * It returns the resolved next node id (or throws to abort), ensuring all
 * validation happens against the locked, authoritative state.
 */
export async function advanceTurn(input: {
  sessionId: string;
  userId: string;
  clientActionId: string;
  actionType: string;
  resolve: (locked: SessionRow, client: PoolClient) => Promise<{
    nextNodeId: string;
    completed: boolean;
  }>;
}): Promise<AdvanceResult> {
  return withTransaction(async (client) => {
    const locked = await lockSession(client, input.sessionId);
    if (!locked) {
      return { outcome: "CONFLICT" };
    }

    // Idempotency: if this exact action already ran, return its recorded result.
    const existing = await client.query<SessionActionRow>(
      `SELECT * FROM session_actions
        WHERE session_id = $1 AND user_id = $2 AND client_action_id = $3`,
      [input.sessionId, input.userId, input.clientActionId],
    );
    if (existing.rows[0]) {
      return {
        outcome: "DUPLICATE",
        session: locked,
        duplicateResultNodeId: existing.rows[0].result_node_id,
        duplicateResultTurn: existing.rows[0].result_turn,
      };
    }

    // Caller re-validates against the locked row and resolves the next node.
    const { nextNodeId, completed } = await input.resolve(locked, client);

    const newTurn = locked.turn_number + 1;
    const updated = await client.query<SessionRow>(
      `UPDATE fantasy_sessions
          SET current_node_id = $2,
              turn_number      = $3,
              state_version    = state_version + 1,
              state            = CASE WHEN $4 THEN 'COMPLETED' ELSE state END,
              completed_at     = CASE WHEN $4 THEN now() ELSE completed_at END
        WHERE id = $1 AND state_version = $5
        RETURNING *`,
      [
        input.sessionId,
        nextNodeId,
        newTurn,
        completed,
        locked.state_version,
      ],
    );
    if (!updated.rows[0]) {
      // Should not happen under FOR UPDATE, but guard anyway.
      return { outcome: "CONFLICT" };
    }

    // Record the action for idempotency (same tx, so it commits atomically).
    await client.query(
      `INSERT INTO session_actions
         (session_id, user_id, client_action_id, action_type, result_node_id, result_turn)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.sessionId,
        input.userId,
        input.clientActionId,
        input.actionType,
        nextNodeId,
        newTurn,
      ],
    );

    return { outcome: "ADVANCED", session: updated.rows[0] };
  });
}
