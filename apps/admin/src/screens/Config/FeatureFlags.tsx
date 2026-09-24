import { useEffect, useState } from "react";
import { Switch } from "../../components/Switch";
import { useAdminAuth } from "../../lib/auth";
import { listFeatureFlags, setFeatureFlagEnabled } from "../../lib/configQueries";
import type { FeatureFlag } from "../../lib/types";
import { friendlyError } from "../../lib/errors";
import { t, tr } from "../../lib/i18n";

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
    label: tr("Use Gemini for metadata extraction"),
    hint: tr("Off = local Qwen2.5 model on the VPS GPU."),
  },
  {
    key: "gemini_ai_rewrite",
    label: tr("Use Gemini for AI rewrite"),
    hint: tr("Off = local Qwen2.5 model on the VPS GPU."),
  },
  {
    key: "gemini_ai_explanations",
    label: tr("Use Gemini for AI explanations"),
    hint: tr("Off = local Qwen2.5 model on the VPS GPU."),
  },
  {
    key: "ai_content_detection",
    label: tr("AI-generated content detection"),
    hint: tr("On = every checked document is scored for machine-written text (uses the local GPU model)."),
  },
  {
    key: "ai_match_explanations",
    label: tr("AI polish for match explanations (experimental)"),
    hint: tr("Off = fact-based explanations only (recommended with the local model)."),
  },
];

/** English descriptions the backend writes into `feature_flags.description`
 * (backend/ai_rewrite.py, ai_explain.py, report_enrichment.py), kept verbatim
 * only so they can be translated where the flag list renders them. */
export const KNOWN_FLAG_DESCRIPTIONS = [
  tr("When enabled, /api/ai/rewrite calls the Gemini API instead of the local Qwen2.5 model. Defaults off: the VPS has a GPU, so the local model runs at no per-call cost. Mirrors the gemini_metadata_extraction flag."),
  tr("When enabled, the LLM polish step of the 'why is this flagged' explanations uses the Gemini API instead of the local Qwen2.5 model. Defaults off: the local model costs nothing per call. Either way a failure falls back to the other provider and then to the fact-based explanation, which is always present."),
  tr("Score each paragraph of a checked document for signs of machine-written text and show the result on the report. Uses the local language model on the GPU; turn off if checks become too slow."),
  tr("Every match always gets a fact-based 'why is this flagged' explanation. When on, an LLM also rewrites the most serious ones more fluently (validated against the facts; a bad answer is discarded). Off by default: with the small local Qwen model the polished text was vaguer than the fact-based one and ~4s slower per match. Worth trying with Gemini."),
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

  if (loading) return <p className="text-body text-fg-muted">{t("Loading…")}</p>;
  if (error) return <p className="text-body text-destructive">{error}</p>;

  const missingBackendFlags = BACKEND_FLAGS.filter(
    (known) => !flags.some((flag) => flag.key === known.key),
  );

  return (
    <div className="space-y-4">
      {flags.length === 0 ? (
        <div className="rounded-card border border-border bg-surface p-6 text-body text-fg-subtle">
          {t("No feature flags yet. Insert rows into")}{" "}<code className="font-mono">{t("feature_flags")}</code> {" "}{t("to manage them here.")}</div>
      ) : (
        <div className="divide-y divide-border rounded-card border border-border bg-surface shadow-card">
          {flags.map((flag) => (
            <div key={flag.key} className="flex items-center justify-between px-5 py-4">
              <div>
                <p className="text-body font-medium text-fg">{t(flag.label)}</p>
                {flag.description && <p className="mt-0.5 text-caption text-fg-muted">{t(flag.description)}</p>}
              </div>
              <Switch checked={flag.enabled} onChange={(enabled) => toggle(flag, enabled)} />
            </div>
          ))}
        </div>
      )}

      {missingBackendFlags.length > 0 && (
        <div className="rounded-card border border-border bg-surface p-5">
          <p className="text-body font-medium text-fg">{t("Not registered yet")}</p>
          <p className="mt-0.5 text-caption text-fg-muted">
            {t("The Python backend registers these on startup. If they stay here, the backend hasn’t been redeployed yet or can’t reach Supabase. Until then each one uses its default (off).")}</p>
          <ul className="mt-3 space-y-2">
            {missingBackendFlags.map((flag) => (
              <li key={flag.key} className="text-caption text-fg-subtle">
                <code className="font-mono text-fg">{flag.key}</code> — {t(flag.label)}. {t(flag.hint)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
