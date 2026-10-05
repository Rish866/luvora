import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { useRealtime } from "../api/RealtimeContext";
import { InboxProvider, useInbox } from "../hooks/useInbox";

/** The persistent navigation (bottom bar on mobile, sidebar on desktop). */
function Nav(): JSX.Element {
  const { totalUnreadCount } = useInbox();
  const { status: rtStatus } = useRealtime();
  const { logout } = useAuth();
  const navigate = useNavigate();

  const onLogout = async (): Promise<void> => {
    await logout();
    navigate("/login", { replace: true });
  };

  return (
    <nav className="nav" aria-label="Primary">
      <div className="nav__brand">Luvora</div>
      <ul className="nav__links">
        <li>
          <NavLink to="/app/discover" className="nav__link">
            <span className="nav__icon" aria-hidden>◎</span>
            <span>Discover</span>
          </NavLink>
        </li>
        <li>
          <NavLink to="/app/inbox" className="nav__link">
            <span className="nav__icon" aria-hidden>✉</span>
            <span>Inbox</span>
            {totalUnreadCount > 0 && (
              <span className="badge" aria-label={`${totalUnreadCount} unread`}>
                {totalUnreadCount > 99 ? "99+" : totalUnreadCount}
              </span>
            )}
          </NavLink>
        </li>
        <li>
          <NavLink to="/app/profile" className="nav__link">
            <span className="nav__icon" aria-hidden>☺</span>
            <span>Profile</span>
          </NavLink>
        </li>
      </ul>
      <div className="nav__footer">
        <span
          className={`conn-dot conn-dot--${rtStatus}`}
          title={`Realtime: ${rtStatus}`}
          aria-label={`Realtime connection ${rtStatus}`}
        />
        <button type="button" className="btn btn--ghost" onClick={onLogout}>
          Log out
        </button>
      </div>
    </nav>
  );
}

/** The authenticated application layout. */
export function AppShell(): JSX.Element {
  return (
    <InboxProvider>
      <div className="app-shell">
        <Nav />
        <main className="app-main">
          <Outlet />
        </main>
      </div>
    </InboxProvider>
  );
}
