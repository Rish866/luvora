import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../http/asyncHandler";
import { ok } from "../http/respond";
import { requireAuth } from "../http/authMiddleware";
import { Errors } from "../http/errors";
import { NotificationCategory, CRITICAL_CATEGORIES } from "@luvora/shared";
import * as repo from "./notificationRepository";
import * as service from "./notificationService";
import { encodeCursor, decodeCursor } from "./notificationCursor";

/** /api/notifications — authenticated per-user notification feed + preferences. */
export const notificationRouter = Router();
notificationRouter.use(requireAuth);

const feedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  unread: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  cursor: z.string().min(1).optional(),
});

const idParam = z.object({ id: z.string().uuid() });

// GET /api/notifications?limit=&unread=&cursor=
notificationRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const q = feedQuerySchema.parse(req.query);
    let before = null as ReturnType<typeof decodeCursor>;
    if (q.cursor) {
      before = decodeCursor(q.cursor);
      if (!before) throw Errors.invalidCursor();
    }
    const rows = await repo.listForUser({
      userId: req.userId!,
      limit: q.limit,
      unreadOnly: Boolean(q.unread),
      before,
    });
    const nextCursor =
      rows.length === q.limit
        ? encodeCursor({
            createdAt: rows[rows.length - 1].cursor_created_at ?? rows[rows.length - 1].created_at,
            id: rows[rows.length - 1].id,
          })
        : null;
    ok(res, { notifications: rows.map(repo.toView), nextCursor });
  }),
);

// GET /api/notifications/unread-count
notificationRouter.get(
  "/unread-count",
  asyncHandler(async (req, res) => {
    const count = await repo.unreadCount(req.userId!);
    ok(res, { count });
  }),
);

// GET /api/notifications/preferences
notificationRouter.get(
  "/preferences",
  asyncHandler(async (req, res) => {
    const preferences = await service.getPreferences(req.userId!);
    ok(res, { preferences });
  }),
);

// PUT /api/notifications/preferences
//   { category, enabled }        -> toggle whether the in-app notification exists
//   { category, pushEnabled }    -> toggle out-of-band PUSH delivery (Inc. 8)
// Exactly one of `enabled` / `pushEnabled` must be provided.
notificationRouter.put(
  "/preferences",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        category: z.nativeEnum(NotificationCategory),
        enabled: z.boolean().optional(),
        pushEnabled: z.boolean().optional(),
      })
      .refine(
        (b) => (b.enabled === undefined) !== (b.pushEnabled === undefined),
        "Provide exactly one of `enabled` or `pushEnabled`.",
      )
      .parse(req.body);

    // SAFETY is critical: neither its in-app existence nor its push delivery may
    // be disabled, so the user can never silence a safety notice.
    if (
      (body.enabled === false || body.pushEnabled === false) &&
      CRITICAL_CATEGORIES.has(body.category)
    ) {
      throw Errors.criticalPreference();
    }

    if (body.enabled !== undefined) {
      await service.setPreference(req.userId!, body.category, body.enabled);
    } else {
      await service.setPushPreference(req.userId!, body.category, body.pushEnabled!);
    }
    const preferences = await service.getPreferences(req.userId!);
    ok(res, { preferences });
  }),
);

// POST /api/notifications/read-all
notificationRouter.post(
  "/read-all",
  asyncHandler(async (req, res) => {
    const updated = await repo.markAllRead(req.userId!);
    ok(res, { updated });
  }),
);

// POST /api/notifications/:id/read  (idempotent; owner-scoped)
notificationRouter.post(
  "/:id/read",
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const okAffected = await repo.markRead(req.userId!, id);
    if (!okAffected) {
      // Either does not exist OR belongs to another user — same opaque error so
      // a notification id cannot be probed via IDOR.
      throw Errors.notificationNotFound();
    }
    ok(res, { read: true });
  }),
);
