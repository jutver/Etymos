import { useState, type FormEvent } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { supabase } from "@etymos/shared";
import { useAdminAuth } from "../../lib/auth";

export default function LoginPage() {
  const { user, loading } = useAdminAuth();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);

  if (!loading && user) {
    const from = (location.state as { from?: Location } | null)?.from;
    return <Navigate to={from?.pathname ?? "/"} replace />;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    setSubmitting(false);
    if (signInError) setError(signInError.message);
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
    if (oauthError) setError(oauthError.message);
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg px-6">
      <div className="w-full max-w-sm rounded-card border border-border bg-surface p-8 shadow-card">
        <div className="mb-6 flex items-center gap-2">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-control bg-accent/15 font-mono text-sm font-semibold text-accent">
            E
          </div>
          <span className="font-mono text-sm font-semibold tracking-tight text-fg">
            Etymos Admin
          </span>
        </div>

        <h1 className="text-h1 font-semibold text-fg">Sign in</h1>
        <p className="mt-1 text-body text-fg-muted">Admin access only.</p>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <div>
            <label htmlFor="email" className="mb-1.5 block text-caption font-medium text-fg-muted">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-control border border-border bg-surface-muted px-3 py-2 text-body text-fg outline-none focus-visible:border-accent"
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label htmlFor="password" className="mb-1.5 block text-caption font-medium text-fg-muted">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-control border border-border bg-surface-muted px-3 py-2 text-body text-fg outline-none focus-visible:border-accent"
              placeholder="Your password"
            />
          </div>

          {error && <p className="text-caption text-destructive">{error}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="w-full cursor-pointer rounded-control bg-accent px-4 py-2.5 text-body font-semibold text-bg transition hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? "Signing in…" : "Log in"}
          </button>
        </form>

        <div className="my-5 flex items-center gap-3">
          <div className="h-px flex-1 bg-border" />
          <span className="text-caption font-medium text-fg-subtle">or</span>
          <div className="h-px flex-1 bg-border" />
        </div>

        <button
          type="button"
          disabled={googleLoading}
          onClick={handleGoogleOAuth}
          className="flex w-full cursor-pointer items-center justify-center gap-2.5 rounded-control border border-border bg-surface px-4 py-2.5 text-body font-semibold text-fg transition hover:bg-surface-raised active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
        >
          <img src="/assets/logo/google.png" alt="" className="size-[18px] object-contain" />
          {googleLoading ? "Connecting…" : "Continue with Google"}
        </button>
      </div>
    </div>
  );
}
