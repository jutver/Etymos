import { useEffect, useState } from "react";
import { MagnifyingGlass, Check, X } from "@phosphor-icons/react";
import { DataTable, type Column } from "../../components/DataTable";
import { StatusBadge } from "../../components/StatusBadge";
import { ReviewNoteDialog } from "./ReviewNoteDialog";
import {
  listPurchaseRequests,
  approvePurchase,
  declinePurchase,
  type PurchaseRequest,
  type PurchaseStatus,
} from "../../lib/waitlistQueries";
import { listCreditPacks } from "../../lib/configQueries";
import type { AdminCreditPack } from "../../lib/types";
import { PAGE_SIZE } from "../../lib/supabaseQueries";
import { useAdminAuth } from "../../lib/auth";
import { friendlyError } from "../../lib/errors";
import { cn } from "@etymos/shared";

type BadgeTone = "neutral" | "accent" | "destructive" | "warning" | "info" | "success";

function purchaseTone(status: PurchaseStatus): BadgeTone {
  if (status === "success") return "success";
  if (status === "declined") return "destructive";
  return "warning";
}

const STATUS_TABS: { key: PurchaseStatus | "all"; label: string }[] = [
  { key: "pending", label: "Pending" },
  { key: "success", label: "Approved" },
  { key: "declined", label: "Declined" },
  { key: "all", label: "All" },
];

function formatVND(amount: number | null): string {
  if (amount === null || Number.isNaN(Number(amount))) return "—";
  return new Intl.NumberFormat("vi-VN").format(Math.round(Number(amount))) + " đ";
}

export default function PurchasesPage() {
  const { user } = useAdminAuth();
  const [statusFilter, setStatusFilter] = useState<PurchaseStatus | "all">("pending");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<PurchaseRequest[]>([]);
  const [packs, setPacks] = useState<AdminCreditPack[]>([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);
  const [declining, setDeclining] = useState<PurchaseRequest | null>(null);

  function reload() {
    let cancelled = false;
    setLoading(true);
    setError(null);

    listPurchaseRequests(page, search, statusFilter)
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
  }

  useEffect(reload, [page, search, statusFilter]);

  // Pack labels/check counts come from the same credit_packs config the
  // Pricing screen edits, so the queue always shows what will actually be
  // granted rather than a stale hardcoded number.
  useEffect(() => {
    let cancelled = false;
    listCreditPacks()
      .then((p) => !cancelled && setPacks(p))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  function describeItem(r: PurchaseRequest): string {
    if (r.kind === "plan") {
      return `${r.plan_tier ?? "—"} plan${r.billing_cycle ? ` · ${r.billing_cycle}` : ""}`;
    }
    const pack = packs.find((p) => p.id === r.pack_id);
    if (!pack) return r.pack_id ?? "—";
    return `${pack.label} · ${pack.checks} checks`;
  }

  async function handleApprove(row: PurchaseRequest) {
    if (!user) return;
    setActingId(row.id);
    setError(null);
    try {
      const granted = await approvePurchase(row);
      // false means another admin already reviewed this event — not an error,
      // but the list is stale, so surface it rather than silently reloading.
      if (!granted) {
        setError("This request was already reviewed by someone else. Refreshing.");
      }
      reload();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setActingId(null);
    }
  }

  async function handleDecline(row: PurchaseRequest, note: string) {
    if (!user) return;
    setActingId(row.id);
    setError(null);
    try {
      await declinePurchase(row.id, user.id, note);
      setDeclining(null);
      reload();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setActingId(null);
    }
  }

  const columns: Column<PurchaseRequest>[] = [
    {
      key: "requester",
      label: "Requester",
      render: (r) => r.profiles?.email ?? r.profiles?.display_name ?? r.user_id,
    },
    {
      key: "item",
      label: "Item",
      render: (r) => (
        <span className="flex items-center gap-2">
          <StatusBadge label={r.kind} tone={r.kind === "plan" ? "accent" : "info"} />
          <span className="capitalize">{describeItem(r)}</span>
        </span>
      ),
    },
    {
      key: "amount",
      label: "Amount",
      render: (r) => <span className="font-mono">{formatVND(r.amount)}</span>,
    },
    {
      key: "status",
      label: "Status",
      render: (r) => <StatusBadge label={r.status} tone={purchaseTone(r.status)} />,
    },
    {
      key: "created_at",
      label: "Requested",
      render: (r) => new Date(r.created_at).toLocaleDateString(),
    },
    {
      key: "actions",
      label: "Actions",
      className: "text-right",
      render: (r) =>
        r.status === "pending" ? (
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              disabled={actingId === r.id}
              onClick={() => handleApprove(r)}
              title="Approve and grant"
              className="flex size-7 cursor-pointer items-center justify-center rounded-control border border-success/40 bg-success-bg text-success transition hover:opacity-90 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Check size={14} weight="bold" />
            </button>
            <button
              type="button"
              disabled={actingId === r.id}
              onClick={() => setDeclining(r)}
              title="Decline"
              className="flex size-7 cursor-pointer items-center justify-center rounded-control border border-destructive/40 bg-destructive-bg text-destructive transition hover:opacity-90 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <X size={14} weight="bold" />
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
        <div className="flex gap-1.5">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => {
                setPage(0);
                setStatusFilter(tab.key);
              }}
              className={cn(
                "rounded-control px-3 py-1.5 text-caption font-medium transition-colors",
                statusFilter === tab.key
                  ? "bg-accent-bg text-accent"
                  : "text-fg-muted hover:bg-surface-raised hover:text-fg",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="relative max-w-sm flex-1 sm:min-w-[240px]">
          <MagnifyingGlass
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle"
          />
          <input
            value={search}
            onChange={(e) => {
              setPage(0);
              setSearch(e.target.value);
            }}
            placeholder="Search by plan or pack…"
            className="w-full rounded-control border border-border bg-surface-muted py-2 pl-9 pr-3 text-body text-fg outline-none focus-visible:border-accent"
          />
        </div>
      </div>

      {error && <p className="mt-4 text-caption text-destructive">{error}</p>}

      <div className="mt-4">
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={loading}
          emptyMessage="No purchase requests found."
          page={page}
          pageCount={Math.max(1, Math.ceil(count / PAGE_SIZE))}
          onPageChange={setPage}
        />
      </div>

      {declining && (
        <ReviewNoteDialog
          title="Decline purchase"
          description={`No plan or credits will be granted for this ${declining.kind} request.`}
          confirmLabel="Decline"
          pending={actingId === declining.id}
          onCancel={() => setDeclining(null)}
          onConfirm={(note) => handleDecline(declining, note)}
        />
      )}
    </div>
  );
}
