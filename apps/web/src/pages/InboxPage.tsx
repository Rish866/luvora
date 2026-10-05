import { Link } from "react-router-dom";
import type { MatchSummary } from "@luvora/shared";
import { useAuth } from "../auth/AuthContext";
import { useInbox } from "../hooks/useInbox";
import { AuthedImage } from "../components/AuthedImage";
import { Spinner, EmptyState, ErrorState } from "../components/states";
import { formatRelative } from "../lib/time";

/** Render the last-message preview text safely (handles null / attachment-only). */
function previewText(m: MatchSummary, meId: string | null): string {
  if (!m.lastMessage) return "Say hello 👋";
  const mine = meId !== null && m.lastMessage.senderId === meId;
  const prefix = mine ? "You: " : "";
  if (m.lastMessage.hasAttachments && m.lastMessage.text.trim() === "") {
    return `${prefix}📷 Photo`;
  }
  return `${prefix}${m.lastMessage.text}`;
}

function InboxRow({ m, meId }: { m: MatchSummary; meId: string | null }): JSX.Element {
  return (
    <li className="inbox-row">
      <Link to={`/app/inbox/${m.matchId}`} className="inbox-row__link">
        <AuthedImage
          src={m.user.photo?.thumbnailUrl ?? m.user.photo?.url ?? null}
          alt={m.user.displayName}
          className="avatar"
        />
        <div className="inbox-row__main">
          <div className="inbox-row__top">
            <span className="inbox-row__name">{m.user.displayName}</span>
            {m.lastMessage && (
              <span className="inbox-row__time">{formatRelative(m.lastMessage.createdAt)}</span>
            )}
          </div>
          <div className="inbox-row__bottom">
            <span className={`inbox-row__preview${m.unreadCount > 0 ? " is-unread" : ""}`}>
              {previewText(m, meId)}
            </span>
            {m.unreadCount > 0 && (
              <span className="badge" aria-label={`${m.unreadCount} unread`}>
                {m.unreadCount > 99 ? "99+" : m.unreadCount}
              </span>
            )}
          </div>
        </div>
      </Link>
    </li>
  );
}

/** Inbox: the viewer's matches enriched with conversation id, last message, and
 *  unread counts (Increment 15 contract), ordered as the backend returns them. */
export function InboxPage(): JSX.Element {
  const { me } = useAuth();
  const { status, matches, error, reload } = useInbox();

  if (status === "loading" || status === "idle") return <Spinner label="Loading your inbox…" />;
  if (status === "error") return <ErrorState message={error ?? "Error"} onRetry={reload} />;

  return (
    <section className="page page--inbox" aria-label="Inbox">
      <header className="page__header">
        <h1>Inbox</h1>
      </header>
      {matches.length === 0 ? (
        <EmptyState
          title="No matches yet"
          description="When you and someone like each other, they'll show up here."
          action={
            <Link to="/app/discover" className="btn btn--secondary">
              Go to Discover
            </Link>
          }
        />
      ) : (
        <ul className="inbox-list">
          {matches.map((m) => (
            <InboxRow key={m.matchId} m={m} meId={me?.id ?? null} />
          ))}
        </ul>
      )}
    </section>
  );
}
