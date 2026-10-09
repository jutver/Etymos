import { lazy } from "react";

/**
 * Route-level code splitting.
 *
 * Every screen is loaded on demand via `React.lazy`, which lets Vite emit one
 * chunk per screen instead of folding all of them into the entry bundle. The
 * exported names match the identifiers App.tsx already uses, so adopting this
 * is a single import swap — see the note at the bottom of this file.
 *
 * The Suspense boundaries that cover these are inside the layout shells
 * (AppShell / PublicShell / AuthShell), wrapping their <Outlet />, so a route
 * transition swaps only the page body and leaves the nav, footer and toasts
 * mounted.
 */

// Public
export const LandingPage = lazy(() => import("../../screens/Landing"));
export const PricingPage = lazy(() => import("../../screens/Pricing"));
export const WaitlistPage = lazy(() => import("../../screens/Waitlist"));
export const ContactPage = lazy(() => import("../../screens/Contact"));
export const GuestSupportTicketPage = lazy(() => import("../../screens/GuestSupportTicket"));

// Auth
export const LoginPage = lazy(() => import("../../screens/Login"));
export const SignupPage = lazy(() => import("../../screens/Signup"));
export const VerifyEmailPage = lazy(() => import("../../screens/VerifyEmail"));
export const AuthCallbackPage = lazy(() => import("../../screens/AuthCallback"));
export const EmailVerifiedPage = lazy(() => import("../../screens/EmailVerified"));
export const ForgotPasswordPage = lazy(() => import("../../screens/ForgotPassword"));
export const ResetPasswordPage = lazy(() => import("../../screens/ResetPassword"));
export const RecoverAccountPage = lazy(() => import("../../screens/RecoverAccount"));

// Authenticated app
export const UploadPage = lazy(() => import("../../screens/Upload"));
export const AnalyzingPage = lazy(() => import("../../screens/Analyzing"));
export const ReportPage = lazy(() => import("../../screens/Report"));
export const DocumentsPage = lazy(() => import("../../screens/Documents"));
export const HistoryPage = lazy(() => import("../../screens/History"));
export const TrashPage = lazy(() => import("../../screens/Trash"));
export const PaywallPage = lazy(() => import("../../screens/Paywall"));
export const CheckoutPage = lazy(() => import("../../screens/Checkout"));
export const PaymentSuccessPage = lazy(() => import("../../screens/PaymentSuccess"));
export const AccountProfilePage = lazy(() => import("../../screens/AccountProfile"));
export const AccountPlanPage = lazy(() => import("../../screens/AccountPlan"));
export const PaymentHistoryPage = lazy(() => import("../../screens/PaymentHistory"));
export const VerifyStudentPage = lazy(() => import("../../screens/VerifyStudent"));
export const SupportRequestsPage = lazy(() => import("../../screens/SupportRequests"));
export const SupportTicketPage = lazy(() => import("../../screens/SupportTicket"));

/**
 * Warm the chunks a signed-in user is most likely to hit next, once the
 * current route has settled. Call from an idle callback — never during render
 * — so prefetching never competes with the page the user is actually on.
 */
export function prefetchAppScreens() {
  void import("../../screens/Upload");
  void import("../../screens/Documents");
}

/*
 * ── Adopting this in App.tsx ────────────────────────────────────────────────
 * Replace the eager screen imports:
 *
 *   import LandingPage from "./screens/Landing";
 *   ...17 more lines...
 *
 * with one line:
 *
 *   import { LandingPage, PricingPage, WaitlistPage, LoginPage, SignupPage,
 *     UploadPage, AnalyzingPage, ReportPage, HistoryPage, DocumentsPage,
 *     TrashPage, PaywallPage, CheckoutPage, PaymentSuccessPage,
 *     AccountProfilePage, AccountPlanPage, VerifyStudentPage, VerifyEmailPage,
 *     AuthCallbackPage,
 *   } from "./components/layout/lazyScreens";
 *
 * Nothing else in App.tsx changes — the <Route element={...}> usage is
 * identical, and the Suspense fallbacks already live in the shells.
 */
