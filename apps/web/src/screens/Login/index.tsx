import { useState } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { Envelope, Eye, EyeSlash, LockKey, WarningCircle } from "@phosphor-icons/react";
import { Button } from "../../components/ui/Button";
import { supabase } from "@etymos/shared";
import { t } from "../../lib/i18n";

interface LocationState {
  from?: { pathname: string };
}

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as LocationState)?.from?.pathname ?? "/upload";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });

    setLoading(false);
    if (signInError) {
      setError(signInError.message);
      return;
    }
    navigate(from, { replace: true });
  }

  async function handleGoogleOAuth() {
    setError(null);
    setGoogleLoading(true);

    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    setGoogleLoading(false);
    if (oauthError) {
      setError(oauthError.message);
    }
  }

  return (
    <div className="rounded-[var(--radius-card-lg)] border border-line bg-white p-7 shadow-[var(--shadow-card)] sm:p-8">
      <h1 className="text-h3 font-bold tracking-tight text-navy-900">{t("Welcome back")}</h1>
      <p className="mt-1.5 text-sm text-ink-500">{t("Log in to continue to your Etymos account.")}</p>

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
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full rounded-[var(--radius-control)] border border-line bg-white py-2.5 pl-10 pr-4 text-sm placeholder:text-ink-300 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-200"
            />
          </div>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="flex items-baseline justify-between gap-3">
            <span className="text-xs font-semibold text-ink-700">{t("Password")}</span>
            <Link
              to="/forgot-password"
              state={{ email }}
              className="text-xs font-semibold text-brand-600 hover:underline"
            >
              {t("Forgot password?")}
            </Link>
          </span>
          <div className="relative">
            <LockKey size={17} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-300" />
            <input
              type={showPassword ? "text" : "password"}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("Your password")}
              className="w-full rounded-[var(--radius-control)] border border-line bg-white py-2.5 pl-10 pr-10 text-sm placeholder:text-ink-300 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-200"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? t("Hide password") : t("Show password")}
              className="absolute right-3.5 top-1/2 -translate-y-1/2 text-ink-300 hover:text-ink-500"
            >
              {showPassword ? <EyeSlash size={17} /> : <Eye size={17} />}
            </button>
          </div>
        </label>

        <Button type="submit" size="lg" loading={loading} fullWidth className="mt-1">
          {t("Log in")}</Button>
      </form>

      <div className="my-5 flex items-center gap-3">
        <div className="h-px flex-1 bg-line" />
        <span className="text-xs font-medium text-ink-400">{t("or")}</span>
        <div className="h-px flex-1 bg-line" />
      </div>

      <Button
        variant="outline"
        size="lg"
        fullWidth
        loading={googleLoading}
        onClick={handleGoogleOAuth}
        iconLeft={<img src="/assets/logo/google.png" alt="" className="size-[18px] object-contain" />}
      >
        {t("Continue with Google")}</Button>

      <p className="mt-6 text-center text-sm text-ink-600">
        {t("New to Etymos?")}{" "}
        <Link to="/signup" className="font-semibold text-brand-600 hover:underline">
          {t("Create an account")}</Link>
      </p>
    </div>
  );
}

