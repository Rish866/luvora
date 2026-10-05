import { Navigate, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "../auth/AuthContext";
import { Spinner } from "./states";

/**
 * Gate for authenticated pages. While the session is bootstrapping we show a
 * spinner (never flash the login screen); unauthenticated users are redirected
 * to /login, preserving the intended path so they return to it after login.
 */
export function ProtectedRoute({ children }: { children: ReactNode }): JSX.Element {
  const { status } = useAuth();
  const location = useLocation();

  if (status === "loading") {
    return (
      <div className="centered-screen">
        <Spinner label="Loading your session…" />
      </div>
    );
  }
  if (status === "unauthenticated") {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <>{children}</>;
}

/** Inverse gate: public auth pages redirect INTO the app when already signed in. */
export function PublicOnlyRoute({ children }: { children: ReactNode }): JSX.Element {
  const { status } = useAuth();
  if (status === "loading") {
    return (
      <div className="centered-screen">
        <Spinner label="Loading…" />
      </div>
    );
  }
  if (status === "authenticated") {
    return <Navigate to="/app/discover" replace />;
  }
  return <>{children}</>;
}
