/**
 * Discovery & matching shared types (Increment 2).
 *
 * A discovery "decision" is one row per (actor, target) in the `likes` table,
 * distinguished by `is_pass`. LIKE and PASS are therefore mutually exclusive
 * states of the same decision — re-deciding updates the existing row rather
 * than creating a contradictory second row.
 */

export enum DiscoveryAction {
  LIKE = "LIKE",
  PASS = "PASS",
}

/** Public, discovery-safe view of another user. Contains ONLY fields that are
 *  appropriate for a different user to see — never auth, consent, or internal
 *  security fields. Serialized by the backend; the client/admin reuse this
 *  shape. */
export interface DiscoveryCandidate {
  id: string;
  displayName: string;
  bio: string | null;
  interests: string[];
  /** Present only when the candidate's profile allows age visibility. */
  age: number | null;
  /** Discovery-appropriate photo info (approved photos only), or null. */
  photo: DiscoveryPhoto | null;
}

export interface DiscoveryPhoto {
  id: string;
  /** Opaque storage key. A signed-URL pipeline is a later increment; we never
   *  expose a permanent public URL. */
  storageKey: string;
}

/** Result of a LIKE/PASS action. Never reveals the other user's own activity
 *  (e.g. whether THEY liked you) beyond the match outcome. */
export interface DiscoveryActionResult {
  action: DiscoveryAction;
  userId: string;
  matched: boolean;
  matchId: string | null;
}

/** A match as shown to one of its two participants. */
export interface MatchSummary {
  matchId: string;
  user: {
    id: string;
    displayName: string;
    photo: DiscoveryPhoto | null;
  };
  createdAt: string;
}
