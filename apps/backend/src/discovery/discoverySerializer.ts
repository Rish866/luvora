import type { DiscoveryCandidate, MatchSummary } from "@luvora/shared";
import { ageInYears } from "../auth/age";
import type { CandidateRow } from "./discoveryRepository";

/**
 * Serializers that convert raw DB rows into discovery-safe DTOs.
 *
 * These are the ONLY shapes that leave the discovery/match endpoints. They
 * deliberately omit every sensitive field (password/refresh hashes, auth
 * sessions, consent responses, email, is_disabled, moderation internals, etc.)
 * — raw rows are never returned to clients.
 */

export function toCandidate(row: CandidateRow): DiscoveryCandidate {
  // Age is derived server-side and only exposed when the candidate's profile
  // allows age visibility (reusing the Increment 1 canonical age calculation).
  const age = row.age_visible
    ? ageInYears(new Date(row.date_of_birth))
    : null;

  return {
    id: row.id,
    displayName: row.display_name,
    bio: row.bio,
    interests: row.interests ?? [],
    age,
    photo: row.photo_media_id ? toDiscoveryPhoto(row.photo_media_id, row.photo_has_thumbnail) : null,
  };
}

/** Build a frontend-consumable photo reference (authenticated media URLs; never
 *  a raw storage key). The caller is authorized per-request at the media
 *  endpoint via the profile-visibility rule. */
export function toDiscoveryPhoto(
  mediaId: string,
  hasThumbnail: boolean | null,
): { mediaId: string; url: string; thumbnailUrl: string | null } {
  return {
    mediaId,
    url: `/api/media/${mediaId}/content`,
    thumbnailUrl: hasThumbnail ? `/api/media/${mediaId}/thumbnail` : null,
  };
}

/** Row shape for a match-list query (see matchRepository). */
export interface MatchListRow {
  match_id: string;
  created_at: string;
  other_id: string;
  other_display_name: string;
  other_photo_media_id: string | null;
  other_photo_has_thumbnail: boolean | null;
}

/** Inbox metadata for a match (last message + unread), from chatRepository. */
export interface MatchInboxMeta {
  conversationId: string;
  unreadCount: number;
  lastMessage: {
    id: string;
    body: string;
    senderId: string;
    createdAt: string;
    hasAttachments: boolean;
  } | null;
}

export function toMatchSummary(row: MatchListRow, meta: MatchInboxMeta): MatchSummary {
  return {
    matchId: row.match_id,
    createdAt: row.created_at,
    user: {
      id: row.other_id,
      displayName: row.other_display_name,
      photo: row.other_photo_media_id
        ? toDiscoveryPhoto(row.other_photo_media_id, row.other_photo_has_thumbnail)
        : null,
    },
    conversationId: meta.conversationId,
    unreadCount: meta.unreadCount,
    lastMessage: meta.lastMessage
      ? {
          id: meta.lastMessage.id,
          // Attachment-only messages have an empty body; expose "" (the inbox
          // uses hasAttachments to render a placeholder). Never leak internals.
          text: meta.lastMessage.body,
          senderId: meta.lastMessage.senderId,
          createdAt: meta.lastMessage.createdAt,
          hasAttachments: meta.lastMessage.hasAttachments,
        }
      : null,
  };
}
