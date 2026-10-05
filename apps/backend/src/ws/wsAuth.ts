import type { IncomingMessage } from "node:http";
import { verifyAccessToken } from "../auth/tokens";
import * as users from "../users/userRepository";
import { isAccountActive } from "../auth/accountState";

/**
 * Shared WebSocket handshake authentication, used by every WS channel.
 *
 * Verifies the existing access token (header `Authorization: Bearer <token>` or
 * `?access_token=` query for browser clients that cannot set headers), confirms
 * the user still exists and is not disabled, and returns the authenticated
 * userId or null. Tokens are never logged.
 */
export async function authenticateUpgrade(
  req: IncomingMessage,
): Promise<string | null> {
  let token: string | undefined;
  const header = req.headers["authorization"];
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    token = header.slice("Bearer ".length).trim();
  }
  if (!token && req.url) {
    try {
      const url = new URL(req.url, "http://localhost");
      token = url.searchParams.get("access_token") ?? undefined;
    } catch {
      /* ignore malformed url */
    }
  }
  if (!token) return null;

  try {
    const claims = verifyAccessToken(token);
    const user = await users.findById(claims.sub);
    if (!user || user.is_disabled) return null;
    // Reject suspended / deactivated accounts at the WS handshake (Increment 6).
    if (!(await isAccountActive(claims.sub))) return null;
    return claims.sub;
  } catch {
    return null;
  }
}

/** Pathname of the upgrade request (safe parse). */
export function upgradePath(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? "", "http://localhost").pathname;
  } catch {
    return "";
  }
}
