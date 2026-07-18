import { Routes, Route, useLocation } from "react-router-dom";
import { useEffect } from "react";
import { PublicShell } from "./components/layout/PublicShell";
import { AppShell } from "./components/layout/AppShell";
import { AuthShell } from "./components/layout/AuthShell";
import { RequireAuth } from "./components/auth/RequireAuth";
import { DemoNoticeModal } from "./components/DemoNoticeModal";
import { AnnouncementBanner } from "./components/AnnouncementBanner";
import LandingPage from "./screens/Landing";
import PricingPage from "./screens/Pricing";
import LoginPage from "./screens/Login";
import SignupPage from "./screens/Signup";
import UploadPage from "./screens/Upload";
import AnalyzingPage from "./screens/Analyzing";
import ReportPage from "./screens/Report";
import HistoryPage from "./screens/History";
import TrashPage from "./screens/Trash";
import PaywallPage from "./screens/Paywall";
import CheckoutPage from "./screens/Checkout";
import PaymentSuccessPage from "./screens/PaymentSuccess";
import AccountProfilePage from "./screens/AccountProfile";
import AccountPlanPage from "./screens/AccountPlan";
import VerifyStudentPage from "./screens/VerifyStudent";
import VerifyEmailPage from "./screens/VerifyEmail";
import AuthCallbackPage from "./screens/AuthCallback";

// Thin wrappers so the banner sits above PublicShell/AppShell's own nav
// without editing those components (out of scope for this change) — mirrors
// how DemoNoticeModal is mounted globally below, just scoped to these routes.
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

function App() {
  return (
    <>
      <ScrollToTop />
      <DemoNoticeModal />
      <Routes>
        <Route element={<PublicShellWithBanner />}>
          <Route path="/" element={<LandingPage />} />
          <Route path="/pricing" element={<PricingPage />} />
        </Route>

        <Route element={<AuthShell />}>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route path="/verify-email" element={<VerifyEmailPage />} />
          <Route path="/auth/callback" element={<AuthCallbackPage />} />
        </Route>

        <Route element={<RequireAuth />}>
          <Route element={<AppShellWithBanner />}>
            <Route path="/upload" element={<UploadPage />} />
            <Route path="/analyzing" element={<AnalyzingPage />} />
            <Route path="/report/:id" element={<ReportPage />} />
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
      </Routes>
    </>
  );
}

export default App;
