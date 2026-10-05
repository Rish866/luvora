import { z } from "zod";
import {
  SessionState,
  ConsentStatus,
  ConsentResponseValue,
  CONSENT_VERSION,
  CONSENT_CATEGORIES,
  isValidConsentCategory,
  resolveCompatibleCategories,
  canTransition,
} from "@luvora/shared";
import { Errors } from "../http/errors";
import * as repo from "./sessionRepository";
import * as notifications from "../notifications/notificationService";
import { NotificationType } from "@luvora/shared";

/**
 * Server-authoritative session + consent logic.
 *
 * Two invariants are enforced here and MUST NOT be relaxed by any caller:
 *
 *  1. AUTHORIZATION: every operation verifies the acting user is actually one
 *     of the two players in the session. We never trust a session id from the
 *     client as proof of access.
 *
 *  2. CONSENT PRIVACY: a player's individual YES/MAYBE/NO answers are never
 *     returned to the other player. Only the server-computed allow-list
 *     (categories where BOTH said YES) is ever shared, and only once BOTH
 *     players have confirmed participation.
 */

export const submitConsentSchema = z.object({
  responses: z
    .array(
      z.object({
        category: z.string(),
        response: z.nativeEnum(ConsentResponseValue),
      }),
    )
    .min(1),
  agreeToParticipate: z.boolean(),
});

export type SubmitConsentInput = z.infer<typeof submitConsentSchema>;

/** Throws unless `userId` is one of the session's two players. */
function assertParticipant(session: repo.SessionRow, userId: string): void {
  if (session.initiator_id !== userId && session.invitee_id !== userId) {
    // Deliberately the same error whether the session exists or not would be
    // ideal; the route layer returns 404 for missing sessions, and this 403
    // for existing-but-unauthorized, which is acceptable because ids are
    // non-enumerable UUIDs.
    throw Errors.sessionNotAuthorized();
  }
}

async function loadAuthorized(
  sessionId: string,
  userId: string,
): Promise<repo.SessionRow> {
  const session = await repo.getSession(sessionId);
  if (!session) throw Errors.notFound("Session not found.");
  assertParticipant(session, userId);
  return session;
}

/** Transition helper that enforces the shared state machine. */
async function transition(
  session: repo.SessionRow,
  to: SessionState,
): Promise<repo.SessionRow> {
  if (!canTransition(session.state, to)) {
    throw Errors.invalidTransition(
      `Cannot move from ${session.state} to ${to}.`,
    );
  }
  return repo.setState(session.id, to);
}

/** Invitee accepts the invitation: INVITED -> ACCEPTED -> CONSENT. */
export async function acceptInvite(
  sessionId: string,
  userId: string,
): Promise<repo.SessionRow> {
  const session = await loadAuthorized(sessionId, userId);
  if (session.invitee_id !== userId) {
    throw Errors.unauthorized("Only the invited player can accept.");
  }
  const accepted = await transition(session, SessionState.ACCEPTED);
  // Notify the initiator that their invitation was accepted.
  await notifications.create({
    userId: session.initiator_id,
    type: NotificationType.FANTASY_ACCEPTED,
    title: "Fantasy accepted",
    body: "Your fantasy invitation was accepted.",
    entityType: "session",
    entityId: session.id,
    dedupeKey: `fantasy:${session.id}:accepted:${session.initiator_id}`,
  });
  // Immediately advance into the consent stage.
  return transition(accepted, SessionState.CONSENT);
}

/** Either player declines/abandons before play. */
export async function declineOrAbandon(
  sessionId: string,
  userId: string,
): Promise<repo.SessionRow> {
  const session = await loadAuthorized(sessionId, userId);
  return transition(session, SessionState.ABANDONED);
}

/**
 * A player submits their private consent responses and participation
 * agreement. Validates categories, stores responses privately, and — only when
 * BOTH players have confirmed — advances the session to PLAYING and computes
 * the shared allow-list.
 *
 * Returns a view that NEVER includes the other player's answers.
 */
