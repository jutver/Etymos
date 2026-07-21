import { useEffect, useState } from "react";
import { Switch } from "../../components/Switch";
import { useAdminAuth } from "../../lib/auth";
import { listFeatureFlags, setFeatureFlagEnabled } from "../../lib/configQueries";
import type { FeatureFlag } from "../../lib/types";
import { friendlyError } from "../../lib/errors";

/**
 * Flags the Python backend reads at runtime. The backend upserts these
 * rows itself on startup (see backend/feature_flags.ensure_flag_registered),
 * so they normally arrive here on their own. This list only exists so an
 * admin can tell "the flag is off" apart from "the backend hasn't
 * registered it yet" — e.g. before the first deploy of a new flag, or
 * when the backend can't reach Supabase.
 */
const BACKEND_FLAGS: { key: string; label: string; hint: string }[] = [
  {
    key: "gemini_metadata_extraction",
    label: "Use Gemini for metadata extraction",
    hint: "Off = local Qwen2.5 model on the VPS GPU.",
  },
  {
    key: "gemini_ai_rewrite",
    label: "Use Gemini for AI rewrite",
    hint: "Off = local Qwen2.5 model on the VPS GPU.",
  },
];

export default function FeatureFlagsPage() {
  const { user } = useAdminAuth();
  const [flags, setFlags] = useState<FeatureFlag[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listFeatureFlags()
      .then(setFlags)
      .catch((err: unknown) => setError(friendlyError(err)))
      .finally(() => setLoading(false));
  }, []);

  async function toggle(flag: FeatureFlag, enabled: boolean) {
    if (!user) return;
    setFlags((prev) => prev.map((f) => (f.key === flag.key ? { ...f, enabled } : f)));
    try {
      await setFeatureFlagEnabled(flag.key, enabled, user.id);
    } catch (err) {
      setError(friendlyError(err));
      setFlags((prev) => prev.map((f) => (f.key === flag.key ? { ...f, enabled: !enabled } : f)));
    }
  }

  if (loading) return <p className="text-body text-fg-muted">Loading…</p>;
  if (error) return <p className="text-body text-destructive">{error}</p>;

  const missingBackendFlags = BACKEND_FLAGS.filter(
    (known) => !flags.some((flag) => flag.key === known.key),
  );

  return (
    <div className="space-y-4">
      {flags.length === 0 ? (
        <div className="rounded-card border border-border bg-surface p-6 text-body text-fg-subtle">
          No feature flags yet. Insert rows into <code className="font-mono">feature_flags</code> to manage them here.
        </div>
      ) : (
        <div className="divide-y divide-border rounded-card border border-border bg-surface shadow-card">
          {flags.map((flag) => (
            <div key={flag.key} className="flex items-center justify-between px-5 py-4">
              <div>
                <p className="text-body font-medium text-fg">{flag.label}</p>
                {flag.description && <p className="mt-0.5 text-caption text-fg-muted">{flag.description}</p>}
              </div>
              <Switch checked={flag.enabled} onChange={(enabled) => toggle(flag, enabled)} />
            </div>
          ))}
        </div>
      )}

      {missingBackendFlags.length > 0 && (
        <div className="rounded-card border border-border bg-surface p-5">
          <p className="text-body font-medium text-fg">Not registered yet</p>
          <p className="mt-0.5 text-caption text-fg-muted">
            The Python backend registers these on startup. If they stay here, the backend hasn’t been
            redeployed yet or can’t reach Supabase. Until then each one uses its default (off).
          </p>
          <ul className="mt-3 space-y-2">
            {missingBackendFlags.map((flag) => (
              <li key={flag.key} className="text-caption text-fg-subtle">
                <code className="font-mono text-fg">{flag.key}</code> — {flag.label}. {flag.hint}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
