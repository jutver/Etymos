import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "../../components/ui/Button";
import { PageLoader } from "../../components/ui/PageLoader";
import { AuthResultCard } from "../../components/auth/AuthResultCard";
import { supabase } from "@etymos/shared";
import { initialAuthRedirect, useAuth } from "../../lib/auth";
import { t } from "../../lib/i18n";

/** Survives a refresh of this page after we've signed the user out, so the
 * success message doesn't turn into "invalid link" on reload. */
const VERIFIED_FLAG = "etymos-email-verified";

type Outcome = "verified" | "expired" | "invalid";

/**
 * Landing page for the signup confirmation link (`emailRedirectTo` in
 * Signup/VerifyEmail). Clicking the link signs the user in on this browser;
 * we sign them straight back out so "Back to Login" leads to a real login
 * rather than a form shown to someone already signed in.
 */
export default function EmailVerifiedPage() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const [signedOut, setSignedOut] = useState(false);
  // Latched once verified, so signing out (user -> null) can't flip the
  // page to "invalid" when sessionStorage is unavailable.
  const [latched, setLatched] = useState(readFlag);

  const outcome: Outcome | null = (() => {
    if (initialAuthRedirect.errorCode) return "expired";
    if (latched) return "verified";
    if (loading) return null;
    if (initialAuthRedirect.hasSession && user) return "verified";
    return "invalid";
  })();

  useEffect(() => {
    if (outcome !== "verified" || loading) return;
    writeFlag();
    setLatched(true);
    // Only end a session this link created — never one the user had already.
    if (!initialAuthRedirect.hasSession || !user) {
      setSignedOut(true);
      return;
    }
    // Local scope: only end the session this link just created, not any
    // other device the user may already be signed in on.
    supabase.auth.signOut({ scope: "local" }).finally(() => setSignedOut(true));
  }, [outcome, loading, user]);

  if (!outcome) return <PageLoader />;

  const backToLogin = (
    <Button size="lg" fullWidth loading={outcome === "verified" && !signedOut} onClick={() => navigate("/login", { replace: true })}>
      {t("Back to Login")}
    </Button>
  );

  if (outcome === "verified") {
    return (
      <AuthResultCard tone="success" title={t("Your email has been verified")} actions={backToLogin}>
        {t("Thanks for confirming your email address. You can now log in to your Etymos account.")}
      </AuthResultCard>
    );
  }

  return (
    <AuthResultCard
      tone="error"
      title={outcome === "expired" ? t("This verification link has expired") : t("This link can't be used")}
      actions={
        <>
          {backToLogin}
          <p className="text-sm text-ink-600">
            {t("Need a new link?")}{" "}
            <Link to="/signup" className="font-semibold text-brand-600 hover:underline">
              {t("Sign up again with the same email")}
            </Link>
          </p>
        </>
      }
    >
      {outcome === "expired"
        ? t("Verification links work once, for 30 minutes. If you've already verified your email, just log in.")
        : t("We couldn't find a verification in this link. If you've already verified your email, just log in.")}
    </AuthResultCard>
  );
}

function readFlag(): boolean {
  try {
    return sessionStorage.getItem(VERIFIED_FLAG) === "1";
  } catch {
    return false;
  }
}

function writeFlag() {
  try {
    sessionStorage.setItem(VERIFIED_FLAG, "1");
  } catch {
    // Storage blocked (private mode) — only costs the refresh nicety.
  }
}
