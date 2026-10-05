import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { tokenStore } from "../api/tokenStore";
import { useApiContext } from "../api/ApiContext";
import type { MeView, RegisterInput } from "../api/endpoints";

/** Session lifecycle status, so the shell can render the right thing. */
export type AuthStatus = "loading" | "authenticated" | "unauthenticated";

interface AuthContextValue {
  status: AuthStatus;
  me: MeView | null;
  login: (email: string, password: string) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
  /** Re-fetch the current identity (e.g. after email verification). */
  refreshMe: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Owns session state. On startup it bootstraps the session: if a refresh token
 * is persisted, it loads /api/auth/me (the ApiClient transparently refreshes
 * the access token). On an unrecoverable session it clears state so the router
 * sends the user to login.
 */
export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const { api, setSessionLostHandler } = useApiContext();
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [me, setMe] = useState<MeView | null>(null);

  const clearSession = useCallback(() => {
    tokenStore.clear();
    setMe(null);
    setStatus("unauthenticated");
  }, []);

  // When the ApiClient can't recover the session (refresh failed), log out.
  useEffect(() => {
    setSessionLostHandler(clearSession);
  }, [setSessionLostHandler, clearSession]);

  const loadMe = useCallback(async () => {
    const identity = await api.auth.me();
    setMe(identity);
    setStatus("authenticated");
  }, [api]);

  // Session bootstrap on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!tokenStore.hasSession()) {
        if (!cancelled) setStatus("unauthenticated");
        return;
      }
      try {
        await loadMe();
      } catch {
        if (!cancelled) clearSession();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadMe, clearSession]);

  const login = useCallback(
    async (email: string, password: string) => {
      const tokens = await api.auth.login(email, password);
      tokenStore.setTokens(tokens.accessToken, tokens.refreshToken);
      await loadMe();
    },
    [api, loadMe],
  );

  const register = useCallback(
    async (input: RegisterInput) => {
      const tokens = await api.auth.register(input);
      tokenStore.setTokens(tokens.accessToken, tokens.refreshToken);
      await loadMe();
    },
    [api, loadMe],
  );

  const logout = useCallback(async () => {
    const refreshToken = tokenStore.getRefreshToken();
    try {
      if (refreshToken) await api.auth.logout(refreshToken);
    } catch {
      /* best-effort: clear local state regardless of the server result */
    } finally {
      clearSession();
    }
  }, [api, clearSession]);

  const value = useMemo<AuthContextValue>(
    () => ({ status, me, login, register, logout, refreshMe: loadMe }),
    [status, me, login, register, logout, loadMe],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}
