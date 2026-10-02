import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Eye, EyeSlash, LockKey, WarningCircle } from "@phosphor-icons/react";
import { supabase } from "@etymos/shared";
import { Button } from "../../components/ui/Button";
import { PageLoader } from "../../components/ui/PageLoader";
import { AuthResultCard } from "../../components/auth/AuthResultCard";
import { initialAuthRedirect, useAuth } from "../../lib/auth";
import { t } from "../../lib/i18n";

const MIN_PASSWORD_LENGTH = 6;

/**
 * Landing page for password-reset links — from Supabase's own email (login
 * address) or the backend's (confirmed recovery address); both are Supabase
 * recovery links redirecting here.
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

function NewPasswordForm({ email, onDone }: { email: string; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError(t("Passwords don't match."));
      return;
    }

    setSaving(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) {
      setSaving(false);
      setError(
        updateError.code === "same_password"
          ? t("Choose a password you haven't used for this account before.")
          : updateError.code === "weak_password"
            ? t("This password is too weak. Try a longer one.")
            : updateError.message,
      );
      return;
    }
    // Show the success state first: signing out empties the auth context,
    // which would otherwise flash the "link can't be used" state.
    onDone();
    // Ends the recovery session and any other session on any device, so
    // whoever triggered the reset (or stole the old password) is logged out.
    await supabase.auth.signOut({ scope: "global" });
  }

  return (
    <div className="rounded-[var(--radius-card-lg)] border border-line bg-white p-7 shadow-[var(--shadow-card)] sm:p-8">
      <h1 className="text-h3 font-bold tracking-tight text-navy-900">{t("Choose a new password")}</h1>
      <p className="mt-1.5 text-sm text-ink-500">
        {email ? t("For {{email}}.", { email }) : null} {t("You'll be signed out on every device afterwards.")}
      </p>

      {error && (
        <div className="mt-5 flex items-start gap-2.5 rounded-[var(--radius-control)] border border-severity-high-line bg-severity-high-bg px-4 py-3 text-sm text-severity-high">
          <WarningCircle size={18} weight="fill" className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
        <PasswordField
          label={t("New password")}
          value={password}
          onChange={setPassword}
          placeholder={t("At least 6 characters")}
          autoFocus
        />
        <PasswordField
          label={t("Confirm new password")}
          value={confirm}
          onChange={setConfirm}
          placeholder={t("Re-enter your password")}
        />
        <Button type="submit" size="lg" loading={saving} fullWidth className="mt-1">
          {t("Update password")}
        </Button>
      </form>
    </div>
  );
}

function PasswordField({
  label,
  value,
  onChange,
  placeholder,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  autoFocus?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-semibold text-ink-700">{label}</span>
      <div className="relative">
        <LockKey size={17} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-300" />
        <input
          type={visible ? "text" : "password"}
          required
          minLength={MIN_PASSWORD_LENGTH}
          autoComplete="new-password"
          autoFocus={autoFocus}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full rounded-[var(--radius-control)] border border-line bg-white py-2.5 pl-10 pr-10 text-sm placeholder:text-ink-300 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-200"
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? t("Hide password") : t("Show password")}
          className="absolute right-3.5 top-1/2 -translate-y-1/2 text-ink-300 hover:text-ink-500"
        >
          {visible ? <EyeSlash size={17} /> : <Eye size={17} />}
        </button>
      </div>
    </label>
  );
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
