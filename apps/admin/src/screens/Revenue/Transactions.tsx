import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { CheckCircle, LinkSimple, MagnifyingGlass } from "@phosphor-icons/react";
import { DataTable, type Column } from "../../components/DataTable";
import { StatusBadge } from "../../components/StatusBadge";
import {
  listTransactions,
  resolveTransaction,
  ATTENTION_STATUSES,
  type PaymentTransaction,
  type TransactionFilter,
} from "../../lib/revenueQueries";
import { PAGE_SIZE } from "../../lib/supabaseQueries";
import { friendlyError } from "../../lib/errors";
import { cn } from "@etymos/shared";
import { t, tr, currentLocale } from "../../lib/i18n";
import { TRANSACTION_STATUS_LABELS, describeItem, formatDateTime, formatVND, transactionTone } from "./format";
import { LinkTransactionDialog } from "./LinkTransactionDialog";
import { NoteDialog } from "./NoteDialog";

const FILTERS: { key: TransactionFilter; label: string }[] = [
  { key: "attention", label: tr("Needs attention") },
  { key: "matched", label: tr("Matched") },
  { key: "resolved", label: tr("Resolved") },
  { key: "ignored", label: tr("Outgoing") },
  { key: "all", label: tr("All") },
];

const isFilter = (v: string | null): v is TransactionFilter => FILTERS.some((f) => f.key === v);

