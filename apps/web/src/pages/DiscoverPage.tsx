import { useCallback, useEffect, useState } from "react";
import type { DiscoveryCandidate } from "@luvora/shared";
import { useApi } from "../api/ApiContext";
import { useInbox } from "../hooks/useInbox";
import { AuthedImage } from "../components/AuthedImage";
import { Spinner, EmptyState, ErrorState } from "../components/states";
import { toUserMessage } from "../lib/errors";

/**
 * Discovery: browse eligible candidates and like/pass. The backend is the sole
 * authority for eligibility/privacy/blocking/matching — the UI only renders
 * what the feed returns and reports a match when the like result says so.
 */
export function DiscoverPage(): JSX.Element {
  const api = useApi();
  const { reload: reloadInbox } = useInbox();

  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [candidates, setCandidates] = useState<DiscoveryCandidate[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const feed = await api.discovery.feed({ limit: 20 });
      setCandidates(feed.candidates);
      setCursor(feed.nextCursor);
      setStatus("ready");
    } catch (err) {
      setError(toUserMessage(err, "Could not load discovery."));
      setStatus("error");
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const current = candidates[0] ?? null;

  const advance = useCallback(async () => {
    setCandidates((cs) => cs.slice(1));
    // Prefetch more when the local stack runs low.
    if (candidates.length <= 2 && cursor) {
      try {
        const feed = await api.discovery.feed({ limit: 20, cursor });
        setCandidates((cs) => [...cs, ...feed.candidates]);
        setCursor(feed.nextCursor);
      } catch {
        /* keep what we have; a later action can retry */
      }
    }
  }, [api, candidates.length, cursor]);

  const onLike = useCallback(async () => {
    if (!current || acting) return;
    setActing(true);
    setBanner(null);
    try {
      const result = await api.discovery.like(current.id);
      if (result.matched) {
        setBanner(`It's a match with ${current.displayName}! 💞`);
        void reloadInbox();
      }
      await advance();
    } catch (err) {
      setBanner(toUserMessage(err, "Could not record your like."));
    } finally {
      setActing(false);
    }
  }, [api, current, acting, advance, reloadInbox]);

  const onPass = useCallback(async () => {
    if (!current || acting) return;
    setActing(true);
    setBanner(null);
    try {
      await api.discovery.pass(current.id);
      await advance();
    } catch (err) {
      setBanner(toUserMessage(err, "Could not record your pass."));
    } finally {
      setActing(false);
    }
  }, [api, current, acting, advance]);

  if (status === "loading") return <Spinner label="Finding people…" />;
  if (status === "error") return <ErrorState message={error ?? "Error"} onRetry={load} />;

  return (
    <section className="page page--discover" aria-label="Discover">
      <header className="page__header">
        <h1>Discover</h1>
      </header>

      {banner && (
        <div className="banner" role="status">
          {banner}
        </div>
      )}

      {!current ? (
        <EmptyState
          title="No one new right now"
          description="Check back later — new people join all the time."
          action={
            <button type="button" className="btn btn--secondary" onClick={load}>
              Refresh
            </button>
          }
        />
      ) : (
        <article className="candidate" aria-label={`Candidate ${current.displayName}`}>
          <div className="candidate__photo">
            <AuthedImage
              src={current.photo?.url ?? null}
              alt={current.displayName}
              className="candidate__img"
            />
          </div>
          <div className="candidate__body">
            <h2 className="candidate__name">
              {current.displayName}
              {current.age !== null && <span className="candidate__age"> · {current.age}</span>}
            </h2>
            {current.bio && <p className="candidate__bio">{current.bio}</p>}
            {current.interests.length > 0 && (
              <ul className="chips" aria-label="Interests">
                {current.interests.map((i) => (
                  <li key={i} className="chip">
                    {i}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="candidate__actions">
            <button
              type="button"
              className="btn btn--pass"
              onClick={onPass}
              disabled={acting}
              aria-label={`Pass on ${current.displayName}`}
            >
              Pass
            </button>
            <button
              type="button"
              className="btn btn--like"
              onClick={onLike}
              disabled={acting}
              aria-label={`Like ${current.displayName}`}
            >
              Like
            </button>
          </div>
        </article>
      )}
    </section>
  );
}
