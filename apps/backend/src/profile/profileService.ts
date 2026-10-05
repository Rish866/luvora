import { z } from "zod";
import {
  MediaContext,
  MediaStatus,
  MediaModerationStatus,
  PROFILE_LIMITS,
  type ProfileView,
  type ProfilePhotoView,
} from "@luvora/shared";
import { Errors } from "../http/errors";
import * as repo from "./profileRepository";
import * as mediaRepo from "../media/mediaRepository";
import * as media from "../media/mediaService";

/**
 * Profile application logic (Increment 14). Reads/updates the authenticated
 * user's own profile and manages their profile-photo gallery. Photos reuse the
 * media pipeline: the client uploads via /api/media (context=profile) and then
 * ASSOCIATES the resulting media id here; the service verifies ownership +
 * context + READY/APPROVED before linking. Bytes are served through the
 * existing authenticated media endpoint — never a raw storage key.
 */

const interestsSchema = z
  .array(z.string().trim().min(1).max(PROFILE_LIMITS.INTEREST_LEN_MAX))
  .max(PROFILE_LIMITS.INTERESTS_MAX);
const fantasyPrefsSchema = z
  .array(z.string().trim().min(1).max(PROFILE_LIMITS.FANTASY_PREFERENCE_LEN_MAX))
  .max(PROFILE_LIMITS.FANTASY_PREFERENCES_MAX);

/**
 * PATCH body. Every field is optional (partial update); only editable fields
 * are accepted. Unknown fields (id, role, account status, timestamps, …) are
 * stripped by zod (no passthrough), so a client can never set them.
 */
