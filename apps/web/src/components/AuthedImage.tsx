import { useEffect, useRef, useState } from "react";
import { useApiClient } from "../api/ApiContext";

/**
 * Renders a protected media image. Backend media bytes
 * (`/api/media/:id/content`) require an Authorization header, which the browser
 * does NOT send on a plain `<img src>`. So we fetch the bytes with auth, turn
 * them into an object URL, and render that — revoking the URL on unmount. When
 * the media is unavailable/unauthorized/pending we render the fallback.
 */
export function AuthedImage({
  src,
  alt,
  className,
  fallback,
}: {
  /** An app-relative media URL, e.g. "/api/media/:id/content", or null. */
  src: string | null;
  alt: string;
  className?: string;
  fallback?: React.ReactNode;
}): JSX.Element {
  const client = useApiClient();
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setFailed(false);
    setObjectUrl(null);
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
    if (!src) {
      setFailed(true);
      return;
    }
    client
      .fetchMediaObjectUrl(src, controller.signal)
      .then((url) => {
        if (cancelled) {
          if (url) URL.revokeObjectURL(url);
          return;
        }
        if (url) {
          urlRef.current = url;
          setObjectUrl(url);
        } else {
          setFailed(true);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      controller.abort();
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
    };
  }, [src, client]);

  if (failed || !src) {
    return (
      <span className={className} aria-label={alt} role="img" data-testid="authed-image-fallback">
        {fallback ?? <span className="avatar-fallback">{alt.slice(0, 1).toUpperCase()}</span>}
      </span>
    );
  }
  if (!objectUrl) {
    return <span className={className} aria-label={`${alt} loading`} data-testid="authed-image-loading" />;
  }
  return <img className={className} src={objectUrl} alt={alt} />;
}