export async function submitConsent(
  sessionId: string,
  userId: string,
  input: SubmitConsentInput,
): Promise<ConsentView> {
  const session = await loadAuthorized(sessionId, userId);
  if (session.state !== SessionState.CONSENT) {
    throw Errors.invalidTransition(
      "Consent can only be submitted during the consent stage.",
    );
  }

  // Validate every category key against the known catalogue.
  for (const r of input.responses) {
    if (!isValidConsentCategory(r.category)) {
      throw Errors.validation(`Unknown consent category: ${r.category}`);
    }
  }

  await repo.saveConsentResponses({
    sessionId,
    userId,
    consentVersion: CONSENT_VERSION,
    responses: input.responses.map((r) => ({
      category: r.category,
      response: r.response,
    })),
  });

  // A player is CONFIRMED only if they explicitly agreed to participate.
  const status = input.agreeToParticipate
    ? ConsentStatus.CONFIRMED
    : ConsentStatus.SUBMITTED;
  await repo.setPlayerConsentStatus(
    sessionId,
    userId,
    status,
    input.agreeToParticipate,
  );

  return buildConsentView(sessionId, userId);
}

export interface ConsentView {
  sessionId: string;
  state: SessionState;
  /** The acting player's own answers echoed back (their own data only). */
  yourResponses: Record<string, ConsentResponseValue>;
  /** Whether YOU have confirmed participation. */
  youConfirmed: boolean;
  /** Whether the partner has confirmed — a boolean only, never their answers. */
  partnerConfirmed: boolean;
  /** Only populated once BOTH confirm and the session enters PLAYING. */
  allowedCategories: string[] | null;
  categories: typeof CONSENT_CATEGORIES;
}

async function buildConsentView(
  sessionId: string,
  userId: string,
): Promise<ConsentView> {
  const session = await repo.getSession(sessionId);
  if (!session) throw Errors.notFound("Session not found.");
  const players = await repo.getPlayers(sessionId);
  const me = players.find((p) => p.user_id === userId)!;
  const partner = players.find((p) => p.user_id !== userId)!;

  const bothConfirmed =
    me.consent_status === ConsentStatus.CONFIRMED &&
    partner.consent_status === ConsentStatus.CONFIRMED;

  let allowedCategories: string[] | null = null;
  let state = session.state;

  if (bothConfirmed && session.state === SessionState.CONSENT) {
    // Compute the shared allow-list from both players' PRIVATE answers.
    const mine = (await repo.getConsentResponsesForUser(
      sessionId,
      userId,
    )) as Record<string, ConsentResponseValue>;
    const theirs = (await repo.getConsentResponsesForUser(
      sessionId,
      partner.user_id,
    )) as Record<string, ConsentResponseValue>;
    allowedCategories = resolveCompatibleCategories(mine, theirs);

    // Both consented -> begin play. (Server authority: only here.)
    const updated = await repo.setState(sessionId, SessionState.PLAYING);
    state = updated.state;
  }

  const yourResponses = (await repo.getConsentResponsesForUser(
    sessionId,
    userId,
  )) as Record<string, ConsentResponseValue>;

  return {
    sessionId,
    state,
    yourResponses,
    youConfirmed: me.consent_status === ConsentStatus.CONFIRMED,
    partnerConfirmed: partner.consent_status === ConsentStatus.CONFIRMED,
    allowedCategories,
    categories: CONSENT_CATEGORIES,
  };
}

/** Read the current consent view (used for polling / resume). */
export async function getConsentView(
  sessionId: string,
  userId: string,
): Promise<ConsentView> {
  await loadAuthorized(sessionId, userId);
  return buildConsentView(sessionId, userId);
}

/** Leave an in-progress session. Never penalized. PLAYING/PAUSED -> ABANDONED. */
export async function leaveSession(
  sessionId: string,
  userId: string,
): Promise<repo.SessionRow> {
  const session = await loadAuthorized(sessionId, userId);
  return transition(session, SessionState.ABANDONED);
}
