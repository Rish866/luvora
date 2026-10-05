import { Router } from "express";
import { asyncHandler } from "../http/asyncHandler";
import { ok } from "../http/respond";
import { requireAuth } from "../http/authMiddleware";
import { abuseLimit, AbuseRules } from "../http/abuseGuardMiddleware";
import * as service from "./profileService";

/**
 * /api/profile — the authenticated user's own profile + profile-photo gallery
 * (Increment 14). Every route is self-scoped: the caller only ever reads/writes
 * their OWN profile; there is no path param for another user's profile here
 * (other users' public info is served via discovery/matches). Photo bytes are
 * fetched through the existing /api/media/:id/content endpoint.
 */
export const profileRouter = Router();
profileRouter.use(requireAuth);

// Per-user write throttle (reuses the shared abuse guard; effective under test).
const writeLimit = abuseLimit({
  scope: "profile-write",
  rule: AbuseRules.prefWrite,
  by: ["user"],
});

// GET /api/profile — the caller's full profile.
profileRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const view = await service.getOwnProfile(req.userId!);
    ok(res, { profile: view });
  }),
);

// PATCH /api/profile — update editable fields (partial).
profileRouter.patch(
  "/",
  writeLimit,
  asyncHandler(async (req, res) => {
    const input = service.updateProfileSchema.parse(req.body);
    const view = await service.updateOwnProfile(req.userId!, input);
    ok(res, { profile: view });
  }),
);

// GET /api/profile/photos — the caller's gallery (deterministic order).
profileRouter.get(
  "/photos",
  asyncHandler(async (req, res) => {
    const view = await service.getOwnProfile(req.userId!);
    ok(res, { photos: view.photos, primaryPhoto: view.primaryPhoto });
  }),
);

// POST /api/profile/photos — associate an uploaded media asset as a photo.
//   Body: { mediaId }. The bytes must already be uploaded via /api/media with
//   context=profile and be READY+APPROVED (verified server-side).
profileRouter.post(
  "/photos",
  writeLimit,
  asyncHandler(async (req, res) => {
    const { mediaId } = service.associatePhotoSchema.parse(req.body);
    const view = await service.addProfilePhoto({ userId: req.userId!, mediaId });
    ok(res, { profile: view }, 201);
  }),
);

// PUT /api/profile/photos/order — reorder (body: { photoIds: [...] }).
profileRouter.put(
  "/photos/order",
  writeLimit,
  asyncHandler(async (req, res) => {
    const { photoIds } = service.reorderSchema.parse(req.body);
    const view = await service.reorderPhotos(req.userId!, photoIds);
    ok(res, { profile: view });
  }),
);

// POST /api/profile/photos/:photoId/primary — set a photo as primary.
profileRouter.post(
  "/photos/:photoId/primary",
  writeLimit,
  asyncHandler(async (req, res) => {
    const { photoId } = service.photoIdParamSchema.parse(req.params);
    const view = await service.setPrimaryPhoto(req.userId!, photoId);
    ok(res, { profile: view });
  }),
);

// DELETE /api/profile/photos/:photoId — remove a photo (owner-only).
profileRouter.delete(
  "/photos/:photoId",
  writeLimit,
  asyncHandler(async (req, res) => {
    const { photoId } = service.photoIdParamSchema.parse(req.params);
    const view = await service.deleteProfilePhoto(req.userId!, photoId);
    ok(res, { profile: view });
  }),
);
