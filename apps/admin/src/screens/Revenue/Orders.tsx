import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { DataTable, type Column } from "../../components/DataTable";
import { StatusBadge } from "../../components/StatusBadge";
import { listOrders, type OrderFilter, type RevenueOrder } from "../../lib/revenueQueries";
import { PAGE_SIZE } from "../../lib/supabaseQueries";
import { friendlyError } from "../../lib/errors";
import { cn } from "@etymos/shared";
import { t, tr, currentLocale } from "../../lib/i18n";
import { ORDER_STATUS_LABELS, describeItem, formatDateTime, formatVND, methodLabel, orderTone } from "./format";

const FILTERS: { key: OrderFilter; label: string }[] = [
  { key: "paid", label: tr("Paid") },
  { key: "awaiting", label: tr("Awaiting payment") },
  { key: "cancelled", label: tr("Cancelled") },
  { key: "declined", label: tr("Declined") },
  { key: "all", label: tr("All") },
];

const isFilter = (v: string | null): v is OrderFilter => FILTERS.some((f) => f.key === v);

function isExpired(order: RevenueOrder): boolean {
  return order.status === "pending" && !!order.expires_at && new Date(order.expires_at).getTime() < Date.now();
}

export default function RevenueOrdersPage() {
  const [params, setParams] = useSearchParams();
  const filterParam = params.get("filter");
  const filter: OrderFilter = isFilter(filterParam) ? filterParam : "paid";
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<RevenueOrder[]>([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listOrders(page, search, filter)
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
  }, [page, search, filter]);

  const columns: Column<RevenueOrder>[] = [
    {
      key: "created",
      label: tr("Created"),
      render: (r) => <span className="whitespace-nowrap">{formatDateTime(r.created_at, currentLocale())}</span>,
    },
    {
      key: "customer",
      label: tr("Customer"),
      render: (r) => <span className="block max-w-[14rem] truncate">{r.profiles?.email ?? r.profiles?.display_name ?? r.user_id}</span>,
    },
    { key: "item", label: tr("Item"), render: (r) => describeItem(r) },
    {
      key: "amount",
      label: tr("Amount"),
      render: (r) => (
        <div className="whitespace-nowrap font-mono">
          {formatVND(r.paid_amount ?? r.amount)}
          {r.list_amount != null && r.amount != null && Number(r.amount) < Number(r.list_amount) && (
            <span className="ml-1.5 text-caption text-fg-subtle line-through">{formatVND(r.list_amount)}</span>
          )}
        </div>
      ),
    },
    {
      key: "code",
      label: tr("Payment code"),
      render: (r) => <span className="font-mono text-caption">{r.payment_code ?? "—"}</span>,
    },
    { key: "method", label: tr("Method"), render: (r) => methodLabel(r.payment_method) },
    {
      key: "status",
      label: tr("Status"),
      render: (r) => (
        <div>
          <StatusBadge label={isExpired(r) ? tr("QR expired") : ORDER_STATUS_LABELS[r.status]} tone={isExpired(r) ? "neutral" : orderTone(r)} />
          {r.paid_at && <p className="mt-1 text-caption text-fg-subtle">{formatDateTime(r.paid_at, currentLocale())}</p>}
        </div>
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
                setParams(f.key === "paid" ? {} : { filter: f.key }, { replace: true });
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
            placeholder={t("Search by payment code…")}
            className="w-full rounded-control border border-border bg-surface-muted py-2 pl-9 pr-3 text-body text-fg outline-none focus-visible:border-accent"
          />
        </div>
      </div>

      {filter === "awaiting" && (
        <p className="mt-3 text-caption text-fg-muted">
          {t("Orders whose QR was shown but no matching transfer has arrived. A transfer that arrives after the QR expires is still applied.")}</p>
      )}
      {error && <p className="mt-4 text-caption text-destructive">{error}</p>}

      <div className="mt-4">
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={loading}
          emptyMessage={t("No orders found.")}
          page={page}
          pageCount={Math.max(1, Math.ceil(count / PAGE_SIZE))}
          onPageChange={setPage}
        />
      </div>
    </div>
  );
}
