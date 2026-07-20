import { useEffect, useState } from "react";
import { MagnifyingGlass, Eye, Check, X, CircleNotch } from "@phosphor-icons/react";
import { DataTable, type Column } from "../../components/DataTable";
import { StatusBadge } from "../../components/StatusBadge";
import {
  listVerificationRequests,
  approveVerificationRequest,
  rejectVerificationRequest,
  getEvidenceSignedUrl,
  type VerificationRequest,
  type VerificationStatus,
} from "../../lib/verificationQueries";
import { PAGE_SIZE } from "../../lib/supabaseQueries";
import { useAdminAuth } from "../../lib/auth";
import { friendlyError } from "../../lib/errors";
import { cn } from "@etymos/shared";

type BadgeTone = "neutral" | "accent" | "destructive" | "warning" | "info" | "success";

function verificationTone(status: VerificationStatus): BadgeTone {
  if (status === "approved") return "success";
  if (status === "rejected") return "destructive";
  return "warning";
}

const STATUS_TABS: { key: VerificationStatus | "all"; label: string }[] = [
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
  { key: "all", label: "All" },
];

export default function VerificationPage() {
  const { user } = useAdminAuth();
  const [statusFilter, setStatusFilter] = useState<VerificationStatus | "all">("pending");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<VerificationRequest[]>([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ url: string; storagePath: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  function reload() {
    let cancelled = false;
    setLoading(true);
    setError(null);

    listVerificationRequests(page, search, statusFilter)
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

  async function handlePreview(row: VerificationRequest) {
    setError(null);
    setPreviewLoading(true);
    try {
      const url = await getEvidenceSignedUrl(row.storage_path);
      setPreview({ url, storagePath: row.storage_path });
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setPreviewLoading(false);
    }
  }

  async function handleApprove(row: VerificationRequest) {
    if (!user) return;
    setActingId(row.id);
    setError(null);
    try {
      await approveVerificationRequest(row.id, row.user_id, user.id);
      reload();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setActingId(null);
    }
  }

  async function handleReject(row: VerificationRequest) {
    if (!user) return;
    setActingId(row.id);
    setError(null);
    try {
      await rejectVerificationRequest(row.id, user.id);
      reload();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setActingId(null);
    }
  }

  const columns: Column<VerificationRequest>[] = [
    {
      key: "requester",
      label: "Requester",
      render: (r) => r.profiles?.email ?? r.profiles?.display_name ?? r.user_id,
    },
    {
      key: "storage_path",
      label: "Evidence file",
      render: (r) => (
        <span className="truncate">{r.storage_path.split("/").pop() ?? r.storage_path}</span>
      ),
    },
    {
      key: "status",
      label: "Status",
      render: (r) => <StatusBadge label={r.status} tone={verificationTone(r.status)} />,
    },
    {
      key: "created_at",
      label: "Submitted",
      render: (r) => new Date(r.created_at).toLocaleDateString(),
    },
    {
      key: "actions",
      label: "Actions",
      className: "text-right",
      render: (r) => (
        <div className="flex justify-end gap-1.5">
          <button
            type="button"
            onClick={() => handlePreview(r)}
            disabled={previewLoading}
            title="Preview evidence"
            className="flex size-7 cursor-pointer items-center justify-center rounded-control border border-border text-fg-muted transition hover:bg-surface-raised active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {previewLoading ? (
              <CircleNotch size={14} className="animate-spin" />
            ) : (
              <Eye size={14} weight="bold" />
            )}
          </button>
          {r.status === "pending" && (
            <>
              <button
                type="button"
                disabled={actingId === r.id}
                onClick={() => handleApprove(r)}
                title="Approve"
                className="flex size-7 cursor-pointer items-center justify-center rounded-control border border-success/40 bg-success-bg text-success transition hover:opacity-90 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Check size={14} weight="bold" />
              </button>
              <button
                type="button"
                disabled={actingId === r.id}
                onClick={() => handleReject(r)}
                title="Reject"
                className="flex size-7 cursor-pointer items-center justify-center rounded-control border border-destructive/40 bg-destructive-bg text-destructive transition hover:opacity-90 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <X size={14} weight="bold" />
              </button>
            </>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      <h1 className="text-h1 font-semibold text-fg">Student Verification</h1>
      <p className="mt-1 text-body text-fg-muted">
        Review submitted student ID evidence, approve or reject verification requests.
      </p>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
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
            placeholder="Search by file name…"
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
          emptyMessage="No verification requests found."
          page={page}
          pageCount={Math.max(1, Math.ceil(count / PAGE_SIZE))}
          onPageChange={setPage}
        />
      </div>

      {preview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
          onClick={() => setPreview(null)}
        >
          <div
            className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-card border border-border bg-surface shadow-pop"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
              <p className="truncate text-body font-medium text-fg">
                {preview.storagePath.split("/").pop() ?? preview.storagePath}
              </p>
              <button
                type="button"
                onClick={() => setPreview(null)}
                title="Close"
                className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-control text-fg-muted transition hover:bg-surface-raised active:scale-95"
              >
                <X size={16} weight="bold" />
              </button>
            </div>
            <div className="flex-1 overflow-auto bg-surface-muted p-4">
              {preview.storagePath.toLowerCase().endsWith(".pdf") ? (
                <iframe src={preview.url} title="Evidence document" className="h-[65vh] w-full rounded-control" />
              ) : (
                <img
                  src={preview.url}
                  alt="Verification evidence"
                  className="mx-auto max-h-[65vh] w-auto rounded-control object-contain"
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
