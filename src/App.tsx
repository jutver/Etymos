import { Routes, Route, useLocation } from "react-router-dom";
import { useEffect } from "react";
import { PublicShell } from "./components/layout/PublicShell";
import { AppShell } from "./components/layout/AppShell";
import LandingPage from "./screens/Landing";
import PricingPage from "./screens/Pricing";
import UploadPage from "./screens/Upload";
import AnalyzingPage from "./screens/Analyzing";
import ReportPage from "./screens/Report";
import DashboardPage from "./screens/Dashboard";
import PaywallPage from "./screens/Paywall";
import CheckoutPage from "./screens/Checkout";
import PaymentSuccessPage from "./screens/PaymentSuccess";

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
      <Routes>
        <Route element={<PublicShell />}>
          <Route path="/" element={<LandingPage />} />
          <Route path="/pricing" element={<PricingPage />} />
        </Route>

        <Route element={<AppShell />}>
          <Route path="/upload" element={<UploadPage />} />
          <Route path="/analyzing" element={<AnalyzingPage />} />
          <Route path="/report/:id" element={<ReportPage />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/paywall" element={<PaywallPage />} />
          <Route path="/checkout" element={<CheckoutPage />} />
          <Route path="/payment-success" element={<PaymentSuccessPage />} />
        </Route>
      </Routes>
    </>
  );
}

export default App;
