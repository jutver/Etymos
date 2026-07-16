import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Envelope, LockKey, WarningCircle } from "@phosphor-icons/react";
import { Button } from "../../components/ui/Button";
import { supabase } from "@etymos/shared";

export default function SignupPage() {
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const { data, error: signUpError } = await supabase.auth.signUp({ email, password });

    if (signUpError) {
      setError(signUpError.message);
      setLoading(false);
      return;
    }

    setLoading(false);

    if (data.session) {
      // Email confirmation disabled — user is signed in immediately
      navigate("/upload", { replace: true });
    } else {
      // Email confirmation required — redirect to verification page
      navigate("/verify-email", { replace: true, state: { email } });
    }
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
      <h1 className="text-h3 font-bold tracking-tight text-navy-900">Create your account</h1>
      <p className="mt-1.5 text-sm text-ink-500">
        Start with 3 free checks a month. No card required.
      </p>

      {error && (
        <div className="mt-5 flex items-start gap-2.5 rounded-[var(--radius-control)] border border-severity-high-line bg-severity-high-bg px-4 py-3 text-sm text-severity-high">
          <WarningCircle size={18} weight="fill" className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-ink-700">Email</span>
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
          <span className="text-xs font-semibold text-ink-700">Password</span>
          <div className="relative">
            <LockKey size={17} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-300" />
            <input
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 6 characters"
              className="w-full rounded-[var(--radius-control)] border border-line bg-white py-2.5 pl-10 pr-4 text-sm placeholder:text-ink-300 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-200"
            />
          </div>
        </label>

        <Button type="submit" size="lg" loading={loading} fullWidth className="mt-1">
          Create account
        </Button>
      </form>

      <div className="my-5 flex items-center gap-3">
        <div className="h-px flex-1 bg-line" />
        <span className="text-xs font-medium text-ink-400">or</span>
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
        Continue with Google
      </Button>

      <p className="mt-6 text-center text-sm text-ink-600">
        Already have an account?{" "}
        <Link to="/login" className="font-semibold text-brand-600 hover:underline">
          Log in
        </Link>
      </p>
    </div>
  );
}

