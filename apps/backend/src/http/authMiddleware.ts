import type { NextFunction, Request, Response } from "express";
import { verifyAccessToken } from "../auth/tokens";
import { Errors } from "./errors";
import * as users from "../users/userRepository";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

/**
 * Require a valid access token. Attaches `req.userId`. We also confirm the user
 * still exists and is not disabled/deleted, so revoked accounts can't act with
 * a still-valid short-lived access token for long.
 */
export async function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw Errors.unauthenticated();
    }
    const token = header.slice("Bearer ".length).trim();
    let claims;
    try {
      claims = verifyAccessToken(token);
    } catch {
      throw Errors.unauthenticated("Invalid or expired token.");
    }
    const user = await users.findById(claims.sub);
    if (!user || user.is_disabled) {
      throw Errors.unauthenticated();
    }
    req.userId = claims.sub;
    next();
  } catch (err) {
    next(err);
  }
}