export default function RevenueTransactionsPage() {
  const [params, setParams] = useSearchParams();
  const filterParam = params.get("filter");
  const filter: TransactionFilter = isFilter(filterParam) ? filterParam : "attention";
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<PaymentTransaction[]>([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [linking, setLinking] = useState<PaymentTransaction | null>(null);
  const [resolving, setResolving] = useState<PaymentTransaction | null>(null);
  const [acting, setActing] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listTransactions(page, search, filter)
      .then(({ rows, count }) => {
        if (cancelled) return;
        setRows(rows);
        setCount(count);
      })
      .catch((err: unknown) => !cancelled && setError(friendlyError(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [page, search, filter, nonce]);

  const reload = () => setNonce((n) => n + 1);

  async function handleResolve(tx: PaymentTransaction, note: string) {
    setActing(true);
    setError(null);
    try {
      const done = await resolveTransaction(tx.id, note);
      if (!done) setNotice(t("That transfer was already settled by someone else."));
      setResolving(null);
      reload();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setActing(false);
    }
  }

  const columns: Column<PaymentTransaction>[] = [
    {
      key: "date",
      label: tr("Date"),
      render: (r) => (
        <span className="whitespace-nowrap">{formatDateTime(r.transaction_date ?? r.received_at, currentLocale())}</span>
      ),
    },
    {
      key: "amount",
      label: tr("Amount"),
      render: (r) => (
        <span className={cn("whitespace-nowrap font-mono", r.transfer_type === "out" && "text-fg-subtle")}>
          {r.transfer_type === "out" ? "−" : "+"}
          {formatVND(r.amount)}
        </span>
      ),
    },
    {
      key: "content",
      label: tr("Transfer content"),
      render: (r) => (
        <div className="max-w-xs">
          <p className="truncate" title={r.content ?? ""}>{r.content || "—"}</p>
          <p className="truncate text-caption text-fg-subtle">
            {[r.gateway, r.reference_code].filter(Boolean).join(" · ")}
          </p>
        </div>
      ),
    },
    {
      key: "order",
      label: tr("Order"),
      render: (r) =>
        r.checkout_events ? (
          <div className="max-w-xs">
            <p className="truncate">{r.checkout_events.profiles?.email ?? r.checkout_events.user_id}</p>
            <p className="truncate text-caption text-fg-subtle">
              <span className="font-mono">{r.checkout_events.payment_code}</span> · {describeItem(r.checkout_events)} ·{" "}
              {formatVND(r.checkout_events.amount)}
            </p>
          </div>
        ) : (
          <span className="text-fg-subtle">{r.payment_code ? <span className="font-mono">{r.payment_code}</span> : "—"}</span>
        ),
    },
    {
      key: "status",
      label: tr("Status"),
      render: (r) => (
        <div className="max-w-[16rem]">
          <StatusBadge label={TRANSACTION_STATUS_LABELS[r.status]} tone={transactionTone(r.status)} />
          {r.note && <p className="mt-1 text-caption text-fg-subtle">{r.note}</p>}
        </div>
      ),
    },
    {
      key: "actions",
      label: tr("Actions"),
      className: "text-right",
      render: (r) =>
        ATTENTION_STATUSES.includes(r.status) ? (
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setLinking(r)}
              title={t("Link to an order")}
              className="flex size-7 cursor-pointer items-center justify-center rounded-control border border-accent/40 bg-accent-bg text-accent transition hover:opacity-90 active:scale-95"
            >
              <LinkSimple size={14} weight="bold" />
            </button>
            <button
              type="button"
              onClick={() => setResolving(r)}
              title={t("Mark as resolved")}
              className="flex size-7 cursor-pointer items-center justify-center rounded-control border border-border bg-surface-raised text-fg-muted transition hover:opacity-90 active:scale-95"
            >
              <CheckCircle size={14} weight="bold" />
            </button>
          </div>
        ) : (
          <span className="text-fg-subtle">—</span>
        ),
    },
  ];

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => {
                setPage(0);
                setParams(f.key === "attention" ? {} : { filter: f.key }, { replace: true });
              }}
              className={cn(
                "rounded-control px-3 py-1.5 text-caption font-medium transition-colors",
                filter === f.key ? "bg-accent-bg text-accent" : "text-fg-muted hover:bg-surface-raised hover:text-fg",
              )}
            >
              {t(f.label)}
            </button>
          ))}
        </div>

        <div className="relative max-w-sm flex-1 sm:min-w-[240px]">
          <MagnifyingGlass size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <input
            value={search}
            onChange={(e) => {
              setPage(0);
              setSearch(e.target.value);
            }}
            placeholder={t("Search content, reference or code…")}
            className="w-full rounded-control border border-border bg-surface-muted py-2 pl-9 pr-3 text-body text-fg outline-none focus-visible:border-accent"
          />
        </div>
      </div>

      {filter === "attention" && (
        <p className="mt-3 text-caption text-fg-muted">
          {t("Transfers that couldn't be matched to an order automatically. Link each one to the order it paid for, or mark it resolved once the money is refunded or explained.")}</p>
      )}
      {error && <p className="mt-4 text-caption text-destructive">{error}</p>}
      {notice && <p className="mt-4 text-caption text-fg-muted">{notice}</p>}

      <div className="mt-4">
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={loading}
          emptyMessage={filter === "attention" ? t("Nothing needs attention.") : t("No transfers found.")}
          page={page}
          pageCount={Math.max(1, Math.ceil(count / PAGE_SIZE))}
          onPageChange={setPage}
        />
      </div>

      {linking && (
        <LinkTransactionDialog
          transaction={linking}
          onCancel={() => setLinking(null)}
          onLinked={() => {
            setLinking(null);
            setNotice(t("Transfer linked. The order has been granted."));
            reload();
          }}
        />
      )}

      {resolving && (
        <NoteDialog
          title={t("Mark transfer as resolved")}
          description={t("Use this when the {{amount}} needs no order: it was refunded, or isn't a customer payment. Nothing is granted.", {
            amount: formatVND(resolving.amount),
          })}
          placeholder={t("What happened to this money? (required)")}
          confirmLabel={t("Mark resolved")}
          required
          pending={acting}
          onCancel={() => setResolving(null)}
          onConfirm={(note) => void handleResolve(resolving, note)}
        />
      )}
    </div>
  );
}
