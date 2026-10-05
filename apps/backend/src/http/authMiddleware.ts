import type { NextFunction, Request, Response } from "express";
import { verifyAccessToken } from "../auth/tokens";
import { Errors } from "./errors";
import { assertAccountActive } from "../auth/accountState";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
      /** The authenticated user's server-side role (never from client input). */
      userRole?: string;
    }
  }
}

/**
 * Require a valid access token. Attaches `req.userId` and `req.userRole`.
 *
 * Beyond token validity, this enforces LIVE account state on every request
 * (Increment 6): a suspended or deactivated account is rejected even if it
 * still holds a non-expired access token, so safety actions take effect
 * immediately rather than waiting for token expiry. Expired suspensions
 * auto-lapse (see assertAccountActive).
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
    // assertAccountActive throws ACCOUNT_SUSPENDED/ACCOUNT_DEACTIVATED for
    // blocked accounts and returns null for missing/disabled users.
    const user = await assertAccountActive(claims.sub);
    if (!user) {
      throw Errors.unauthenticated();
    }
    req.userId = user.id;
    req.userRole = user.role;
    next();
  } catch (err) {
    next(err);
  }
}
