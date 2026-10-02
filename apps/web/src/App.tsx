import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { useEffect } from "react";
import { PublicShell } from "./components/layout/PublicShell";
import { AppShell } from "./components/layout/AppShell";
import { AuthShell } from "./components/layout/AuthShell";
import { RequireAuth } from "./components/auth/RequireAuth";
import { AnnouncementBanner } from "./components/AnnouncementBanner";
import { PageLoader } from "./components/ui/PageLoader";
import { useAuth } from "./lib/auth";
import { trackPageView } from "./lib/analytics";
import { useLanguage } from "./lib/i18n";
// Screens are lazy-loaded so each route is its own chunk — this roughly halves
// the initial payload. The Suspense fallbacks live inside the layout shells,
// so nav/footer stay mounted across a route transition.
import {
  LandingPage,
  PricingPage,
  LoginPage,
  SignupPage,
  UploadPage,
  AnalyzingPage,
  ReportPage,
  HistoryPage,
  DocumentsPage,
  TrashPage,
  PaywallPage,
  CheckoutPage,
  PaymentSuccessPage,
  AccountProfilePage,
  AccountPlanPage,
  VerifyStudentPage,
  VerifyEmailPage,
  AuthCallbackPage,
  EmailVerifiedPage,
  ForgotPasswordPage,
  ResetPasswordPage,
  RecoveryEmailVerifyPage,
  WaitlistPage,
} from "./components/layout/lazyScreens";
import { ClosedBetaModal } from "./components/ClosedBetaModal";

/** Where a signed-in user belongs whenever the URL doesn't name a real screen. */
const APP_HOME = "/upload";

// Thin wrappers so the banner sits above PublicShell/AppShell's own nav
// without editing those components (out of scope for this change).
function PublicShellWithBanner() {
  return (
    <>
      <AnnouncementBanner />
      <PublicShell />
    </>
  );
}

function AppShellWithBanner() {
  return (
    <>
      <AnnouncementBanner />
      <AppShell />
    </>
  );
}

/**
 * `/` is the marketing landing page for visitors, but a signed-in user typing
 * the bare domain (or trimming `/upload` off the address bar) expects to land
 * back in the app — not on a public page whose nav offers "Log in / Sign up",
 * which reads as having been logged out even though the Supabase session is
 * still in localStorage the whole time.
 *
 * We must wait for `loading` before deciding: AuthProvider resolves the
 * persisted session asynchronously, so rendering on the first pass would show
 * the landing page to everyone and only then bounce signed-in users away.
 * PageLoader's own 150ms delay means a session that resolves quickly — the
 * normal case, since it is read from localStorage — shows no spinner at all.
 */
function HomeRoute() {
  const { user, loading } = useAuth();

  if (loading) return <PageLoader />;
  if (user) return <Navigate to={APP_HOME} replace />;

  return (
    <>
      <ClosedBetaModal />
      <LandingPage />
    </>
  );
}

/**
 * Catch-all for any path no route claims. Without it React Router matches
 * nothing and renders a blank page, so a partially-deleted URL (`/uploa`,
 * `/up`) looks like the site is broken. Signed-in users go back to the app,
 * visitors to the landing page — where HomeRoute takes over.
 */
function NotFoundRoute() {
  const { user, loading } = useAuth();

  if (loading) return <PageLoader />;
  return <Navigate to={user ? APP_HOME : "/"} replace />;
}

function ScrollToTop() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    if (hash) {
      const el = document.getElementById(hash.slice(1));
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
    }
    window.scrollTo(0, 0);
  }, [pathname, hash]);
  return null;
}

/** Records one `page_view` per route change for the admin Activity dashboard. */
function PageViewTracker() {
  const { pathname } = useLocation();
  useEffect(() => {
    trackPageView(pathname);
  }, [pathname]);
  return null;
}

function App() {
  // Re-render the whole route tree when the UI language changes: `t()` reads the
  // current language at call time, so every screen has to render again.
  useLanguage();
  return (
    <>
      <ScrollToTop />
      <PageViewTracker />
      <Routes>
        <Route element={<PublicShellWithBanner />}>
          <Route path="/" element={<HomeRoute />} />
          <Route path="/pricing" element={<PricingPage />} />
        </Route>

        <Route element={<AuthShell />}>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route path="/verify-email" element={<VerifyEmailPage />} />
          <Route path="/auth/callback" element={<AuthCallbackPage />} />
          <Route path="/email-verified" element={<EmailVerifiedPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/recovery-email/verify" element={<RecoveryEmailVerifyPage />} />
        </Route>

        <Route element={<RequireAuth />}>
          {/* Outside the AppShell gate on purpose — a waitlisted user must be
              able to reach this without the authenticated app chrome. */}
          <Route path="/waitlist" element={<WaitlistPage />} />

          <Route element={<AppShellWithBanner />}>
            <Route path="/upload" element={<UploadPage />} />
            <Route path="/analyzing" element={<AnalyzingPage />} />
            <Route path="/report/:id" element={<ReportPage />} />
            <Route path="/documents" element={<DocumentsPage />} />
            <Route path="/history" element={<HistoryPage />} />
            <Route path="/trash" element={<TrashPage />} />
            <Route path="/paywall" element={<PaywallPage />} />
            <Route path="/checkout" element={<CheckoutPage />} />
            <Route path="/payment-success" element={<PaymentSuccessPage />} />
            <Route path="/account/profile" element={<AccountProfilePage />} />
            <Route path="/account/plan" element={<AccountPlanPage />} />
            <Route path="/verify-student" element={<VerifyStudentPage />} />
          </Route>
        </Route>

        <Route path="*" element={<NotFoundRoute />} />
      </Routes>
    </>
  );
}

export default App;
