import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, Coins, GraduationCap, Sparkle } from "@phosphor-icons/react";
import { Modal, ModalCloseButton } from "./ui/Modal";
import { Button } from "./ui/Button";
import type { BalanceOption, BalanceSource } from "../lib/store";
import { cn } from "../lib/cn";
import { t, tn } from "../lib/i18n";

const BALANCE_ICON: Record<BalanceSource, typeof GraduationCap> = {
  plan: GraduationCap,
  standard: Coins,
  premium: Sparkle,
};

/** What spending from each balance means for the document being checked
 * (backend/api/usage.py credit_tier: a credit unlocks its tier). */
function unlockNote(source: BalanceSource): string {
  if (source === "standard") return t("This document gets Standard features.");
  if (source === "premium") return t("This document gets Premium features.");
  return t("This document gets your plan's features.");
}

interface BalancePickerDialogProps {
  open: boolean;
  onClose: () => void;
  /** Balances with checks left; the dialog is only opened with 2 or more. */
  balances: BalanceOption[];
  onConfirm: (source: BalanceSource) => void;
  /** Disables Confirm while the submission is in flight. */
  busy?: boolean;
  /** Extra context on both steps, e.g. a re-check's change summary. */
  summary?: ReactNode;
  confirmLabel?: string;
}

/**
 * "Which balance should we use?" in two steps inside one modal: pick a
 * balance, then confirm it. Picking alone never spends anything, so a
 * misclick can't use a Premium credit; Back keeps the choice, closing
 * cancels.
 */
export function BalancePickerDialog({
  open,
  onClose,
  balances,
  onConfirm,
  busy = false,
  summary,
  confirmLabel,
}: BalancePickerDialogProps) {
  const [chosen, setChosen] = useState<BalanceSource | null>(null);
  const [step, setStep] = useState<"pick" | "confirm">("pick");

  // Every opening starts on the list, with nothing chosen yet.
  useEffect(() => {
    if (open) {
      setChosen(null);
      setStep("pick");
    }
  }, [open]);

  const choice = balances.find((b) => b.source === chosen) ?? null;

  return (
    <Modal open={open} onClose={onClose} maxWidth="max-w-md" labelledBy="balance-dialog-title">
      <div className="relative p-6">
        <ModalCloseButton onClose={onClose} />
        {step === "pick" || !choice ? (
          <>
            <h2 id="balance-dialog-title" className="text-h3 font-bold text-navy-900">
              {t("Which balance should we use?")}
            </h2>
            <p className="mt-1.5 text-sm text-ink-500">
              {t("You have credits available in more than one place. Pick which one this check should spend.")}
            </p>
            {summary && <div className="mt-4">{summary}</div>}
            <div className="mt-5 flex flex-col gap-2.5" role="radiogroup" aria-labelledby="balance-dialog-title">
              {balances.map((b) => {
                const Icon = BALANCE_ICON[b.source];
                const selected = b.source === chosen;
                return (
                  <button
                    key={b.source}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => {
                      setChosen(b.source);
                      setStep("confirm");
                    }}
                    className={cn(
                      "studio-card flex items-center justify-between gap-3 rounded-[var(--radius-card)] border bg-white px-4 py-3.5 text-left transition-colors hover:border-brand-400 hover:bg-brand-100/30",
                      selected ? "border-brand-400" : "border-line",
                    )}
                  >
                    <span className="flex items-center gap-3">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-100 text-brand-600">
                        <Icon size={18} weight="bold" />
                      </span>
                      <span>
                        <span className="block text-sm font-semibold text-navy-900">{t(b.label)}</span>
                        <span className="block text-xs text-ink-500">
                          {tn(b.remaining, "{{count}} check remaining", "{{count}} checks remaining")}
                        </span>
                      </span>
                    </span>
                    <span
                      className={cn(
                        "size-2.5 shrink-0 rounded-full border-2",
                        selected ? "border-brand-600 bg-brand-600" : "border-line",
                      )}
                    />
                  </button>
                );
              })}
            </div>
          </>
        ) : (
          <>
            <h2 id="balance-dialog-title" className="text-h3 font-bold text-navy-900">
              {t("Use 1 check from {{balance}}?", { balance: t(choice.label) })}
            </h2>
            <p className="mt-1.5 text-sm text-ink-500">
              {tn(choice.remaining - 1, "{{count}} check left after this one.", "{{count}} checks left after this one.")}{" "}
              {unlockNote(choice.source)}
            </p>
            {summary && <div className="mt-4">{summary}</div>}
            <div className="mt-6 flex items-center justify-between gap-3">
              <Button variant="ghost" size="sm" onClick={() => setStep("pick")} disabled={busy}>
                <ArrowLeft size={14} weight="bold" />
                {t("Back")}
              </Button>
              <Button size="sm" onClick={() => onConfirm(choice.source)} disabled={busy}>
                {confirmLabel ?? t("Confirm & check")}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
