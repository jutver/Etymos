import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "@etymos/shared";
import type { MfaStatus } from "../../lib/auth";
import { t } from "../../lib/i18n";
import { LanguageSwitcher } from "../LanguageSwitcher";

interface Enrollment {
  qrCode: string;
  secret: string;
}

/**
 * Second sign-in step for admins. Admin powers in the database and backend
 * need a session that passed an authenticator code (aal2), so the dashboard
 * isn't shown until then. First visit: scan a QR code and confirm one code.
 * After that: just the 6-digit code.
 */
export function MfaGate({ status }: { status: Exclude<MfaStatus, "loading" | "verified"> }) {
  const [factorId, setFactorId] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function prepare() {
      setPreparing(true);
      setError(null);
      const { data: factors, error: listError } = await supabase.auth.mfa.listFactors();
      if (cancelled) return;
      if (listError) {
        setError(listError.message);
        setPreparing(false);
        return;
      }

      if (status === "needs-code") {
        const verified = factors.totp[0];
        setFactorId(verified?.id ?? null);
        if (!verified) setError(t("No authenticator found for this account."));
        setPreparing(false);
        return;
      }

      // A setup that was started and abandoned leaves an unverified factor
      // behind; clear it so a fresh QR code can be issued.
      for (const factor of factors.all) {
        if (factor.factor_type === "totp" && factor.status === "unverified") {
          await supabase.auth.mfa.unenroll({ factorId: factor.id });
        }
      }
      const { data, error: enrollError } = await supabase.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: `Etymos Admin ${new Date().toISOString().slice(0, 10)}`,
      });
      if (cancelled) return;
      if (enrollError || !data) {
        setError(enrollError?.message ?? t("Couldn't start authenticator setup."));
      } else {
        setFactorId(data.id);
        setEnrollment({ qrCode: data.totp.qr_code, secret: data.totp.secret });
      }
      setPreparing(false);
    }

    prepare();
    return () => {
      cancelled = true;
    };
  }, [status]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!factorId) return;
    setError(null);
    setSubmitting(true);
    const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: code.trim() });
    setSubmitting(false);
    if (verifyError) {
      setError(t("That code didn't work. Check the time on your phone and try the newest code."));
      setCode("");
    }
    // On success the session is refreshed at aal2 and the auth context
    // re-reads it, which swaps this screen for the dashboard.
  }

  const settingUp = status === "needs-setup";

  return (
    <div className="relative flex min-h-dvh items-center justify-center bg-bg px-6">
      <LanguageSwitcher className="absolute right-4 top-4" />
      <div className="w-full max-w-sm rounded-card border border-border bg-surface p-8 shadow-card">
        <h1 className="text-h1 font-semibold text-fg">
          {settingUp ? t("Set up two-step sign-in") : t("Enter your code")}
        </h1>
        <p className="mt-1 text-body text-fg-muted">
          {settingUp
            ? t("Admin access needs an authenticator app. Scan this code with Google Authenticator, 1Password or similar, then enter the 6-digit code it shows.")
            : t("Open your authenticator app and enter the 6-digit code for Etymos Admin.")}
        </p>

        {settingUp && enrollment && (
          <div className="mt-5 flex flex-col items-center gap-3">
            <img src={enrollment.qrCode} alt={t("QR code for your authenticator app")} className="size-44 rounded-control bg-white p-2" />
            <p className="text-center text-caption text-fg-muted">
              {t("Can't scan? Enter this key:")}
              <span className="mt-1 block break-all font-mono text-fg">{enrollment.secret}</span>
            </p>
          </div>
        )}

        {preparing ? (
          <p className="mt-6 text-body text-fg-muted">{t("Loading…")}</p>
        ) : (
          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <div>
              <label htmlFor="mfa-code" className="mb-1.5 block text-caption font-medium text-fg-muted">
                {t("6-digit code")}
              </label>
              <input
                id="mfa-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                className="w-full rounded-control border border-border bg-surface-muted px-3 py-2 text-center font-mono text-h2 tracking-[0.4em] text-fg outline-none focus-visible:border-accent"
              />
            </div>

            {error && <p className="text-caption text-destructive">{error}</p>}

            <button
              type="submit"
              disabled={submitting || !factorId || code.length !== 6}
              className="w-full cursor-pointer rounded-control bg-accent px-4 py-2.5 text-body font-semibold text-bg transition hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? t("Checking…") : t("Verify")}
            </button>
          </form>
        )}

        <button
          type="button"
          onClick={() => supabase.auth.signOut()}
          className="mt-4 w-full cursor-pointer text-caption font-medium text-fg-muted transition hover:text-fg"
        >
          {t("Log out")}
        </button>
      </div>
    </div>
  );
}
