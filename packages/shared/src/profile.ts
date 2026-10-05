/**
 * Profile + profile-photo shared types (Increment 14).
 *
 * These are the frontend contract for the authenticated user's own profile and
 * their profile-photo gallery. Photos are standardized on the media pipeline:
 * a `ProfilePhotoView` references a `media_assets` id and exposes authenticated
 * application URLs (never a raw storage key).
 */

/** The editable fields a user controls on their own profile. The server
 *  derives/validates everything else; clients NEVER set ids, timestamps,
 *  roles, account status, or moderation fields. */
export interface ProfileEditableFields {
  displayName: string;
  bio: string | null;
  interests: string[];
  fantasyPreferences: string[];
  /** Privacy / visibility controls (already part of the product schema). */
  discoverable: boolean;
  ageVisible: boolean;
  onlineStatusVisible: boolean;
  readReceiptsEnabled: boolean;
}

/** One profile photo in the owner's gallery. */
export interface ProfilePhotoView {
  /** profile_photos row id (used to reorder / set-primary / delete). */
  id: string;
  /** Underlying media asset id (addressable via /api/media/:id). */
  mediaId: string;
  position: number;
  isPrimary: boolean;
  /** Authenticated URL to fetch the normalized image bytes. */
  url: string;
  /** Authenticated URL to fetch the thumbnail, if one exists. */
  thumbnailUrl: string | null;
  /** Media moderation/processing status so the client can show pending state. */
  status: string;
  createdAt: string;
}

/** The authenticated user's own complete, frontend-relevant profile. */
export interface ProfileView extends ProfileEditableFields {
  userId: string;
  photos: ProfilePhotoView[];
  /** Convenience: the primary photo (also present in `photos`), or null. */
  primaryPhoto: ProfilePhotoView | null;
  /** Derived, safe hint for onboarding UIs. Never gates behavior server-side. */
  profileComplete: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Limits for profile content (mirrors the DB CHECK constraints in 0001). */
export const PROFILE_LIMITS = {
  DISPLAY_NAME_MAX: 50,
  BIO_MAX: 500,
  INTERESTS_MAX: 20,
  INTEREST_LEN_MAX: 40,
  FANTASY_PREFERENCES_MAX: 20,
  FANTASY_PREFERENCE_LEN_MAX: 40,
  /** Max profile photos per user. */
  MAX_PHOTOS: 6,
} as const;
