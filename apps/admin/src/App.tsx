import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { useLanguage } from "./lib/i18n";
import { RequireAdmin } from "./components/auth/RequireAdmin";
import { AdminShell } from "./components/layout/AdminShell";
import { ConfigLayout } from "./screens/Config/ConfigLayout";
import { WaitlistLayout } from "./screens/Waitlist/WaitlistLayout";
import { PricingLayout } from "./screens/Pricing/PricingLayout";
import { RevenueLayout } from "./screens/Revenue/RevenueLayout";

// Each screen is its own chunk, loaded when first visited, so the first load
// doesn't download every page (and recharts) at once.
const LoginPage = lazy(() => import("./screens/Login"));
const AuthCallbackPage = lazy(() => import("./screens/AuthCallback"));
const DashboardPage = lazy(() => import("./screens/Dashboard"));
const ActivityPage = lazy(() => import("./screens/Activity"));
const ReferralsPage = lazy(() => import("./screens/Referrals"));
const UsersPage = lazy(() => import("./screens/Users"));
const UserDetailPage = lazy(() => import("./screens/Users/UserDetail"));
const UserActionsTab = lazy(() => import("./screens/Users/ActionsTab"));
const UserMessagesTab = lazy(() => import("./screens/Users/MessagesTab"));
const UserDocumentsTab = lazy(() => import("./screens/Users/DocumentsTab"));
const UserActivityTab = lazy(() => import("./screens/Users/ActivityTab"));
const ModerationPage = lazy(() => import("./screens/Moderation"));
const DocumentDetailPage = lazy(() => import("./screens/Moderation/DocumentDetail"));
const VerificationPage = lazy(() => import("./screens/Verification"));
const SupportInboxPage = lazy(() => import("./screens/Support"));
const SupportTicketDetailPage = lazy(() => import("./screens/Support/TicketDetail"));
const FeatureFlagsPage = lazy(() => import("./screens/Config/FeatureFlags"));
const AnnouncementsPage = lazy(() => import("./screens/Announcements"));
const SystemHealthPage = lazy(() => import("./screens/Config/SystemHealth"));
const AccessPage = lazy(() => import("./screens/Waitlist/Access"));
const PlansAndPacksPage = lazy(() => import("./screens/Pricing/PlansAndPacks"));
const DiscountsPage = lazy(() => import("./screens/Pricing/Discounts"));
const RevenueOverviewPage = lazy(() => import("./screens/Revenue/Overview"));
const RevenueTransactionsPage = lazy(() => import("./screens/Revenue/Transactions"));
const RevenueOrdersPage = lazy(() => import("./screens/Revenue/Orders"));

function App() {
  // Re-render every screen when the UI language changes (t() reads it at call time).
  useLanguage();
  return (
    <Suspense fallback={<div className="min-h-dvh bg-bg" />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/auth/callback" element={<AuthCallbackPage />} />

        <Route element={<RequireAdmin />}>
          <Route element={<AdminShell />}>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/revenue" element={<RevenueLayout />}>
              <Route index element={<Navigate to="/revenue/overview" replace />} />
              <Route path="overview" element={<RevenueOverviewPage />} />
              <Route path="transactions" element={<RevenueTransactionsPage />} />
              <Route path="orders" element={<RevenueOrdersPage />} />
            </Route>
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="/referrals" element={<ReferralsPage />} />
            <Route path="/users" element={<UsersPage />} />
            <Route path="/users/:id" element={<UserDetailPage />}>
              <Route index element={<Navigate to="actions" replace />} />
              <Route path="actions" element={<UserActionsTab />} />
              <Route path="messages" element={<UserMessagesTab />} />
              <Route path="documents" element={<UserDocumentsTab />} />
              <Route path="activity" element={<UserActivityTab />} />
            </Route>
            <Route path="/moderation" element={<ModerationPage />} />
            <Route path="/moderation/:documentId" element={<DocumentDetailPage />} />
            <Route path="/verification" element={<VerificationPage />} />
            <Route path="/support" element={<SupportInboxPage />} />
            <Route path="/support/:number" element={<SupportTicketDetailPage />} />
            <Route path="/waitlist" element={<WaitlistLayout />}>
              <Route index element={<Navigate to="/waitlist/access" replace />} />
              <Route path="access" element={<AccessPage />} />
            </Route>
            <Route path="/pricing" element={<PricingLayout />}>
              <Route index element={<Navigate to="/pricing/plans" replace />} />
              <Route path="plans" element={<PlansAndPacksPage />} />
              <Route path="discounts" element={<DiscountsPage />} />
            </Route>
            <Route path="/announcements" element={<AnnouncementsPage />} />
            <Route path="/config" element={<ConfigLayout />}>
              <Route index element={<Navigate to="/config/feature-flags" replace />} />
              <Route path="feature-flags" element={<FeatureFlagsPage />} />
              <Route path="announcements" element={<Navigate to="/announcements" replace />} />
              <Route path="system-health" element={<SystemHealthPage />} />
            </Route>
          </Route>
        </Route>
      </Routes>
    </Suspense>
  );
}

export default App;
