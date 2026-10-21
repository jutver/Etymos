import { useNavigate } from "react-router-dom";
import { ArrowsClockwise } from "@phosphor-icons/react";
import { Modal, ModalCloseButton } from "../../components/ui/Modal";
import { Button } from "../../components/ui/Button";
import { BalancePickerDialog } from "../../components/BalancePickerDialog";
import type { RecheckQuote } from "../../lib/api";
import type { BalanceOption, BalanceSource } from "../../lib/store";
import { paywallPath } from "../../lib/paywall";
import { t } from "../../lib/i18n";
import { recheckCostReason, recheckSummary } from "./recheck";

interface RecheckDialogProps {
  open: boolean;
  onClose: () => void;
  /** null while the quote is loading. */
  quote: RecheckQuote | null;
  /** Balances with checks left. */
  balances: BalanceOption[];
  busy: boolean;
  /** `source` is set only when the re-check uses a check. */
  onConfirm: (source?: BalanceSource) => void;
}

function Summary({ quote }: { quote: RecheckQuote }) {
  const reason = recheckCostReason(quote);
  return (
    <div className="rounded-[var(--radius-card)] border border-line bg-surface-muted px-3.5 py-3 text-sm">
      <p className="font-semibold text-navy-900">{recheckSummary(quote)}</p>
      {reason && <p className="mt-1 text-xs text-ink-500">{reason}</p>}
    </div>
  );
}

/**
 * The Save & re-check confirmation. A free re-check is one click; one that
 * uses a check goes through the shared pick-then-confirm balance dialog when
 * there is more than one balance to spend from.
 */
export function RecheckDialog({ open, onClose, quote, balances, busy, onConfirm }: RecheckDialogProps) {
  const navigate = useNavigate();

  if (quote && quote.cost === "check" && balances.length >= 2) {
    return (
      <BalancePickerDialog
        open={open}
        onClose={onClose}
        balances={balances}
        onConfirm={onConfirm}
        busy={busy}
        summary={<Summary quote={quote} />}
        confirmLabel={t("Confirm & re-check")}
      />
    );
  }

  const only = balances[0];

  return (
    <Modal open={open} onClose={onClose} maxWidth="max-w-md" labelledBy="recheck-dialog-title">
      <div className="relative p-6">
        <ModalCloseButton onClose={onClose} />
        <h2 id="recheck-dialog-title" className="text-h3 font-bold text-navy-900">
          {t("Re-check your edits?")}
        </h2>
        <p className="mt-1.5 text-sm text-ink-500">
          {t("We save this version, then check only the paragraphs you changed. The rest keep their results.")}
        </p>

        <div className="mt-4">
          {quote ? (
            <Summary quote={quote} />
          ) : (
            <p className="flex items-center gap-2 text-sm text-ink-500" role="status">
              <span aria-hidden="true" className="size-3 animate-spin motion-reduce:animate-none rounded-full border-2 border-current border-t-transparent" />
              {t("Working out what changed…")}
            </p>
          )}
        </div>

        {quote?.cost === "check" && only && (
          <p className="mt-3 text-sm text-ink-700">
            {t("This uses 1 check from {{balance}}.", { balance: t(only.label) })}
          </p>
        )}
        {quote?.cost === "check" && !only && (
          <p className="mt-3 text-sm text-ink-700">{t("You have no checks left for this re-check.")}</p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            {t("Cancel")}
          </Button>
          {quote?.cost === "check" && !only ? (
            <Button size="sm" onClick={() => navigate(paywallPath("checks"))}>
              {t("Get more checks")}
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={!quote || busy}
              loading={busy}
              iconLeft={<ArrowsClockwise size={15} weight="bold" />}
              onClick={() => onConfirm(quote?.cost === "check" ? only?.source : undefined)}
            >
              {quote?.cost === "check" ? t("Confirm & re-check") : t("Re-check for free")}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
