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

/** Frontend-consumable reference to another user's primary profile photo.
 *  Never exposes a raw storage key — only the media id + authenticated
 *  application URLs the client fetches through the media endpoint (Increment
 *  14). `url`/`thumbnailUrl` require the caller's own auth and are authorized
 *  per-request (owner OR entitled discovery/match viewer). */
export interface DiscoveryPhoto {
  /** The media asset id (stable; also addressable via /api/media/:id). */
  mediaId: string;
  /** Authenticated URL to fetch the normalized image bytes. */
  url: string;
  /** Authenticated URL to fetch the thumbnail, if one exists. */
  thumbnailUrl: string | null;
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