export const updateProfileSchema = z
  .object({
    displayName: z.string().trim().min(1).max(PROFILE_LIMITS.DISPLAY_NAME_MAX),
    bio: z.string().trim().max(PROFILE_LIMITS.BIO_MAX).nullable(),
    interests: interestsSchema,
    fantasyPreferences: fantasyPrefsSchema,
    discoverable: z.boolean(),
    ageVisible: z.boolean(),
    onlineStatusVisible: z.boolean(),
    readReceiptsEnabled: z.boolean(),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, "At least one field must be provided.");

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export const associatePhotoSchema = z.object({
  mediaId: z.string().uuid(),
});

export const reorderSchema = z.object({
  photoIds: z.array(z.string().uuid()).min(1).max(PROFILE_LIMITS.MAX_PHOTOS),
});

const photoIdParamSchema = z.object({ photoId: z.string().uuid() });
export { photoIdParamSchema };

/** Application URL to a media asset's bytes / thumbnail (authenticated). */
function photoUrl(mediaId: string): string {
  return `/api/media/${mediaId}/content`;
}
function photoThumbUrl(mediaId: string, hasThumb: boolean): string | null {
  return hasThumb ? `/api/media/${mediaId}/thumbnail` : null;
}

function toPhotoView(row: repo.ProfilePhotoRow): ProfilePhotoView {
  return {
    id: row.id,
    mediaId: row.media_id,
    position: row.position,
    isPrimary: row.is_primary,
    url: photoUrl(row.media_id),
    thumbnailUrl: photoThumbUrl(row.media_id, Boolean(row.thumbnail_storage_key)),
    status: row.media_status,
    createdAt: row.created_at,
  };
}

function toProfileView(p: repo.ProfileRow, photos: repo.ProfilePhotoRow[]): ProfileView {
  const photoViews = photos.map(toPhotoView);
  const primary = photoViews.find((ph) => ph.isPrimary) ?? null;
  // "Complete" is a safe UI hint only — never enforced server-side.
  const profileComplete =
    p.display_name.trim().length > 0 &&
    (p.bio?.trim().length ?? 0) > 0 &&
    p.interests.length > 0 &&
    photoViews.some((ph) => ph.status === MediaStatus.READY);
  return {
    userId: p.user_id,
    displayName: p.display_name,
    bio: p.bio,
    interests: p.interests,
    fantasyPreferences: p.fantasy_preferences,
    discoverable: p.discoverable,
    ageVisible: p.age_visible,
    onlineStatusVisible: p.online_status_visible,
    readReceiptsEnabled: p.read_receipts_enabled,
    photos: photoViews,
    primaryPhoto: primary,
    profileComplete,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

/** GET the caller's own full profile view. */
export async function getOwnProfile(userId: string): Promise<ProfileView> {
  const profile = await repo.getProfile(userId);
  if (!profile) throw Errors.notFound("Profile not found.");
  const photos = await repo.listPhotos(userId);
  return toProfileView(profile, photos);
}

/** PATCH the caller's own editable profile fields. */
export async function updateOwnProfile(
  userId: string,
  input: UpdateProfileInput,
): Promise<ProfileView> {
  const existing = await repo.getProfile(userId);
  if (!existing) throw Errors.notFound("Profile not found.");
  await repo.updateProfile(userId, input);
  return getOwnProfile(userId);
}

/**
 * Associate an already-uploaded, owned, READY+APPROVED profile media asset as a
 * profile photo. The media bytes were uploaded via the standard media pipeline
 * (context=profile). We re-verify ownership + context + state here so a client
 * cannot attach someone else's media, a non-profile asset, or an unprocessed /
 * unmoderated one.
 */
export async function addProfilePhoto(input: {
  userId: string;
  mediaId: string;
}): Promise<ProfileView> {
  const asset = await mediaRepo.getById(input.mediaId);
  if (!asset || asset.deleted_at) throw Errors.mediaNotFound();
  if (asset.owner_id !== input.userId) throw Errors.mediaNotAuthorized();
  if (asset.context !== MediaContext.PROFILE) {
    throw Errors.validation("Media was not uploaded as a profile photo.");
  }
  if (
    asset.status !== MediaStatus.READY ||
    asset.moderation_status !== MediaModerationStatus.APPROVED
  ) {
    throw Errors.mediaNotReady();
  }

  // Enforce the per-user photo cap.
  if ((await repo.countPhotos(input.userId)) >= PROFILE_LIMITS.MAX_PHOTOS) {
    throw Errors.conflict("Maximum number of profile photos reached.");
  }

  // Idempotent on the media_id UNIQUE constraint: a repeat is a no-op link.
  const alreadyLinked = (await repo.listPhotoIdSet(input.userId)).some(
    (r) => r.media_id === input.mediaId,
  );
  if (!alreadyLinked) {
    await repo.addPhoto({ userId: input.userId, mediaId: input.mediaId });
  }
  return getOwnProfile(input.userId);
}

/** Set a photo as primary (owner-scoped). */
export async function setPrimaryPhoto(userId: string, photoId: string): Promise<ProfileView> {
  const photo = await repo.getPhotoById(userId, photoId);
  if (!photo) throw Errors.notFound("Profile photo not found.");
  await repo.setPrimary(userId, photoId);
  return getOwnProfile(userId);
}

/** Reorder the caller's photos. `photoIds` must be a permutation of exactly the
 *  caller's current photo ids — rejected otherwise (never trust arbitrary ids). */
export async function reorderPhotos(userId: string, photoIds: string[]): Promise<ProfileView> {
  const current = await repo.listPhotoIdSet(userId);
  const currentIds = current.map((r) => r.id).sort();
  const requested = [...photoIds].sort();
  const samePermutation =
    currentIds.length === requested.length &&
    new Set(photoIds).size === photoIds.length &&
    currentIds.every((id, i) => id === requested[i]);
  if (!samePermutation) {
    throw Errors.validation("photoIds must list exactly your current photos, each once.");
  }
  await repo.reorder(userId, photoIds);
  return getOwnProfile(userId);
}

/** Delete a profile photo (owner-scoped) and soft-delete its media bytes. If
 *  the primary was removed, the next photo is promoted (handled in the repo). */
export async function deleteProfilePhoto(userId: string, photoId: string): Promise<ProfileView> {
  const result = await repo.deletePhoto(userId, photoId);
  if (!result.deleted) {
    // Opaque: not-found and not-yours look identical (ids are non-enumerable).
    throw Errors.notFound("Profile photo not found.");
  }
  // Best-effort: soft-delete the underlying media asset + bytes (owner-only).
  if (result.mediaId) {
    try {
      await media.deleteAsset(userId, result.mediaId);
    } catch {
      // The association is already gone; a media cleanup failure must not fail
      // the user-visible delete. Orphaned bytes are swept by media maintenance.
    }
  }
  return getOwnProfile(userId);
}
