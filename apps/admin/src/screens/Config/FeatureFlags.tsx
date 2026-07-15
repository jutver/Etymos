import { useEffect, useState } from "react";
import { Switch } from "../../components/Switch";
import { useAdminAuth } from "../../lib/auth";
import { listFeatureFlags, setFeatureFlagEnabled } from "../../lib/configQueries";
import type { FeatureFlag } from "../../lib/types";

export default function FeatureFlagsPage() {
  const { user } = useAdminAuth();
  const [flags, setFlags] = useState<FeatureFlag[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listFeatureFlags()
      .then(setFlags)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  async function toggle(flag: FeatureFlag, enabled: boolean) {
    if (!user) return;
    setFlags((prev) => prev.map((f) => (f.key === flag.key ? { ...f, enabled } : f)));
    try {
      await setFeatureFlagEnabled(flag.key, enabled, user.id);
    } catch (err) {
      setError((err as Error).message);
      setFlags((prev) => prev.map((f) => (f.key === flag.key ? { ...f, enabled: !enabled } : f)));
    }
  }

  if (loading) return <p className="text-body text-fg-muted">Loading…</p>;
  if (error) return <p className="text-body text-destructive">{error}</p>;

  if (flags.length === 0) {
    return (
      <div className="rounded-card border border-border bg-surface p-6 text-body text-fg-subtle">
        No feature flags yet. Insert rows into <code className="font-mono">feature_flags</code> to manage them here.
      </div>
    );
  }

  return (
    <div className="divide-y divide-border rounded-card border border-border bg-surface">
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
  );
}
