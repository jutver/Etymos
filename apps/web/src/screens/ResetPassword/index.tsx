import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "../../components/ui/Button";
import { PageLoader } from "../../components/ui/PageLoader";
import { AuthResultCard } from "../../components/auth/AuthResultCard";
import { NewPasswordForm } from "../../components/auth/NewPasswordForm";
import { initialAuthRedirect, useAuth } from "../../lib/auth";
import { t } from "../../lib/i18n";

/**
 * Landing page for the password-reset link in Supabase's email to the
 * account's login address (/forgot-password). Recovery through a recovery
 * email uses a code on /recover-account instead and never lands here.
 *
 * Opening the link signs the user in with a short-lived recovery session.
 * Supabase rejects a link older than its 30-minute OTP expiry by redirecting
 * here with `#error_code=otp_expired`, which shows the expired state.
 */
export default function ResetPasswordPage() {
  const { user, loading } = useAuth();
  const [done, setDone] = useState(false);

  if (done) {
    return (
      <AuthResultCard tone="success" title={t("Password updated")} actions={<BackToLogin />}>
        {t("Your password has been changed and you've been signed out everywhere. Log in with your new password.")}
      </AuthResultCard>
    );
  }

  if (initialAuthRedirect.errorCode) {
    return (
      <AuthResultCard
        tone="error"
        title={t("This reset link has expired")}
        actions={
          <>
            <RequestNewLink />
            <BackToLogin variant="link" />
          </>
        }
      >
        {t("Reset links work once, for 30 minutes. Request a new one to continue.")}
      </AuthResultCard>
    );
  }

  if (loading) return <PageLoader />;

  // Only a session created by a *recovery* link may set a password without
  // the old one — never a session the user already had in this browser.
  if (!(initialAuthRedirect.hasSession && initialAuthRedirect.type === "recovery" && user)) {
    return (
      <AuthResultCard
        tone="error"
        title={t("This link can't be used")}
        actions={
          <>
            <RequestNewLink />
            <BackToLogin variant="link" />
          </>
        }
      >
        {t("Open the reset link from your email, or request a new one.")}
      </AuthResultCard>
    );
  }

  return <NewPasswordForm email={user.email ?? ""} onDone={() => setDone(true)} />;
}

function RequestNewLink() {
  const navigate = useNavigate();
  return (
    <Button size="lg" fullWidth onClick={() => navigate("/forgot-password", { replace: true })}>
      {t("Request a new link")}
    </Button>
  );
}

function BackToLogin({ variant = "button" }: { variant?: "button" | "link" }) {
  const navigate = useNavigate();
  if (variant === "link") {
    return (
      <Link to="/login" replace className="text-sm font-semibold text-brand-600 hover:underline">
        {t("Back to Login")}
      </Link>
    );
  }
  return (
    <Button size="lg" fullWidth onClick={() => navigate("/login", { replace: true })}>
      {t("Back to Login")}
    </Button>
  );
}
