import { useEffect, useState } from "react";
import { MagnifyingGlass, Check, X } from "@phosphor-icons/react";
import { DataTable, type Column } from "../../components/DataTable";
import { StatusBadge } from "../../components/StatusBadge";
import { ReviewNoteDialog } from "./ReviewNoteDialog";
import { listAccessRequests, approveAccess, rejectAccess } from "../../lib/waitlistQueries";
import type { AccessStatus, Profile } from "../../lib/types";
import { PAGE_SIZE } from "../../lib/supabaseQueries";
import { useAdminAuth } from "../../lib/auth";
import { friendlyError } from "../../lib/errors";
import { cn } from "@etymos/shared";

type BadgeTone = "neutral" | "accent" | "destructive" | "warning" | "info" | "success";

function accessTone(status: AccessStatus): BadgeTone {
  if (status === "approved") return "success";
  if (status === "rejected") return "destructive";
  return "warning";
}

const STATUS_TABS: { key: AccessStatus | "all"; label: string }[] = [
  { key: "waitlisted", label: "Waitlisted" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
  { key: "all", label: "All" },
];

export default function AccessPage() {
  const { user } = useAdminAuth();
  const [statusFilter, setStatusFilter] = useState<AccessStatus | "all">("waitlisted");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<Profile[]>([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<Profile | null>(null);

  function reload() {
    let cancelled = false;
    setLoading(true);
    setError(null);

    listAccessRequests(page, search, statusFilter)
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

  async function handleApprove(row: Profile) {
    if (!user) return;
    setActingId(row.id);
    setError(null);
    try {
      await approveAccess(row.id, user.id);
      reload();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setActingId(null);
    }
  }

  async function handleReject(row: Profile, note: string) {
    if (!user) return;
    setActingId(row.id);
    setError(null);
    try {
      await rejectAccess(row.id, user.id, note);
      setRejecting(null);
      reload();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setActingId(null);
    }
  }

  const columns: Column<Profile>[] = [
    {
      key: "user",
      label: "User",
      render: (r) => r.email ?? r.display_name ?? r.id,
    },
    {
      key: "access_status",
      label: "Status",
      render: (r) => <StatusBadge label={r.access_status} tone={accessTone(r.access_status)} />,
    },
    {
      key: "access_requested_at",
      label: "Requested",
      render: (r) => new Date(r.access_requested_at ?? r.created_at).toLocaleDateString(),
    },
    {
      key: "access_note",
      label: "Note",
      render: (r) => <span className="text-fg-muted">{r.access_note ?? "—"}</span>,
    },
    {
      key: "actions",
      label: "Actions",
      className: "text-right",
      render: (r) =>
        r.access_status === "waitlisted" ? (
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              disabled={actingId === r.id}
              onClick={() => handleApprove(r)}
              title="Approve access"
              className="flex size-7 cursor-pointer items-center justify-center rounded-control border border-success/40 bg-success-bg text-success transition hover:opacity-90 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Check size={14} weight="bold" />
            </button>
            <button
              type="button"
              disabled={actingId === r.id}
              onClick={() => setRejecting(r)}
              title="Reject access"
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
            placeholder="Search by email or name…"
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
          emptyMessage="No access requests found."
          page={page}
          pageCount={Math.max(1, Math.ceil(count / PAGE_SIZE))}
          onPageChange={setPage}
        />
      </div>

      {rejecting && (
        <ReviewNoteDialog
          title="Reject access request"
          description={`${rejecting.email ?? rejecting.display_name ?? rejecting.id} will not be able to use the app.`}
          confirmLabel="Reject"
          pending={actingId === rejecting.id}
          onCancel={() => setRejecting(null)}
          onConfirm={(note) => handleReject(rejecting, note)}
        />
      )}
    </div>
  );
}
