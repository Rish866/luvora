import type { ApiResponse } from "@luvora/shared";
import { API_BASE_URL } from "../lib/config";
import { tokenStore } from "./tokenStore";

/**
 * A typed error thrown by the ApiClient for any non-success response or network
 * failure. Carries the backend's stable machine `code` so UI can branch on it
 * (e.g. show a field error vs. a toast). Never contains secrets.
 */
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
  /** True for the backend's auth-expired/unauthenticated signal. */
  get isAuth(): boolean {
    return this.status === 401 || this.code === "UNAUTHENTICATED";
  }
}

export const NETWORK_ERROR_CODE = "NETWORK_ERROR";

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  /** Skip attaching the Authorization header (used by login/register/refresh). */
  anonymous?: boolean;
  /** Skip the automatic refresh-and-retry on 401 (used by the refresh call). */
  noRetry?: boolean;
  signal?: AbortSignal;
}

/** Callback invoked when the session becomes unrecoverable (refresh failed). */
type OnSessionLost = () => void;

export class ApiClient {
  private refreshing: Promise<boolean> | null = null;

  constructor(private readonly onSessionLost: OnSessionLost = () => undefined) {}

  private url(path: string): string {
    return `${API_BASE_URL}${path}`;
  }

  /** Core request. Parses the standard envelope, throws ApiError on failure,
   *  and transparently refreshes + retries once on a 401. */
  async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.rawFetch(path, opts);

    // Transparent refresh-and-retry on auth expiry (once).
    if (res.status === 401 && !opts.anonymous && !opts.noRetry) {
      const refreshed = await this.ensureRefreshed();
      if (refreshed) {
        const retry = await this.rawFetch(path, opts);
        return this.parse<T>(retry);
      }
      // Refresh failed -> session is lost.
      this.onSessionLost();
    }
    return this.parse<T>(res);
  }

  private async rawFetch(path: string, opts: RequestOptions): Promise<Response> {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (!opts.anonymous) {
      const token = tokenStore.getAccessToken();
      if (token) headers["Authorization"] = `Bearer ${token}`;
    }
    try {
      return await fetch(this.url(path), {
        method: opts.method ?? "GET",
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: opts.signal,
      });
    } catch (err) {
      // Network/DNS/CORS failure — never leak internals, just a stable code.
      throw new ApiError(
        NETWORK_ERROR_CODE,
        "Could not reach the server. Check your connection and try again.",
        0,
        err instanceof Error ? err.message : undefined,
      );
    }
  }

  private async parse<T>(res: Response): Promise<T> {
    let json: ApiResponse<T> | undefined;
    try {
      json = (await res.json()) as ApiResponse<T>;
    } catch {
      json = undefined;
    }
    if (json && json.success === true) {
      return json.data;
    }
    if (json && json.success === false) {
      throw new ApiError(json.error.code, json.error.message, res.status, json.error.details);
    }
    // Non-envelope response (shouldn't happen with this backend).
    throw new ApiError("INTERNAL", `Unexpected response (${res.status}).`, res.status);
  }

  /** Perform a refresh using the persisted refresh token. De-duplicated so
   *  concurrent 401s trigger only one refresh. Returns true on success. */
  private ensureRefreshed(): Promise<boolean> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const refreshToken = tokenStore.getRefreshToken();
      if (!refreshToken) return false;
      try {
        const res = await this.rawFetch("/api/auth/refresh", {
          method: "POST",
          body: { refreshToken },
          anonymous: true,
        });
        const data = await this.parse<{ accessToken: string; refreshToken?: string }>(res);
        if (data.refreshToken) {
          tokenStore.setTokens(data.accessToken, data.refreshToken);
        } else {
          tokenStore.setAccessToken(data.accessToken);
        }
        return true;
      } catch {
        return false;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  // ---- Convenience verbs ----
  get<T>(path: string, opts: Omit<RequestOptions, "method" | "body"> = {}): Promise<T> {
    return this.request<T>(path, { ...opts, method: "GET" });
  }
  post<T>(path: string, body?: unknown, opts: Omit<RequestOptions, "method"> = {}): Promise<T> {
    return this.request<T>(path, { ...opts, method: "POST", body });
  }
  patch<T>(path: string, body?: unknown, opts: Omit<RequestOptions, "method"> = {}): Promise<T> {
    return this.request<T>(path, { ...opts, method: "PATCH", body });
  }
  put<T>(path: string, body?: unknown, opts: Omit<RequestOptions, "method"> = {}): Promise<T> {
    return this.request<T>(path, { ...opts, method: "PUT", body });
  }
  delete<T>(path: string, opts: Omit<RequestOptions, "method" | "body"> = {}): Promise<T> {
    return this.request<T>(path, { ...opts, method: "DELETE" });
  }

  /**
   * PUT raw binary bytes to a path (used for the media content upload step).
   * Parses the standard envelope and refreshes/retries once on 401, mirroring
   * `request()`, but sends a Blob body with the caller's content type.
   */
  async putBytes<T>(path: string, data: Blob, contentType: string): Promise<T> {
    const doFetch = (): Promise<Response> => {
      const headers: Record<string, string> = { "Content-Type": contentType };
      const token = tokenStore.getAccessToken();
      if (token) headers["Authorization"] = `Bearer ${token}`;
      return fetch(this.url(path), { method: "PUT", headers, body: data });
    };
    let res: Response;
    try {
      res = await doFetch();
    } catch (err) {
      throw new ApiError(
        NETWORK_ERROR_CODE,
        "Could not reach the server. Check your connection and try again.",
        0,
        err instanceof Error ? err.message : undefined,
      );
    }
    if (res.status === 401) {
      const refreshed = await this.ensureRefreshed();
      if (refreshed) {
        try {
          res = await doFetch();
        } catch (err) {
          throw new ApiError(NETWORK_ERROR_CODE, "Network error.", 0, String(err));
        }
      } else {
        this.onSessionLost();
      }
    }
    return this.parse<T>(res);
  }

  /**
   * Fetch raw bytes for an authenticated media URL (e.g. a profile photo) and
   * return an object URL. Browsers do not send Authorization on <img src>, so
   * protected media must be fetched explicitly and turned into a blob URL.
   * Returns null when the media is unavailable/unauthorized (caller shows a
   * placeholder). The caller is responsible for revoking the object URL.
   */
  async fetchMediaObjectUrl(path: string, signal?: AbortSignal): Promise<string | null> {
    try {
      let res = await fetch(this.url(path), {
        headers: tokenStore.getAccessToken()
          ? { Authorization: `Bearer ${tokenStore.getAccessToken()}` }
          : {},
        signal,
      });
      if (res.status === 401) {
        const refreshed = await this.ensureRefreshed();
        if (refreshed) {
          res = await fetch(this.url(path), {
            headers: tokenStore.getAccessToken()
              ? { Authorization: `Bearer ${tokenStore.getAccessToken()}` }
              : {},
            signal,
          });
        }
      }
      if (!res.ok) return null;
      const blob = await res.blob();
      return URL.createObjectURL(blob);
    } catch {
      return null;
    }
  }
}
