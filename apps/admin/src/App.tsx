import { Routes, Route, Navigate } from "react-router-dom";
import { RequireAdmin } from "./components/auth/RequireAdmin";
import { AdminShell } from "./components/layout/AdminShell";
import LoginPage from "./screens/Login";
import DashboardPage from "./screens/Dashboard";
import UsersPage from "./screens/Users";
import UserDetailPage from "./screens/Users/UserDetail";
import ModerationPage from "./screens/Moderation";
import DocumentDetailPage from "./screens/Moderation/DocumentDetail";
import VerificationPage from "./screens/Verification";
import { ConfigLayout } from "./screens/Config/ConfigLayout";
import FeatureFlagsPage from "./screens/Config/FeatureFlags";
import PricingConfigPage from "./screens/Config/Pricing";
import AnnouncementsPage from "./screens/Config/Announcements";
import SystemHealthPage from "./screens/Config/SystemHealth";

function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route element={<RequireAdmin />}>
        <Route element={<AdminShell />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/users" element={<UsersPage />} />
          <Route path="/users/:id" element={<UserDetailPage />} />
          <Route path="/moderation" element={<ModerationPage />} />
          <Route path="/moderation/:documentId" element={<DocumentDetailPage />} />
          <Route path="/verification" element={<VerificationPage />} />
          <Route path="/config" element={<ConfigLayout />}>
            <Route index element={<Navigate to="/config/feature-flags" replace />} />
            <Route path="feature-flags" element={<FeatureFlagsPage />} />
            <Route path="pricing" element={<PricingConfigPage />} />
            <Route path="announcements" element={<AnnouncementsPage />} />
            <Route path="system-health" element={<SystemHealthPage />} />
          </Route>
        </Route>
      </Route>
    </Routes>
  );
}

export default App;
