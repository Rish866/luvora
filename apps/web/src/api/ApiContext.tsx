import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
import { ApiClient } from "./client";
import { createEndpoints, type Endpoints } from "./endpoints";

/**
 * Provides a single ApiClient + typed Endpoints facade to the tree. The client
 * is told how to signal an unrecoverable session (refresh failed) via a
 * callback the AuthProvider registers, so components never wire that manually.
 */
interface ApiContextValue {
  client: ApiClient;
  api: Endpoints;
  /** Registered by AuthProvider; invoked when the session is unrecoverable. */
  setSessionLostHandler: (fn: () => void) => void;
}

const ApiContext = createContext<ApiContextValue | null>(null);

export function ApiProvider({ children }: { children: ReactNode }): JSX.Element {
  const sessionLostRef = useRef<() => void>(() => undefined);
  const value = useMemo<ApiContextValue>(() => {
    const client = new ApiClient(() => sessionLostRef.current());
    return {
      client,
      api: createEndpoints(client),
      setSessionLostHandler: (fn: () => void) => {
        sessionLostRef.current = fn;
      },
    };
  }, []);
  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}

export function useApiContext(): ApiContextValue {
  const ctx = useContext(ApiContext);
  if (!ctx) throw new Error("useApiContext must be used within <ApiProvider>");
  return ctx;
}

/** Convenience: the typed endpoints facade. */
export function useApi(): Endpoints {
  return useApiContext().api;
}

/** Convenience: the low-level client (for media object URLs). */
export function useApiClient(): ApiClient {
  return useApiContext().client;
}
