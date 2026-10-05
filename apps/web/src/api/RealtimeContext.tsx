import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ServerChatEvent } from "@luvora/shared";
import { WS_BASE_URL } from "../lib/config";
import { tokenStore } from "./tokenStore";
import { useAuth } from "../auth/AuthContext";

export type RealtimeStatus = "disconnected" | "connecting" | "connected";

type Handler = (event: ServerChatEvent) => void;

interface RealtimeContextValue {
  status: RealtimeStatus;
  /** Subscribe to server chat events. Returns an unsubscribe function. */
  subscribe: (fn: Handler) => () => void;
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

/**
 * Owns the single /ws/chat WebSocket connection. Connects only while
 * authenticated, authenticates via the `?access_token=` query (browsers can't
 * set WS headers), reconnects with bounded exponential backoff, and fans out
 * parsed server events to subscribers. The server remains authoritative — this
 * is a transport only; it holds no messaging state machine of its own.
 */
export function RealtimeProvider({ children }: { children: ReactNode }): JSX.Element {
  const { status: authStatus } = useAuth();
  const [status, setStatus] = useState<RealtimeStatus>("disconnected");
  const handlersRef = useRef<Set<Handler>>(new Set());
  const wsRef = useRef<WebSocket | null>(null);
  const attemptRef = useRef(0);
  const closedByUsRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const subscribe = useCallback((fn: Handler) => {
    handlersRef.current.add(fn);
    return () => handlersRef.current.delete(fn);
  }, []);

  // `connect` and `scheduleReconnect` are mutually recursive; a ref breaks the
  // dependency cycle so each useCallback stays stable.
  const connectRef = useRef<() => void>(() => undefined);

  const scheduleReconnect = useCallback(() => {
    if (closedByUsRef.current) return;
    const attempt = Math.min(attemptRef.current++, 5);
    const delay = Math.min(1000 * 2 ** attempt, 15_000);
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = setTimeout(() => {
      if (!closedByUsRef.current) connectRef.current();
    }, delay);
  }, []);

  const connect = useCallback(() => {
    if (wsRef.current) return;
    const token = tokenStore.getAccessToken();
    if (!token) return;
    setStatus("connecting");
    const url = `${WS_BASE_URL}/ws/chat?access_token=${encodeURIComponent(token)}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }
    wsRef.current = ws;

    ws.onopen = () => {
      attemptRef.current = 0;
      setStatus("connected");
    };
    ws.onmessage = (ev) => {
      let parsed: ServerChatEvent;
      try {
        parsed = JSON.parse(String(ev.data)) as ServerChatEvent;
      } catch {
        return;
      }
      for (const h of handlersRef.current) h(parsed);
    };
    ws.onclose = () => {
      wsRef.current = null;
      setStatus("disconnected");
      if (!closedByUsRef.current) scheduleReconnect();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* onclose follows and handles reconnect */
      }
    };
  }, [scheduleReconnect]);

  // Keep the ref pointed at the latest connect for the reconnect timer.
  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  useEffect(() => {
    if (authStatus === "authenticated") {
      closedByUsRef.current = false;
      attemptRef.current = 0;
      connect();
    }
    return () => {
      closedByUsRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {
          /* ignore */
        }
        wsRef.current = null;
      }
      setStatus("disconnected");
    };
  }, [authStatus, connect]);

  return (
    <RealtimeContext.Provider value={{ status, subscribe }}>{children}</RealtimeContext.Provider>
  );
}

export function useRealtime(): RealtimeContextValue {
  const ctx = useContext(RealtimeContext);
  if (!ctx) throw new Error("useRealtime must be used within <RealtimeProvider>");
  return ctx;
}
