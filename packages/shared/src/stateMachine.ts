import { SessionState } from "./enums";

/**
 * Authoritative transition table for fantasy sessions.
 *
 * The server is the ONLY component permitted to advance a session. The client
 * may request a transition, but the server validates it against this table and
 * rejects anything not explicitly allowed. This prevents a malicious or buggy
 * client from, e.g., jumping straight to PLAYING without the CONSENT stage.
 */
export const SESSION_TRANSITIONS: Record<SessionState, SessionState[]> = {
  [SessionState.WAITING]: [SessionState.INVITED, SessionState.ABANDONED],
  [SessionState.INVITED]: [SessionState.ACCEPTED, SessionState.ABANDONED],
  [SessionState.ACCEPTED]: [SessionState.CONSENT, SessionState.ABANDONED],
  [SessionState.CONSENT]: [SessionState.PLAYING, SessionState.ABANDONED],
  [SessionState.PLAYING]: [
    SessionState.PAUSED,
    SessionState.COMPLETED,
    SessionState.ABANDONED,
    SessionState.REPORTED,
  ],
  [SessionState.PAUSED]: [
    SessionState.PLAYING,
    SessionState.ABANDONED,
    SessionState.REPORTED,
  ],
  // Terminal states — no outgoing transitions.
  [SessionState.COMPLETED]: [],
  [SessionState.ABANDONED]: [],
  [SessionState.REPORTED]: [],
};

/** Pure predicate: is a transition from `from` to `to` allowed? */
export function canTransition(from: SessionState, to: SessionState): boolean {
  return SESSION_TRANSITIONS[from]?.includes(to) ?? false;
}

/** States from which a session is considered terminated. */
export const TERMINAL_SESSION_STATES: ReadonlySet<SessionState> = new Set([
  SessionState.COMPLETED,
  SessionState.ABANDONED,
  SessionState.REPORTED,
]);

export function isTerminal(state: SessionState): boolean {
  return TERMINAL_SESSION_STATES.has(state);
}
