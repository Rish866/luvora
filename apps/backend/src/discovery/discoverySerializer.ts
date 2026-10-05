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
    photo:
      row.photo_id && row.photo_storage_key
        ? { id: row.photo_id, storageKey: row.photo_storage_key }
        : null,
  };
}

/** Row shape for a match-list query (see matchRepository). */
export interface MatchListRow {
  match_id: string;
  created_at: string;
  other_id: string;
  other_display_name: string;
  other_photo_id: string | null;
  other_photo_storage_key: string | null;
}

export function toMatchSummary(row: MatchListRow): MatchSummary {
  return {
    matchId: row.match_id,
    createdAt: row.created_at,
    user: {
      id: row.other_id,
      displayName: row.other_display_name,
      photo:
        row.other_photo_id && row.other_photo_storage_key
          ? { id: row.other_photo_id, storageKey: row.other_photo_storage_key }
          : null,
    },
  };
}
