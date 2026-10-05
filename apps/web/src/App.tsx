import { Navigate, Route, Routes } from "react-router-dom";
import { ProtectedRoute, PublicOnlyRoute } from "./components/ProtectedRoute";
import { AppShell } from "./components/AppShell";
import { LoginPage } from "./pages/LoginPage";
import { RegisterPage } from "./pages/RegisterPage";
import { DiscoverPage } from "./pages/DiscoverPage";
import { InboxPage } from "./pages/InboxPage";
import { ConversationPage } from "./pages/ConversationPage";
import { ProfilePage } from "./pages/ProfilePage";

/** Top-level route table. Public auth routes + the protected /app shell. */
export function App(): JSX.Element {
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <PublicOnlyRoute>
            <LoginPage />
          </PublicOnlyRoute>
        }
      />
      <Route
        path="/register"
        element={
          <PublicOnlyRoute>
            <RegisterPage />
          </PublicOnlyRoute>
        }
      />

      <Route
        path="/app"
        element={
          <ProtectedRoute>
            <AppShell />
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/app/discover" replace />} />
        <Route path="discover" element={<DiscoverPage />} />
        <Route path="inbox" element={<InboxPage />} />
        <Route path="inbox/:matchId" element={<ConversationPage />} />
        <Route path="profile" element={<ProfilePage />} />
      </Route>

      <Route path="*" element={<Navigate to="/app/discover" replace />} />
    </Routes>
  );
}
