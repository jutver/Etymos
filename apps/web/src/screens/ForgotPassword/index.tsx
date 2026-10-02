import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import { Envelope, WarningCircle } from "@phosphor-icons/react";
import { supabase } from "@etymos/shared";
import { Button } from "../../components/ui/Button";
import { AuthResultCard } from "../../components/auth/AuthResultCard";
import { requestResetViaRecoveryEmail } from "../../lib/api";
import { t } from "../../lib/i18n";

/** Supabase refuses a second reset email to the same user within 60 seconds;
 * the resend button waits the same amount so it never hits that error. */
const RESEND_COOLDOWN_SECONDS = 60;

interface LocationState {
  email?: string;
}

export default function ForgotPasswordPage() {
  const location = useLocation();
  const [email, setEmail] = useState((location.state as LocationState)?.email ?? "");
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  async function sendLink(address: string) {
    setError(null);
    setSending(true);
    // Both halves run for every request so the response never reveals which
    // kind of address (if any) matched: Supabase handles login emails, the
    // backend handles confirmed recovery emails.
    const [{ error: resetError }] = await Promise.all([
      supabase.auth.resetPasswordForEmail(address, {
        redirectTo: `${window.location.origin}/reset-password`,
      }),
      requestResetViaRecoveryEmail(address),
    ]);
    setSending(false);

    if (resetError) {
      setError(
        resetError.status === 429
          ? t("Too many requests. Please wait a minute and try again.")
          : resetError.message,
      );
      return;
    }
    setSentTo(address);
    setCooldown(RESEND_COOLDOWN_SECONDS);
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    void sendLink(email.trim());
  }

  if (sentTo) {
    return (
      <AuthResultCard
        tone="info"
        title={t("Check your email")}
        actions={
          <>
            <Button size="lg" fullWidth loading={sending} disabled={cooldown > 0} onClick={() => void sendLink(sentTo)}>
              {cooldown > 0 ? t("Send again in {{seconds}}s", { seconds: cooldown }) : t("Send again")}
            </Button>
            <Link to="/login" className="text-sm font-semibold text-brand-600 hover:underline">
              {t("Back to Login")}
            </Link>
          </>
        }
      >
        <p>
          {t("If an account uses {{email}} as its login email or confirmed recovery email, we've sent it a link to choose a new password.", {
            email: sentTo,
          })}
        </p>
        <p className="mt-2">{t("The link expires in 30 minutes. Can't find it? Check your spam folder.")}</p>
        {error && <p className="mt-3 text-severity-high">{error}</p>}
      </AuthResultCard>
    );
  }

  return (
    <div className="rounded-[var(--radius-card-lg)] border border-line bg-white p-7 shadow-[var(--shadow-card)] sm:p-8">
      <h1 className="text-h3 font-bold tracking-tight text-navy-900">{t("Forgot your password?")}</h1>
      <p className="mt-1.5 text-sm text-ink-500">
        {t("Enter your login email or confirmed recovery email and we'll send you a link to choose a new one.")}
      </p>

      {error && (
        <div className="mt-5 flex items-start gap-2.5 rounded-[var(--radius-control)] border border-severity-high-line bg-severity-high-bg px-4 py-3 text-sm text-severity-high">
          <WarningCircle size={18} weight="fill" className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-ink-700">{t("Email")}</span>
          <div className="relative">
            <Envelope size={17} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-300" />
            <input
              type="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full rounded-[var(--radius-control)] border border-line bg-white py-2.5 pl-10 pr-4 text-sm placeholder:text-ink-300 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-200"
            />
          </div>
        </label>

        <Button type="submit" size="lg" loading={sending} fullWidth className="mt-1">
          {t("Send reset link")}
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-ink-600">
        {t("Remembered it?")}{" "}
        <Link to="/login" className="font-semibold text-brand-600 hover:underline">
          {t("Back to Login")}
        </Link>
      </p>
    </div>
  );
}
