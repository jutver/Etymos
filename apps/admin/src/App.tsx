import { Routes, Route, Navigate } from "react-router-dom";
import { RequireAdmin } from "./components/auth/RequireAdmin";
import { AdminShell } from "./components/layout/AdminShell";
import LoginPage from "./screens/Login";
import AuthCallbackPage from "./screens/AuthCallback";
import DashboardPage from "./screens/Dashboard";
import UsersPage from "./screens/Users";
import UserDetailPage from "./screens/Users/UserDetail";
import ModerationPage from "./screens/Moderation";
import DocumentDetailPage from "./screens/Moderation/DocumentDetail";
import VerificationPage from "./screens/Verification";
import { ConfigLayout } from "./screens/Config/ConfigLayout";
import FeatureFlagsPage from "./screens/Config/FeatureFlags";
import AnnouncementsPage from "./screens/Config/Announcements";
import SystemHealthPage from "./screens/Config/SystemHealth";
import { WaitlistLayout } from "./screens/Waitlist/WaitlistLayout";
import AccessPage from "./screens/Waitlist/Access";
import PurchasesPage from "./screens/Waitlist/Purchases";
import { PricingLayout } from "./screens/Pricing/PricingLayout";
import PlansAndPacksPage from "./screens/Pricing/PlansAndPacks";
import DiscountsPage from "./screens/Pricing/Discounts";

function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/auth/callback" element={<AuthCallbackPage />} />

      <Route element={<RequireAdmin />}>
        <Route element={<AdminShell />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/users" element={<UsersPage />} />
          <Route path="/users/:id" element={<UserDetailPage />} />
          <Route path="/moderation" element={<ModerationPage />} />
          <Route path="/moderation/:documentId" element={<DocumentDetailPage />} />
          <Route path="/verification" element={<VerificationPage />} />
          <Route path="/waitlist" element={<WaitlistLayout />}>
            <Route index element={<Navigate to="/waitlist/access" replace />} />
            <Route path="access" element={<AccessPage />} />
            <Route path="purchases" element={<PurchasesPage />} />
          </Route>
          <Route path="/pricing" element={<PricingLayout />}>
            <Route index element={<Navigate to="/pricing/plans" replace />} />
            <Route path="plans" element={<PlansAndPacksPage />} />
            <Route path="discounts" element={<DiscountsPage />} />
          </Route>
          <Route path="/config" element={<ConfigLayout />}>
            <Route index element={<Navigate to="/config/feature-flags" replace />} />
            <Route path="feature-flags" element={<FeatureFlagsPage />} />
            <Route path="announcements" element={<AnnouncementsPage />} />
            <Route path="system-health" element={<SystemHealthPage />} />
          </Route>
        </Route>
      </Route>
    </Routes>
  );
}

export default App;
