import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { MatchSummary, ServerChatEvent, ChatMessage } from "@luvora/shared";
import { useApi } from "../api/ApiContext";
import { useRealtime } from "../api/RealtimeContext";
import { useAuth } from "../auth/AuthContext";

export type LoadStatus = "idle" | "loading" | "ready" | "error";

interface InboxState {
  status: LoadStatus;
  matches: MatchSummary[];
  totalUnreadCount: number;
  error: string | null;
}

interface InboxContextValue extends InboxState {
  reload: () => Promise<void>;
  /** Mark a conversation locally read (unread -> 0) after the server confirms. */
  markReadLocal: (conversationId: string) => void;
  /** Apply an incoming message to the inbox (preview + unread), given whether
   *  that conversation is currently open/active in the UI. */
  applyIncomingMessage: (msg: ChatMessage, activeConversationId: string | null) => void;
}

const InboxContext = createContext<InboxContextValue | null>(null);

/**
 * Central inbox state: the match/conversation list + total unread, kept in sync
 * with the server (authoritative) and updated incrementally from WebSocket
 * `message.created` / `message.read` events so the nav badge and inbox stay
 * live without refetching on every event.
 */
export function InboxProvider({ children }: { children: ReactNode }): JSX.Element {
  const api = useApi();
  const { subscribe } = useRealtime();
  const { me, status: authStatus } = useAuth();
  const [state, setState] = useState<InboxState>({
    status: "idle",
    matches: [],
    totalUnreadCount: 0,
    error: null,
  });
  const meId = me?.id ?? null;
  const activeConvRef = useRef<string | null>(null);

  const reload = useCallback(async () => {
    setState((s) => ({ ...s, status: s.status === "ready" ? "ready" : "loading", error: null }));
    try {
      const res = await api.matches.list();
      setState({
        status: "ready",
        matches: res.matches,
        totalUnreadCount: res.totalUnreadCount,
        error: null,
      });
    } catch {
      setState((s) => ({
        ...s,
        status: "error",
        error: "Could not load your matches.",
      }));
    }
  }, [api]);

  useEffect(() => {
    if (authStatus === "authenticated") void reload();
  }, [authStatus, reload]);

  const recomputeTotal = (matches: MatchSummary[]): number =>
    matches.reduce((sum, m) => sum + m.unreadCount, 0);

  const markReadLocal = useCallback((conversationId: string) => {
    setState((s) => {
      const matches = s.matches.map((m) =>
        m.conversationId === conversationId ? { ...m, unreadCount: 0 } : m,
      );
      return { ...s, matches, totalUnreadCount: recomputeTotal(matches) };
    });
  }, []);

  const applyIncomingMessage = useCallback(
    (msg: ChatMessage, activeConversationId: string | null) => {
      setState((s) => {
        let found = false;
        const isMine = meId !== null && msg.senderId === meId;
        const bumpUnread =
          !isMine && msg.conversationId !== activeConversationId; // active convo is being read
        const preview = {
          id: msg.id,
          text: msg.body,
          senderId: msg.senderId,
          createdAt: msg.createdAt,
          hasAttachments: (msg.attachments?.length ?? 0) > 0,
        };
        let matches = s.matches.map((m) => {
          if (m.conversationId !== msg.conversationId) return m;
          found = true;
          return {
            ...m,
            lastMessage: preview,
            unreadCount: bumpUnread ? m.unreadCount + 1 : m.unreadCount,
          };
        });
        // Move the touched conversation to the top (most recent activity).
        if (found) {
          const idx = matches.findIndex((m) => m.conversationId === msg.conversationId);
          if (idx > 0) {
            const [row] = matches.splice(idx, 1);
            matches = [row, ...matches];
          }
          return { ...s, matches, totalUnreadCount: recomputeTotal(matches) };
        }
        // Unknown conversation (e.g. a brand-new match): refetch to stay correct.
        void reload();
        return s;
      });
    },
    [meId, reload],
  );

  // Keep the inbox live from WebSocket events.
  useEffect(() => {
    const unsub = subscribe((event: ServerChatEvent) => {
      if (event.type === "message.created") {
        applyIncomingMessage(event.message, activeConvRef.current);
      }
    });
    return unsub;
  }, [subscribe, applyIncomingMessage]);

  // Let the conversation page tell us which conversation is active (so incoming
  // messages for it don't bump unread).
  const setActiveConversation = useCallback((conversationId: string | null) => {
    activeConvRef.current = conversationId;
  }, []);

  const value = useMemo<InboxContextValue>(
    () => ({
      ...state,
      reload,
      markReadLocal,
      applyIncomingMessage,
    }),
    [state, reload, markReadLocal, applyIncomingMessage],
  );

  // Expose setActiveConversation via a module-scoped ref hook (below).
  activeConvSetterRef.current = setActiveConversation;

  return <InboxContext.Provider value={value}>{children}</InboxContext.Provider>;
}

/** Ref indirection so the conversation page can set the active conversation
 *  without threading it through context props. */
const activeConvSetterRef: { current: (id: string | null) => void } = {
  current: () => undefined,
};

export function setActiveConversation(id: string | null): void {
  activeConvSetterRef.current(id);
}

export function useInbox(): InboxContextValue {
  const ctx = useContext(InboxContext);
  if (!ctx) throw new Error("useInbox must be used within <InboxProvider>");
  return ctx;
}
