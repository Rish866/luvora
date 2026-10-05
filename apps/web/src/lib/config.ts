/**
 * Runtime configuration, derived entirely from PUBLIC Vite env vars. No secrets
 * are ever referenced here — only `VITE_`-prefixed values are exposed to the
 * browser bundle by Vite.
 */

/** Trim a trailing slash so URL joins are predictable. */
function trimTrailingSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

/** Base URL for the HTTP API. Empty string => same-origin relative requests
 *  (useful behind a reverse proxy or the Vite dev proxy). */
export const API_BASE_URL = trimTrailingSlash(import.meta.env.VITE_API_BASE_URL ?? "");

/** Base URL for the WebSocket server. When unset, derive from the API base
 *  (http->ws, https->wss); fall back to the current page origin. */
export const WS_BASE_URL = (() => {
  const explicit = import.meta.env.VITE_WS_BASE_URL;
  if (explicit) return trimTrailingSlash(explicit);
  const api = API_BASE_URL || (typeof window !== "undefined" ? window.location.origin : "");
  return trimTrailingSlash(api.replace(/^http(s?):\/\//, (_m, s) => (s ? "wss://" : "ws://")));
})();
