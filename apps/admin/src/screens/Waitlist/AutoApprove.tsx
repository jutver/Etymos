import { useEffect, useState } from "react";
import { X } from "@phosphor-icons/react";
import { Switch } from "../../components/Switch";
import { countWaitlisted, getAutoApprove, setAutoApprove } from "../../lib/waitlistQueries";
import { friendlyError } from "../../lib/errors";
import { t, tn } from "../../lib/i18n";

interface AutoApproveProps {
  /** Called after turning it on approved people who were waiting. */
  onApproved: () => void;
}

/** The waitlist_auto_approve switch. While on, new sign-ups are approved as
 * soon as their account is created; turning it on also approves everyone
 * already waiting, so it asks first when anyone is. */
export function AutoApprove({ onApproved }: AutoApproveProps) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [confirmCount, setConfirmCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAutoApprove()
      .then(setEnabled)
      .catch((err: unknown) => setError(friendlyError(err)));
  }, []);

  async function apply(next: boolean) {
    setPending(true);
    setError(null);
    try {
      const approved = await setAutoApprove(next);
      setEnabled(next);
      setConfirmCount(null);
      if (approved > 0) onApproved();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setPending(false);
    }
  }

  async function toggle(next: boolean) {
    if (!next) return apply(false);
    setPending(true);
    setError(null);
    try {
      const waiting = await countWaitlisted();
      setPending(false);
      if (waiting > 0) setConfirmCount(waiting);
      else await apply(true);
    } catch (err) {
      setError(friendlyError(err));
      setPending(false);
    }
  }

  return (
    <>
      <div className="mb-5 flex items-center justify-between gap-4 rounded-card border border-border bg-surface px-5 py-4 shadow-card">
        <div>
          <p className="text-body font-medium text-fg">{t("Auto-approve new sign-ups")}</p>
          <p className="mt-0.5 text-caption text-fg-muted">
            {enabled
              ? t("On: new accounts can use the app right away.")
              : t("Off: new accounts wait here until an admin approves them.")}
          </p>
          {error && <p className="mt-1 text-caption text-destructive">{error}</p>}
        </div>
        <Switch checked={enabled ?? false} disabled={enabled === null || pending} onChange={toggle} />
      </div>

      {confirmCount !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={() => setConfirmCount(null)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t("Turn on auto-approve?")}
            className="w-full max-w-md overflow-hidden rounded-card border border-border bg-surface shadow-pop"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
              <p className="text-body font-medium text-fg">{t("Turn on auto-approve?")}</p>
              <button
                type="button"
                onClick={() => setConfirmCount(null)}
                title={t("Close")}
                className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-control text-fg-muted transition hover:bg-surface-raised active:scale-95"
              >
                <X size={16} weight="bold" />
              </button>
            </div>

            <div className="p-5">
              <p className="text-caption text-fg-muted">
                {tn(
                  confirmCount,
                  "New sign-ups will be approved automatically, and the {{count}} person waiting now will be approved too.",
                  "New sign-ups will be approved automatically, and the {{count}} people waiting now will be approved too.",
                )}
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmCount(null)}
                  className="cursor-pointer rounded-control border border-border px-3 py-1.5 text-caption font-medium text-fg-muted transition hover:bg-surface-raised active:scale-95"
                >
                  {t("Cancel")}</button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => apply(true)}
                  className="cursor-pointer rounded-control border border-success/40 bg-success-bg px-3 py-1.5 text-caption font-medium text-success transition hover:opacity-90 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {t("Turn on and approve all")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
