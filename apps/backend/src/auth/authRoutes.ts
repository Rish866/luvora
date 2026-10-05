import { Router } from "express";
import { asyncHandler } from "../http/asyncHandler";
import { ok } from "../http/respond";
import { makeRateLimiter } from "../http/rateLimiter";
import { config } from "../config";
import {
  loginSchema,
  refreshSchema,
  registerSchema,
  login,
  logout,
  refresh,
  register,
} from "./authService";
import { requireAuth } from "../http/authMiddleware";
import * as users from "../users/userRepository";
import { ageInYears } from "./age";
import { Errors } from "../http/errors";

export const authRouter = Router();

// Stricter rate limit for auth endpoints (brute-force protection).
const authLimiter = makeRateLimiter(config.rateLimit.authMax);

function reqCtx(req: { headers: Record<string, unknown>; ip?: string }) {
  return {
    userAgent:
      typeof req.headers["user-agent"] === "string"
        ? (req.headers["user-agent"] as string)
        : undefined,
    ip: req.ip,
  };
}

authRouter.post(
  "/register",
  authLimiter,
  asyncHandler(async (req, res) => {
    const input = registerSchema.parse(req.body);
    const result = await register(input, reqCtx(req));
    ok(res, result, 201);
  }),
);

authRouter.post(
  "/login",
  authLimiter,
  asyncHandler(async (req, res) => {
    const input = loginSchema.parse(req.body);
    const result = await login(input, reqCtx(req));
    ok(res, result);
  }),
);

authRouter.post(
  "/refresh",
  authLimiter,
  asyncHandler(async (req, res) => {
    const { refreshToken } = refreshSchema.parse(req.body);
    const tokens = await refresh(refreshToken);
    ok(res, tokens);
  }),
);

authRouter.post(
  "/logout",
  asyncHandler(async (req, res) => {
    const { refreshToken } = refreshSchema.parse(req.body);
    await logout(refreshToken);
    ok(res, { loggedOut: true });
  }),
);

// Authenticated "who am I" — returns non-sensitive identity info only.
authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await users.findById(req.userId!);
    if (!user) throw Errors.notFound("User not found.");
    ok(res, {
      id: user.id,
      email: user.email,
      age: ageInYears(new Date(user.date_of_birth)),
      ageConfirmed: user.age_confirmed_at !== null,
      emailVerified: user.email_verified_at !== null,
    });
  }),
);
