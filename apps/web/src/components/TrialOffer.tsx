// The free 7-day Standard trial, offered where a Free user meets a paid
// feature: My Plan, the Standard plan card, the paywall and the tour's last
// step. Starting it always goes through TrialDialog, which says what happens
// when the 7 days are up.
import { useCallback, useState } from "react";
import { Check, Gift } from "@phosphor-icons/react";
import { Button } from "./ui/Button";
import { Modal, ModalCloseButton } from "./ui/Modal";
import { useAppStore } from "../lib/store";
import { canOfferTrial, startTrial, TRIAL_DAYS } from "../lib/trial";
import { currentLocale, t, tr } from "../lib/i18n";
import { cn } from "@etymos/shared";

const TRIAL_FEATURES = [
  tr("Semantic (paraphrase) detection"),
  tr("AI-generated content detection"),
  tr("Explanations for every match"),
  tr("PDF report export"),
];

/** Whether the signed-in user can be offered the trial right now. */
export function useTrialOffer(): boolean {
  return useAppStore((s) => canOfferTrial(s));
}

/** Starts the trial, refreshes the plan everywhere and says so. */
export function useStartTrial() {
  const refreshBalances = useAppStore((s) => s.refreshBalances);
  const pushToast = useAppStore((s) => s.pushToast);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const ends = await startTrial();
      await refreshBalances();
      pushToast({
        kind: "success",
        title: tr("Your Standard trial has started"),
        description: t("Enjoy every Standard feature until {{date}}.", {
          date: new Date(ends).toLocaleDateString(currentLocale(), { dateStyle: "long" }),
        }),
      });
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : tr("Couldn't start your trial. Please try again."));
      return false;
    } finally {
      setBusy(false);
    }
  }, [refreshBalances, pushToast]);

  return { start, busy, error };
}

/** Confirms the trial before starting it. */
export function TrialDialog({ open, onClose, onStarted }: { open: boolean; onClose: () => void; onStarted?: () => void }) {
  const { start, busy, error } = useStartTrial();

  async function handleStart() {
    if (await start()) {
      onClose();
      onStarted?.();
    }
  }

  return (
    <Modal open={open} onClose={busy ? () => {} : onClose} maxWidth="max-w-md" labelledBy="trial-dialog-title">
      <ModalCloseButton onClose={onClose} />
      <div className="p-7">
        <div className="flex size-12 items-center justify-center rounded-full bg-brand-100 text-brand-600">
          <Gift size={24} weight="fill" />
        </div>
        <h2 id="trial-dialog-title" className="mt-4 text-h3 font-bold text-navy-900">
          {t("Try Standard free for {{days}} days", { days: TRIAL_DAYS })}
        </h2>
        <p className="mt-2 text-sm text-ink-600">
          {t("Get every Standard feature, with its monthly checks, for {{days}} days. No payment needed.", { days: TRIAL_DAYS })}
        </p>
        <ul className="mt-4 flex flex-col gap-2">
          {TRIAL_FEATURES.map((f) => (
            <li key={f} className="flex items-start gap-2 text-sm text-ink-700">
              <Check size={16} weight="bold" className="mt-0.5 shrink-0 text-brand-500" />
              {t(f)}
            </li>
          ))}
        </ul>
        <p className="mt-4 rounded-[var(--radius-control)] bg-surface-tint px-3.5 py-2.5 text-xs text-ink-600">
          {t("When the trial ends you go back to the Free plan automatically. Nothing is charged, and your documents stay.")}
        </p>
        {error && (
          <p role="alert" className="mt-3 text-sm font-medium text-severity-high">
            {t(error)}
          </p>
        )}
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t("Not now")}
          </Button>
          <Button onClick={() => void handleStart()} loading={busy}>
            {t("Start free trial")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** A card offering the trial; renders nothing when it can't be offered. */
export function TrialOfferCard({ className }: { className?: string }) {
  const eligible = useTrialOffer();
  const [open, setOpen] = useState(false);
  if (!eligible) return null;

  return (
    <section
      className={cn(
        "studio-card flex flex-col gap-4 rounded-[var(--radius-card-lg)] border border-brand-200 bg-brand-100/50 p-6 sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      <div className="flex items-start gap-3.5">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-white text-brand-600 shadow-[var(--shadow-card)]">
          <Gift size={20} weight="fill" />
        </div>
        <div>
          <p className="font-bold text-navy-900">{t("Try Standard free for {{days}} days", { days: TRIAL_DAYS })}</p>
          <p className="mt-0.5 text-sm text-ink-600">
            {t("Paraphrase and AI detection, explanations and PDF export. No payment needed.")}
          </p>
        </div>
      </div>
      <Button className="shrink-0" onClick={() => setOpen(true)}>
        {t("Start free trial")}
      </Button>
      <TrialDialog open={open} onClose={() => setOpen(false)} />
    </section>
  );
}
