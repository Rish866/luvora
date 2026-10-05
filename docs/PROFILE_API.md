# Profile & Profile-Photo API (Increment 14)

The frontend contract for the authenticated user's own profile and their
profile-photo gallery. Resolves the two P0 blockers from `PRODUCT_AUDIT.md`
(self-profile read/update; consumable profile photos).

- All endpoints require `Authorization: Bearer <accessToken>` and are
  **self-scoped**: the caller only ever reads/writes their OWN profile. There is
  no userId path/body parameter — the server always uses the authenticated id.
- Responses use the standard envelope: `{ "success": true, "data": … }` or
  `{ "success": false, "error": { "code", "message", "details?" } }`.
- Photo **bytes** are served through the existing authenticated media endpoint
  `GET /api/media/:id/content` (and `/thumbnail`). Clients never receive or use a
  raw storage key.

---

## Photo lifecycle (how it fits together)

Profile photos reuse the Increment 5 media pipeline — there is no separate
upload path to learn:

```
1. POST /api/media                      { mimeType, sizeBytes, context: "profile" }  -> { mediaId, uploadUrl, maxBytes }
2. PUT  /api/media/:mediaId/content      <raw image bytes>                            -> MediaAssetView (status READY when accepted)
3. POST /api/profile/photos             { mediaId }                                   -> ProfileView (photo associated)
```

The server validates bytes (dual MIME detection, EXIF stripped, size/pixel
caps, moderation) during step 2; only a `READY` + `APPROVED` asset can be
associated in step 3. The first associated photo becomes `primary`
automatically. Max 6 photos per user.

---

## GET /api/profile

Returns the caller's complete, frontend-relevant profile.

**Response** `200` — `{ "data": { "profile": ProfileView } }`:

```jsonc
{
  "profile": {
    "userId": "1f…uuid",
    "displayName": "Alex",
    "bio": "about me" ,            // string | null
    "interests": ["hiking"],       // string[]
    "fantasyPreferences": ["roleplay"],
    "discoverable": true,
    "ageVisible": true,
    "onlineStatusVisible": true,
    "readReceiptsEnabled": true,
    "photos": [ ProfilePhotoView, … ],  // ordered; see below
    "primaryPhoto": ProfilePhotoView | null,
    "profileComplete": false,      // UI hint only; never enforced server-side
    "createdAt": "2026-…Z",
    "updatedAt": "2026-…Z"
  }
}
```

`ProfilePhotoView`:
```jsonc
{
  "id": "…uuid",              // profile_photos row id (use for primary/reorder/delete)
  "mediaId": "…uuid",         // media asset id (addressable via /api/media/:id)
  "position": 0,
  "isPrimary": true,
  "url": "/api/media/<mediaId>/content",       // authenticated bytes
  "thumbnailUrl": "/api/media/<mediaId>/thumbnail" | null,
  "status": "READY",
  "createdAt": "2026-…Z"
}
```

Errors: `401` unauthenticated.

---

## PATCH /api/profile

Partial update of editable fields. Provide any subset; unknown fields are
stripped (a client can never set `userId`, `role`, `accountStatus`, timestamps,
etc.).

**Request body** (all optional, ≥1 required):
```jsonc
{
  "displayName": "New Name",     // 1–50 chars
  "bio": "hi" ,                  // ≤500 chars, nullable
  "interests": ["a","b"],        // ≤20 items, each ≤40 chars
  "fantasyPreferences": ["x"],   // ≤20 items, each ≤40 chars
  "discoverable": true,
  "ageVisible": true,
  "onlineStatusVisible": true,
  "readReceiptsEnabled": true
}
```

**Response** `200` — `{ "data": { "profile": ProfileView } }` (the updated profile).

Errors: `400` VALIDATION_ERROR (empty body, over-length, too many items);
`401` unauthenticated.

---

## GET /api/profile/photos

Returns the caller's gallery in deterministic order (primary first within the
view's `primaryPhoto`; `photos` ordered by `position`, then `createdAt`).

**Response** `200`:
```jsonc
{ "photos": [ ProfilePhotoView, … ], "primaryPhoto": ProfilePhotoView | null }
```

---

## POST /api/profile/photos

Associate an already-uploaded, owned, `context="profile"`, `READY`+`APPROVED`
media asset as a profile photo. Idempotent per `mediaId`.

**Request body:** `{ "mediaId": "…uuid" }`

**Response** `201` — `{ "data": { "profile": ProfileView } }`.

Errors: `400` media is not a profile asset / validation; `403`/`404` media not
owned or not found (opaque); `409` CONFLICT (photo cap reached);
`409` MEDIA_NOT_READY (asset not READY+APPROVED).

---

## PUT /api/profile/photos/order

Reorder the gallery. `photoIds` must be a permutation of exactly the caller's
current photo ids (each once) — otherwise rejected. Positions are reassigned
`0..n-1` in the given order.

**Request body:** `{ "photoIds": ["id1","id2", …] }`

**Response** `200` — `{ "data": { "profile": ProfileView } }`.

Errors: `400` VALIDATION_ERROR (not a permutation); `401`.

---

## POST /api/profile/photos/:photoId/primary

Set a photo as primary; the previous primary is cleared atomically (exactly one
primary per user, enforced by a DB partial unique index).

**Response** `200` — `{ "data": { "profile": ProfileView } }`.

Errors: `404` photo not found / not yours (opaque); `401`.

---

## DELETE /api/profile/photos/:photoId

Remove a photo (owner-only). If the deleted photo was primary, the next photo
(lowest position) is promoted to primary. The underlying media asset is
soft-deleted.

**Response** `200` — `{ "data": { "profile": ProfileView } }`.

Errors: `404` photo not found / not yours (opaque); `401`.

---

## Photo viewing & authorization

`GET /api/media/:mediaId/content` (and `/thumbnail`) serve the bytes. For a
`context="profile"` asset, a viewer is authorized iff:

- they are the **owner**, OR
- there is **no block** in either direction AND (the owner is **discoverable**
  OR the viewer shares an **ACTIVE match** with the owner).

This mirrors discovery/match visibility, so avatars render exactly where the
user is already visible — and nowhere else. Only `READY` assets stream bytes.
Unauthenticated → `401`; unauthorized → `403`; unknown/deleted → `404`.

---

## Discovery & match photo representation

Discovery candidates (`GET /api/discovery`) and match summaries
(`GET /api/matches`, `GET /api/matches/:id`) now return a consumable photo
reference (never a raw storage key):

```jsonc
"photo": {
  "mediaId": "…uuid",
  "url": "/api/media/<mediaId>/content",
  "thumbnailUrl": "/api/media/<mediaId>/thumbnail" | null
}            // or null when the user has no approved profile photo
```

The client renders the photo by fetching `url` with the user's own auth; the
media endpoint authorizes per-request via the profile-visibility rule above.
