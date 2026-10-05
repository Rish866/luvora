import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { Link, useParams } from "react-router-dom";
import type { ChatMessage, MatchSummary, ServerChatEvent } from "@luvora/shared";
import { useApi } from "../api/ApiContext";
import { useRealtime } from "../api/RealtimeContext";
import { useAuth } from "../auth/AuthContext";
import { useInbox, setActiveConversation } from "../hooks/useInbox";
import { AuthedImage } from "../components/AuthedImage";
import { Spinner, EmptyState, ErrorState } from "../components/states";
import { toUserMessage, errorCode } from "../lib/errors";
import { formatTime } from "../lib/time";

/** Stable client-side id for idempotent sends (RFC4122 v4 via crypto). */
function newClientMessageId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function ConversationPage(): JSX.Element {
  const { matchId = "" } = useParams();
  const api = useApi();
  const { subscribe, status: rtStatus } = useRealtime();
  const { me } = useAuth();
  const { markReadLocal } = useInbox();

  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [match, setMatch] = useState<MatchSummary | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const conversationId = match?.conversationId ?? null;
  const seenIdsRef = useRef<Set<string>>(new Set());
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const appendMessage = useCallback((msg: ChatMessage) => {
    if (seenIdsRef.current.has(msg.id)) return; // duplicate protection
    seenIdsRef.current.add(msg.id);
    setMessages((prev) => [...prev, msg]);
  }, []);

  // Initial load: match detail + message history, then mark read.
  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    seenIdsRef.current = new Set();
    try {
      const m = await api.matches.get(matchId);
      setMatch(m);
      const history = await api.messages.history(matchId, { limit: 50 });
      for (const msg of history.messages) seenIdsRef.current.add(msg.id);
      setMessages(history.messages);
      setNextCursor(history.nextCursor);
      setStatus("ready");

      // Mark the conversation read (server authoritative) + sync local badges.
      try {
        await api.conversations.read(m.conversationId);
        markReadLocal(m.conversationId);
      } catch {
        /* non-fatal: unread badge will reconcile on next inbox load */
      }
    } catch (err) {
      const code = errorCode(err);
      if (code === "MATCH_NOT_FOUND" || code === "MATCH_NOT_AUTHORIZED") {
        setError("This conversation is not available.");
      } else {
        setError(toUserMessage(err, "Could not load this conversation."));
      }
      setStatus("error");
    }
  }, [api, matchId, markReadLocal]);

  useEffect(() => {
    void load();
  }, [load]);

  // Tell the inbox which conversation is active (so incoming messages for it
  // don't bump the unread badge), and clear on unmount.
  useEffect(() => {
    setActiveConversation(conversationId);
    return () => setActiveConversation(null);
  }, [conversationId]);

  // Live updates for THIS conversation.
  useEffect(() => {
    if (!conversationId) return;
    const unsub = subscribe((event: ServerChatEvent) => {
      if (event.type === "message.created" && event.message.conversationId === conversationId) {
        appendMessage(event.message);
        // Keep our read marker current for messages that arrive while viewing,
        // but only for the partner's messages.
        if (me && event.message.senderId !== me.id) {
          void api.conversations.read(conversationId).then(() => markReadLocal(conversationId));
        }
      }
    });
    return unsub;
  }, [conversationId, subscribe, appendMessage, api, me, markReadLocal]);

  // Keep scrolled to the newest message as messages change.
  useLayoutEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  const loadOlder = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    const container = listRef.current;
    const prevHeight = container?.scrollHeight ?? 0;
    try {
      const page = await api.messages.history(matchId, { limit: 50, cursor: nextCursor });
      const older = page.messages.filter((m) => !seenIdsRef.current.has(m.id));
      for (const m of older) seenIdsRef.current.add(m.id);
      setMessages((prev) => [...older, ...prev]);
      setNextCursor(page.nextCursor);
      // Preserve scroll position after prepending older messages.
      requestAnimationFrame(() => {
        if (container) container.scrollTop = container.scrollHeight - prevHeight;
      });
    } catch {
      /* leave the UI as-is; the user can retry by scrolling again */
    } finally {
      setLoadingMore(false);
    }
  }, [api, matchId, nextCursor, loadingMore]);

  const onSend = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault();
      const text = draft.trim();
      if (!text || sending) return;
      setSending(true);
      setSendError(null);
      const cmid = newClientMessageId();
      try {
        // No optimistic insert: we only render the message the SERVER confirms,
        // so the UI never shows an unconfirmed/forged message. The clientMessageId
        // makes the send idempotent against retries.
        const msg = await api.messages.send(matchId, text, cmid);
        appendMessage(msg);
        setDraft("");
      } catch (err) {
        setSendError(toUserMessage(err, "Message not sent."));
      } finally {
        setSending(false);
      }
    },
    [api, matchId, draft, sending, appendMessage],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void onSend();
    }
  };

  if (status === "loading") return <Spinner label="Loading conversation…" />;
  if (status === "error") {
    return (
      <section className="page page--conversation">
        <ErrorState message={error ?? "Error"} onRetry={load} />
        <Link to="/app/inbox" className="btn btn--ghost">
          Back to inbox
        </Link>
      </section>
    );
  }

  return (
    <section className="page page--conversation" aria-label="Conversation">
      <header className="conversation__header">
        <Link to="/app/inbox" className="btn btn--ghost conversation__back" aria-label="Back to inbox">
          ‹
        </Link>
        <AuthedImage
          src={match?.user.photo?.thumbnailUrl ?? match?.user.photo?.url ?? null}
          alt={match?.user.displayName ?? "User"}
          className="avatar avatar--sm"
        />
        <h1 className="conversation__title">{match?.user.displayName}</h1>
        {rtStatus !== "connected" && (
          <span className="conversation__conn" title="Reconnecting…">
            offline
          </span>
        )}
      </header>

      <div className="conversation__messages" ref={listRef}>
        {nextCursor && (
          <div className="conversation__more">
            <button type="button" className="btn btn--ghost" onClick={loadOlder} disabled={loadingMore}>
              {loadingMore ? "Loading…" : "Load earlier messages"}
            </button>
          </div>
        )}
        {messages.length === 0 ? (
          <EmptyState title="No messages yet" description="Send the first message to start the conversation." />
        ) : (
          <ul className="bubbles">
            {messages.map((m) => {
              const mine = me !== null && m.senderId === me.id;
              return (
                <li key={m.id} className={`bubble${mine ? " bubble--mine" : " bubble--theirs"}`}>
                  {m.body && <span className="bubble__text">{m.body}</span>}
                  {m.attachments.length > 0 && (
                    <span className="bubble__attachment" aria-label="attachment">
                      📷 Photo
                    </span>
                  )}
                  <span className="bubble__time">{formatTime(m.createdAt)}</span>
                </li>
              );
            })}
          </ul>
        )}
        <div ref={bottomRef} />
      </div>

      {sendError && (
        <div className="form-error form-error--inline" role="alert">
          {sendError}
        </div>
      )}

      <form className="composer" onSubmit={onSend}>
        <textarea
          className="composer__input"
          placeholder="Type a message…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          aria-label="Message"
          maxLength={4000}
        />
        <button
          type="submit"
          className="btn btn--primary composer__send"
          disabled={sending || draft.trim().length === 0}
        >
          {sending ? "…" : "Send"}
        </button>
      </form>
    </section>
  );
}
