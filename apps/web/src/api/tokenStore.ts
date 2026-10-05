/**
 * Token storage for the browser session.
 *
 * - The ACCESS token is short-lived and kept in memory only (not persisted),
 *   minimizing exposure if storage is read by other scripts.
 * - The REFRESH token is persisted in localStorage so a page reload can
 *   re-establish the session (there is no httpOnly-cookie flow in this backend;
 *   refresh tokens are opaque and only their hash is stored server-side).
 *
 * This is deliberately simple and framework-agnostic so the ApiClient and the
 * auth context share one source of truth.
 */

const REFRESH_KEY = "luvora.refreshToken";

let accessToken: string | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

export const tokenStore = {
  getAccessToken(): string | null {
    return accessToken;
  },
  getRefreshToken(): string | null {
    try {
      return localStorage.getItem(REFRESH_KEY);
    } catch {
      return null;
    }
  },
  /** Set both tokens (after login/register/refresh). */
  setTokens(access: string, refresh: string): void {
    accessToken = access;
    try {
      localStorage.setItem(REFRESH_KEY, refresh);
    } catch {
      /* storage may be unavailable (private mode) — session is memory-only then */
    }
    notify();
  },
  /** Update only the access token (after a silent refresh that didn't rotate the
   *  persisted refresh token in storage). */
  setAccessToken(access: string): void {
    accessToken = access;
    notify();
  },
  clear(): void {
    accessToken = null;
    try {
      localStorage.removeItem(REFRESH_KEY);
    } catch {
      /* ignore */
    }
    notify();
  },
  hasSession(): boolean {
    return Boolean(accessToken) || Boolean(this.getRefreshToken());
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
