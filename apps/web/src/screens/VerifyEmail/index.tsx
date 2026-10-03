import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { ArrowClockwise, CheckCircle } from "@phosphor-icons/react";
import { supabase } from "@etymos/shared";
import { Button } from "../../components/ui/Button";
import { AuthResultCard } from "../../components/auth/AuthResultCard";
import { t } from "../../lib/i18n";

/** Supabase refuses a second confirmation email to the same address within
 * 60 seconds; the resend button waits the same amount. */
const RESEND_COOLDOWN_SECONDS = 60;

interface LocationState {
  email?: string;
}

/**
 * Shown right after an email + password sign-up. Confirmation is link-only:
 * the email's button opens /email-verified, which confirms the address. This
 * page just says where the link went and lets the user resend it.
 */
export default function VerifyEmailPage() {
  const location = useLocation();
  const email = (location.state as LocationState)?.email ?? "";

  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Sign-up just sent the first email, so resending starts on cooldown.
  const [cooldown, setCooldown] = useState(email ? RESEND_COOLDOWN_SECONDS : 0);
  const inFlight = useRef(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  async function handleResend() {
    if (!email || inFlight.current) return;
    inFlight.current = true;
    setResending(true);
    setError(null);
    setResent(false);

    const { error: resendError } = await supabase.auth.resend({
      type: "signup",
      email,
      options: { emailRedirectTo: `${window.location.origin}/email-verified` },
    });

    inFlight.current = false;
    setResending(false);
    if (resendError) {
      setError(
        resendError.status === 429 ? t("Too many requests. Please wait a minute and try again.") : resendError.message,
      );
      return;
    }
    setResent(true);
    setCooldown(RESEND_COOLDOWN_SECONDS);
  }

  return (
    <AuthResultCard
      tone="info"
      title={t("Check your email")}
      actions={
        <>
          {email && (
            <Button
              variant="outline"
              size="lg"
              fullWidth
              loading={resending}
              disabled={cooldown > 0}
              onClick={handleResend}
              iconLeft={<ArrowClockwise size={16} />}
            >
              {cooldown > 0 ? t("Resend email in {{seconds}}s", { seconds: cooldown }) : t("Resend email")}
            </Button>
          )}
          <p className="text-sm text-ink-600">
            {t("Already confirmed?")}{" "}
            <Link to="/login" className="font-semibold text-brand-600 hover:underline">
              {t("Log in")}
            </Link>
          </p>
          <p className="text-sm text-ink-600">
            {t("Wrong email?")}{" "}
            <Link to="/signup" className="font-semibold text-brand-600 hover:underline">
              {t("Sign up again")}
            </Link>
          </p>
        </>
      }
    >
      <p>
        {email
          ? t("We've sent a confirmation link to {{email}}. Click it to activate your account.", { email })
          : t("We've sent a confirmation link to your email address. Click it to activate your account.")}
      </p>
      <p className="mt-2">{t("The link expires in 30 minutes. Can't find it? Check your spam folder.")}</p>
      {resent && (
        <p className="mt-3 flex items-center justify-center gap-1.5 text-green-700">
          <CheckCircle size={16} weight="fill" />
          {t("We sent a new link. Use the latest one.")}
        </p>
      )}
      {error && <p className="mt-3 text-severity-high">{error}</p>}
    </AuthResultCard>
  );
}
