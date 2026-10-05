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

/** Inbox-safe preview of the most recent message in a conversation. Exposes
 *  only what an inbox row needs — never storage/moderation/internal fields.
 *  (Increment 15.) */
export interface MessagePreview {
  id: string;
  /** The message text. Empty string for an attachment-only message. */
  text: string;
  senderId: string;
  createdAt: string;
  /** True when the message carried one or more attachments (so the inbox can
   *  render e.g. "📷 Photo" without exposing attachment internals). */
  hasAttachments: boolean;
}

/** A match as shown to one of its two participants. Also serves as the inbox
 *  row: it carries the conversation id, last-message preview, and the viewer's
 *  unread count (Increment 15). */
export interface MatchSummary {
  matchId: string;
  user: {
    id: string;
    displayName: string;
    photo: DiscoveryPhoto | null;
  };
  createdAt: string;
  /** The conversation backing this match (lazily created on first message). */
  conversationId: string;
  /** Most recent message, or null when no messages have been sent yet. */
  lastMessage: MessagePreview | null;
  /** Messages from the OTHER participant not yet read by the viewer. */
  unreadCount: number;
}

/** The /api/matches list response: the viewer's matches plus a convenience
 *  total unread across all of them (Increment 15). */
export interface MatchListResponse {
  matches: MatchSummary[];
  totalUnreadCount: number;
}
