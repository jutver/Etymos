import { useEffect, useState } from "react";
import { EnvelopeSimple, UserCircleDashed } from "@phosphor-icons/react";
import { Switch } from "../../components/Switch";
import { listFeatureFlags, setFeatureFlagEnabled } from "../../lib/configQueries";
import { useAdminAuth } from "../../lib/auth";
import { friendlyError } from "../../lib/errors";
import { t, tr } from "../../lib/i18n";

/** feature_flags rows from 20261029020000_support_intake.sql; the backend
 * reads them when a request comes in. Off only stops new requests. */
const SWITCHES = [
  {
    key: "support_guest_requests",
    icon: UserCircleDashed,
    label: tr("Requests from signed-out visitors"),
    on: tr("On: anyone can open a request from the Contact page."),
    off: tr("Off: the Contact page asks people to sign in first."),
  },
  {
    key: "support_email_requests",
    icon: EnvelopeSimple,
    label: tr("Requests by email"),
    on: tr("On: a new email to the support address opens a request."),
    off: tr("Off: new emails are dropped. Replies to existing requests still arrive."),
  },
] as const;

type Key = (typeof SWITCHES)[number]["key"];

export function IntakeSwitches() {
  const { user } = useAdminAuth();
  const [state, setState] = useState<Partial<Record<Key, boolean>> | null>(null);
  const [pending, setPending] = useState<Key | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listFeatureFlags()
      .then((flags) => {
        const next: Partial<Record<Key, boolean>> = {};
        for (const s of SWITCHES) {
          const flag = flags.find((f) => f.key === s.key);
          if (flag) next[s.key] = flag.enabled;
        }
        setState(next);
      })
      .catch((err: unknown) => setError(friendlyError(err)));
  }, []);

  async function toggle(key: Key, enabled: boolean) {
    if (!user) return;
    setPending(key);
    setError(null);
    try {
      await setFeatureFlagEnabled(key, enabled, user.id);
      setState((s) => ({ ...s, [key]: enabled }));
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="mt-5 rounded-card border border-border bg-surface shadow-card">
      <div className="grid divide-y divide-border md:grid-cols-2 md:divide-x md:divide-y-0">
        {SWITCHES.map((s) => {
          const value = state?.[s.key];
          const missing = state !== null && value === undefined;
          const Icon = s.icon;
          return (
            <div key={s.key} className="flex items-center justify-between gap-4 px-5 py-4">
              <div className="flex min-w-0 items-start gap-3">
                <Icon size={18} weight="bold" className="mt-0.5 shrink-0 text-fg-muted" />
                <div className="min-w-0">
                  <p className="text-body font-medium text-fg">{t(s.label)}</p>
                  <p className="mt-0.5 text-caption text-fg-muted">
                    {missing ? t("Not set up yet: apply the support intake migration.") : t(value === false ? s.off : s.on)}
                  </p>
                </div>
              </div>
              <Switch
                checked={value ?? true}
                disabled={state === null || missing || pending !== null}
                onChange={(next) => toggle(s.key, next)}
              />
            </div>
          );
        })}
      </div>
      {error && <p className="border-t border-border px-5 py-2.5 text-caption text-destructive">{error}</p>}
    </div>
  );
}
