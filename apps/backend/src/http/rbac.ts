import type { NextFunction, Request, Response } from "express";
import { UserRole, ROLE_RANK } from "@luvora/shared";
import { Errors } from "./errors";

/**
 * Role-based access control. These middlewares MUST run after `requireAuth`,
 * which populates `req.userRole` from the server-side user record. The role is
 * NEVER read from the request body, query, headers, or JWT claims supplied by
 * the client — only from the authenticated DB record.
 */
export function requireRole(minimum: UserRole) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const role = (req.userRole as UserRole | undefined) ?? UserRole.USER;
    if (ROLE_RANK[role] >= ROLE_RANK[minimum]) {
      next();
      return;
    }
    next(Errors.forbiddenRole());
  };
}

export const requireModerator = requireRole(UserRole.MODERATOR);
export const requireAdmin = requireRole(UserRole.ADMIN);
