import { Routes, Route, useLocation } from "react-router-dom";
import { useEffect } from "react";
import { PublicShell } from "./components/layout/PublicShell";
import { AppShell } from "./components/layout/AppShell";
import { AuthShell } from "./components/layout/AuthShell";
import { RequireAuth } from "./components/auth/RequireAuth";
import { DemoNoticeModal } from "./components/DemoNoticeModal";
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
        <Route element={<PublicShell />}>
          <Route path="/" element={<LandingPage />} />
          <Route path="/pricing" element={<PricingPage />} />
        </Route>

        <Route element={<AuthShell />}>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
        </Route>

        <Route element={<RequireAuth />}>
          <Route element={<AppShell />}>
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
          </Route>
        </Route>
      </Routes>
    </>
  );
}

export default App;
