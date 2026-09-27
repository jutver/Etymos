import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { CheckCircle, WarningCircle } from "@phosphor-icons/react";
import { Button } from "../../components/ui/Button";
import { PageLoader } from "../../components/ui/PageLoader";
import { supabase } from "@etymos/shared";
import { initialAuthRedirect, useAuth } from "../../lib/auth";

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

  const verified = outcome === "verified";

  return (
    <div className="rounded-[var(--radius-card-lg)] border border-line bg-white p-7 text-center shadow-[var(--shadow-card)] sm:p-8">
      <div
        className={
          verified
            ? "mx-auto flex size-14 items-center justify-center rounded-full bg-green-100 text-green-600"
            : "mx-auto flex size-14 items-center justify-center rounded-full bg-severity-high-bg text-severity-high"
        }
      >
        {verified ? <CheckCircle size={30} weight="fill" /> : <WarningCircle size={30} weight="fill" />}
      </div>

      <h1 className="mt-5 text-h3 font-bold tracking-tight text-navy-900">
        {verified ? "Your email has been verified" : "This link can't be used"}
      </h1>

      <p className="mt-2.5 text-sm leading-relaxed text-ink-600">
        {verified && "Thanks for confirming your email address. You can now log in to your Etymos account."}
        {outcome === "expired" &&
          "This verification link has expired or has already been used. If you've already verified your email, just log in."}
        {outcome === "invalid" &&
          "We couldn't find a verification in this link. If you've already verified your email, just log in."}
      </p>

      <Button
        size="lg"
        fullWidth
        className="mt-6"
        loading={verified && !signedOut}
        onClick={() => navigate("/login", { replace: true })}
      >
        Back to Login
      </Button>

      {!verified && (
        <p className="mt-6 text-sm text-ink-600">
          Need a new link?{" "}
          <Link to="/signup" className="font-semibold text-brand-600 hover:underline">
            Sign up again
          </Link>{" "}
          with the same email.
        </p>
      )}
    </div>
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
