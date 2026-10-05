import { z } from "zod";
import {
  SessionState,
  ConsentStatus,
  ConsentResponseValue,
  resolveCompatibleCategories,
  canTransition,
  ScenarioNodeType,
  type GameStateView,
  type GameNodeView,
  type GameChoiceView,
} from "@luvora/shared";
import { NotificationType } from "@luvora/shared";
import { Errors } from "../http/errors";
import * as sessionRepo from "./sessionRepository";
import * as gameplayRepo from "./gameplayRepository";
import * as scenarioRepo from "../scenario/scenarioRepository";
import * as notifications from "../notifications/notificationService";

/**
 * Server-authoritative gameplay engine.
 *
 * Principles enforced here (see Increment 4 architecture):
 *  - Clients submit INTENT (a choice id), never state. The server resolves the
 *    next node from the DB; a client-supplied next node / turn / version is
 *    impossible to inject because those fields are never read from input.
 *  - Scenario versions are immutable and pinned on the session.
 *  - Consent is re-evaluated at choice time using the ONE shared resolver
 *    (`resolveCompatibleCategories`); the partner's private answers are never
 *    exposed — only a per-choice `available` boolean.
 *  - Transitions are transactional + idempotent + concurrency-safe
 *    (see gameplayRepository.advanceTurn).
 */

export const selectScenarioSchema = z.object({
  scenarioId: z.string().uuid(),
});

export const chooseSchema = z.object({
  clientActionId: z.string().uuid(),
});

/** Load a session and assert the user is a participant (generic GAME_NOT_AUTHORIZED). */
async function loadParticipantSession(
  sessionId: string,
  userId: string,
): Promise<sessionRepo.SessionRow> {
  const session = await sessionRepo.getSession(sessionId);
  if (!session) {
    // Non-enumerable UUIDs: a missing session and a non-participant both yield
    // the generic gameplay-authorization error so relationships aren't leaked.
    throw Errors.gameNotAuthorized();
  }
  if (session.initiator_id !== userId && session.invitee_id !== userId) {
    throw Errors.gameNotAuthorized();
  }
  return session;
}

/** The mutual consent allow-list for a session, computed from BOTH players'
 *  private responses via the single shared resolver. Never returns per-player
 *  answers. Returns [] if either player's responses are missing. */
async function mutualAllowList(session: sessionRepo.SessionRow): Promise<Set<string>> {
  const mine = (await sessionRepo.getConsentResponsesForUser(
    session.id,
    session.initiator_id,
  )) as Record<string, ConsentResponseValue>;
  const theirs = (await sessionRepo.getConsentResponsesForUser(
    session.id,
    session.invitee_id,
  )) as Record<string, ConsentResponseValue>;
  return new Set(resolveCompatibleCategories(mine, theirs));
}

/** Build the public node view (current node + choices with availability). */
async function buildNodeView(
  nodeId: string,
  allow: Set<string>,
): Promise<GameNodeView> {
  const node = await scenarioRepo.getNodeById(nodeId);
  if (!node) throw Errors.internal("Scenario node missing.");

  const choiceRows = await scenarioRepo.getChoicesForNode(node.id);
  const requirements = await scenarioRepo.getRequirementsForChoices(
    choiceRows.map((c) => c.id),
  );

  const choices: GameChoiceView[] = choiceRows.map((c) => {
    const requires = requirements.get(c.id) ?? [];
    const available = requires.every((cat) => allow.has(cat));
    return {
      id: c.id,
      key: c.choice_key,
      label: c.label,
      description: c.description,
      available,
      requires,
    };
  });

  return {
    id: node.id,
    key: node.node_key,
    type: node.node_type as ScenarioNodeType,
    title: node.title,
    content: node.content,
    choices,
    isEnding: node.node_type === ScenarioNodeType.ENDING,
  };
}

function toStateView(
  session: sessionRepo.SessionRow,
  node: GameNodeView | null,
): GameStateView {
  return {
    sessionId: session.id,
    sessionState: session.state,
    scenarioVersionId: session.scenario_version_id ?? "",
    turnNumber: session.turn_number,
    stateVersion: session.state_version,
    completed: session.state === SessionState.COMPLETED,
    node,
  };
}

/** Build the full authoritative state view for a session (DB-sourced). */
export async function buildStateView(
  session: sessionRepo.SessionRow,
): Promise<GameStateView> {
  if (!session.current_node_id) {
    return toStateView(session, null);
  }
  const allow = await mutualAllowList(session);
  const node = await buildNodeView(session.current_node_id, allow);
  return toStateView(session, node);
}

/**
 * Select a published scenario for a session that is in PLAYING with no scenario
 * assigned yet. (Consent has already produced PLAYING via the existing flow.)
 * Pins the latest published version + its start node. Idempotent/safe under
 * concurrency via the state_version guard on assignScenario.
 */
export async function selectScenario(
  sessionId: string,
  userId: string,
  scenarioId: string,
): Promise<GameStateView> {
  const session = await loadParticipantSession(sessionId, userId);

  if (session.state !== SessionState.PLAYING) {
    throw Errors.sessionNotReady(
      "A scenario can only be selected once both players have consented.",
    );
  }
  if (session.scenario_version_id) {
    // Already selected — return current authoritative state (idempotent).
    return buildStateView(session);
  }

  const scenario = await scenarioRepo.getPublishedScenario(scenarioId);
  if (!scenario) throw Errors.scenarioNotFound();

  const version = await scenarioRepo.getLatestPublishedVersion(scenarioId);
  if (!version || !version.start_node_id) {
    throw Errors.scenarioNotAvailable();
  }

  const updated = await gameplayRepo.assignScenario({
    sessionId,
    scenarioVersionId: version.id,
    startNodeId: version.start_node_id,
    expectedStateVersion: session.state_version,
  });
  if (!updated) {
    // A concurrent selection won; return whatever is now authoritative.
    const fresh = await sessionRepo.getSession(sessionId);
    if (fresh?.scenario_version_id) return buildStateView(fresh);
    throw Errors.gameStateConflict();
  }
  await gameplayRepo.markStarted(sessionId);
  const started = (await sessionRepo.getSession(sessionId))!;
  return buildStateView(started);
}

