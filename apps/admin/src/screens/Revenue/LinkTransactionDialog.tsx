import { useState } from "react";
import { MagnifyingGlass, WarningCircle } from "@phosphor-icons/react";
import { findOrderByCode, linkTransaction, type PaymentTransaction, type RevenueOrder } from "../../lib/revenueQueries";
import { friendlyError } from "../../lib/errors";
import { StatusBadge } from "../../components/StatusBadge";
import { t } from "../../lib/i18n";
import { NoteDialog } from "./NoteDialog";
import { ORDER_STATUS_LABELS, describeItem, formatVND, orderTone } from "./format";

/** Pays an order with a transfer the webhook couldn't match: the admin finds
 * the order by its payment code (from the customer, or the Orders tab). */
export function LinkTransactionDialog({
  transaction,
  onCancel,
  onLinked,
}: {
  transaction: PaymentTransaction;
  onCancel: () => void;
  onLinked: () => void;
}) {
  const [code, setCode] = useState(transaction.payment_code ?? "");
  const [order, setOrder] = useState<RevenueOrder | null>(null);
  const [looking, setLooking] = useState(false);
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function lookUp() {
    setLooking(true);
    setError(null);
    setOrder(null);
    try {
      const found = await findOrderByCode(code);
      if (!found) setError(t("No order has this payment code."));
      setOrder(found);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setLooking(false);
    }
  }

  async function confirm(note: string) {
    if (!order) return;
    setLinking(true);
    setError(null);
    try {
      await linkTransaction(transaction.id, order.id, note);
      onLinked();
    } catch (err) {
      setError(friendlyError(err));
      setLinking(false);
    }
  }

  const alreadyPaid = order?.status === "success";
  const short = order ? Number(transaction.amount) < Number(order.amount ?? 0) : false;

  return (
    <NoteDialog
      title={t("Link transfer to an order")}
      description={t("This {{amount}} transfer will pay the order below, and its plan or credits are granted right away.", {
        amount: formatVND(transaction.amount),
      })}
      placeholder={t("Note (optional), e.g. customer sent proof of payment…")}
      confirmLabel={t("Link and grant")}
      pending={linking}
      confirmDisabled={!order || alreadyPaid}
      onCancel={onCancel}
      onConfirm={(note) => void confirm(note)}
    >
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void lookUp();
        }}
      >
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder={t("Payment code, e.g. ETM7K2QF9XA")}
          className="min-w-0 flex-1 rounded-control border border-border bg-surface-muted px-3 py-2 font-mono text-body text-fg outline-none focus-visible:border-accent"
        />
        <button
          type="submit"
          disabled={!code.trim() || looking}
          className="flex cursor-pointer items-center gap-1.5 rounded-control border border-border px-3 py-1.5 text-caption font-medium text-fg transition hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50"
        >
          <MagnifyingGlass size={14} weight="bold" />
          {looking ? t("Finding…") : t("Find")}
        </button>
      </form>

      {order && (
        <div className="mt-3 rounded-control border border-border bg-surface-muted p-3 text-body">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-fg">{order.profiles?.email ?? order.user_id}</span>
            <StatusBadge label={ORDER_STATUS_LABELS[order.status]} tone={orderTone(order)} />
          </div>
          <p className="mt-1 text-caption text-fg-muted">
            {describeItem(order)} · {formatVND(order.amount)}
          </p>
        </div>
      )}

      {alreadyPaid && <Warning text={t("This order is already paid. Pick another order, or mark the transfer resolved.")} />}
      {short && !alreadyPaid && (
        <Warning
          text={t("The transfer is {{diff}} short of this order. Linking accepts the smaller amount.", {
            diff: formatVND(Number(order?.amount ?? 0) - Number(transaction.amount)),
          })}
        />
      )}
      {error && <Warning text={error} />}
    </NoteDialog>
  );
}

function Warning({ text }: { text: string }) {
  return (
    <p className="mt-3 flex items-start gap-1.5 text-caption text-warning">
      <WarningCircle size={14} weight="fill" className="mt-0.5 shrink-0" />
      {text}
    </p>
  );
}