/** Authoritative current state (used by GET state + reconnect). */
export async function getState(
  sessionId: string,
  userId: string,
): Promise<GameStateView> {
  const session = await loadParticipantSession(sessionId, userId);
  return buildStateView(session);
}

export interface ChooseResult {
  state: GameStateView;
  participants: string[];
  completed: boolean;
  idempotentReplay: boolean;
}

/**
 * Submit a choice (by id). The server:
 *  1. authorizes the participant,
 *  2. locks the session row + checks idempotency,
 *  3. validates the choice belongs to the CURRENT node,
 *  4. re-evaluates consent requirements against the mutual allow-list,
 *  5. advances to the server-resolved next node atomically,
 *  6. returns authoritative state for broadcast.
 */
export async function choose(
  sessionId: string,
  userId: string,
  choiceId: string,
  clientActionId: string,
): Promise<ChooseResult> {
  const session = await loadParticipantSession(sessionId, userId);
  if (session.state === SessionState.COMPLETED) {
    throw Errors.gameAlreadyCompleted();
  }
  if (session.state !== SessionState.PLAYING) {
    throw Errors.sessionNotPlaying();
  }
  if (!session.scenario_version_id || !session.current_node_id) {
    throw Errors.sessionNotPlaying("No scenario is in progress.");
  }

  const participants = [session.initiator_id, session.invitee_id];
  const allow = await mutualAllowList(session);

  const result = await gameplayRepo.advanceTurn({
    sessionId,
    userId,
    clientActionId,
    actionType: "CHOICE",
    resolve: async (locked, client) => {
      // Re-validate everything against the LOCKED authoritative row.
      if (locked.state !== SessionState.PLAYING) {
        throw Errors.sessionNotPlaying();
      }
      if (!locked.current_node_id) throw Errors.sessionNotPlaying();

      // Resolve the choice and confirm it belongs to the current node.
      const choiceRows = await client.query<scenarioRepo.ChoiceRow>(
        `SELECT id, node_id, choice_key, label, description, next_node_id, sort_order
           FROM scenario_choices WHERE id = $1`,
        [choiceId],
      );
      const choice = choiceRows.rows[0];
      if (!choice || choice.node_id !== locked.current_node_id) {
        // Choice from another node / scenario / session, or arbitrary id.
        throw Errors.invalidChoice();
      }

      // Consent re-evaluation: every required category must be mutually allowed.
      const reqRows = await client.query<{ consent_category: string }>(
        `SELECT consent_category FROM scenario_choice_requirements WHERE choice_id = $1`,
        [choice.id],
      );
      for (const r of reqRows.rows) {
        if (!allow.has(r.consent_category)) {
          throw Errors.consentRequired();
        }
      }

      // Determine whether the destination node is an ENDING.
      const nextRows = await client.query<{ node_type: string }>(
        `SELECT node_type FROM scenario_nodes WHERE id = $1`,
        [choice.next_node_id],
      );
      const completed = nextRows.rows[0]?.node_type === ScenarioNodeType.ENDING;

      return { nextNodeId: choice.next_node_id, completed };
    },
  });

  if (result.outcome === "CONFLICT") {
    throw Errors.gameStateConflict();
  }

  if (result.outcome === "DUPLICATE") {
    // Idempotent replay: return the current authoritative state unchanged.
    const fresh = (await sessionRepo.getSession(sessionId))!;
    return {
      state: await buildStateView(fresh),
      participants,
      completed: fresh.state === SessionState.COMPLETED,
      idempotentReplay: true,
    };
  }

  const updated = result.session!;
  const justCompleted = updated.state === SessionState.COMPLETED;
  if (justCompleted) {
    // Notify both participants that the fantasy completed (no choice/consent
    // detail). Deduped per (session, recipient).
    for (const uid of participants) {
      await notifications.create({
        userId: uid,
        type: NotificationType.FANTASY_COMPLETED,
        title: "Fantasy complete",
        body: "Your fantasy has reached its ending.",
        entityType: "session",
        entityId: sessionId,
        dedupeKey: `fantasy:${sessionId}:completed:${uid}`,
      });
    }
  }
  return {
    state: await buildStateView(updated),
    participants,
    completed: justCompleted,
    idempotentReplay: false,
  };
}

/** Pause / resume reuse the existing state machine. */
export async function pause(
  sessionId: string,
  userId: string,
): Promise<GameStateView> {
  const session = await loadParticipantSession(sessionId, userId);
  if (!canTransition(session.state, SessionState.PAUSED)) {
    throw Errors.invalidTransition(`Cannot pause from ${session.state}.`);
  }
  const updated = await sessionRepo.setState(sessionId, SessionState.PAUSED);
  return buildStateView(updated);
}

export async function resume(
  sessionId: string,
  userId: string,
): Promise<GameStateView> {
  const session = await loadParticipantSession(sessionId, userId);
  if (!canTransition(session.state, SessionState.PLAYING)) {
    throw Errors.invalidTransition(`Cannot resume from ${session.state}.`);
  }
  const updated = await sessionRepo.setState(sessionId, SessionState.PLAYING);
  return buildStateView(updated);
}
