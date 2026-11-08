import { useEffect, useState } from "react";
import { MagnifyingGlass, Eye, Check, X, CircleNotch, Trash, FileX } from "@phosphor-icons/react";
import { DataTable, type Column } from "../../components/DataTable";
import { DeleteRecordsDialog } from "../../components/DeleteRecordsDialog";
import { selectionColumn } from "../../components/selectionColumn";
import { StatusBadge } from "../../components/StatusBadge";
import {
  listVerificationRequests,
  approveVerificationRequest,
  rejectVerificationRequest,
  getEvidenceSignedUrl,
  deleteVerificationRequests,
  deleteVerificationFiles,
  type VerificationRequest,
  type VerificationStatus,
} from "../../lib/verificationQueries";
import { PAGE_SIZE } from "../../lib/supabaseQueries";
import { useAdminAuth } from "../../lib/auth";
import { friendlyError } from "../../lib/errors";
import { toastDeleteResult, type DeleteScope } from "../../lib/storageFiles";
import { pushToast } from "../../lib/toast";
import { cn } from "@etymos/shared";
import { t, tn, tr, currentLocale } from "../../lib/i18n";

type BadgeTone = "neutral" | "accent" | "destructive" | "warning" | "info" | "success";

function verificationTone(status: VerificationStatus): BadgeTone {
  if (status === "approved") return "success";
  if (status === "rejected") return "destructive";
  return "warning";
}

const STATUS_TABS: { key: VerificationStatus | "all"; label: string }[] = [
  { key: "pending", label: tr("Pending") },
  { key: "approved", label: tr("Approved") },
  { key: "rejected", label: tr("Rejected") },
  { key: "all", label: tr("All") },
];

const DELETE_STATUSES = STATUS_TABS.filter((tab) => tab.key !== "all");

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
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // The ids the dialog offers as "selected": the ticked rows, or one row's
  // own delete button.
  const [deleteIds, setDeleteIds] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Requests whose evidence files the confirm dialog is about to delete.
  const [fileRows, setFileRows] = useState<VerificationRequest[] | null>(null);
  const [deletingFiles, setDeletingFiles] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

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
  // A selection only makes sense for the list it was made in.
  useEffect(() => setSelected(new Set()), [search, statusFilter]);

  function openDelete(ids: string[]) {
    setDeleteError(null);
    setDeleteIds(ids);
  }

  async function handleDelete(scope: DeleteScope) {
    setDeleting(true);
    setDeleteError(null);
    try {
      const result = await deleteVerificationRequests(scope);
      setDeleteIds(null);
      setSelected(new Set());
      toastDeleteResult(result);
      reload();
    } catch (err) {
      setDeleteError(friendlyError(err));
    } finally {
      setDeleting(false);
    }
  }

  function openDeleteFiles(targets: VerificationRequest[]) {
    setFileError(null);
    setFileRows(targets.filter((r) => !r.file_deleted_at));
  }

  async function handleDeleteFiles() {
    if (!user || !fileRows) return;
    setDeletingFiles(true);
    setFileError(null);
    try {
      const count = await deleteVerificationFiles(fileRows, user.id);
      setFileRows(null);
      setSelected(new Set());
      pushToast({ kind: "success", title: tn(count, "Deleted {{count}} file", "Deleted {{count}} files") });
      reload();
    } catch (err) {
      setFileError(friendlyError(err));
    } finally {
      setDeletingFiles(false);
    }
  }

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
      pushToast({ kind: "success", title: t("Verification approved") });
      reload();
    } catch (err) {
      pushToast({ kind: "error", title: t("Couldn't approve the request"), description: friendlyError(err) });
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
      pushToast({ kind: "success", title: t("Verification rejected") });
      reload();
    } catch (err) {
      pushToast({ kind: "error", title: t("Couldn't reject the request"), description: friendlyError(err) });
    } finally {
      setActingId(null);
    }
  }

  const columns: Column<VerificationRequest>[] = [
    selectionColumn(rows, (r) => r.id, selected, setSelected),
    {
      key: "requester",
      label: tr("Requester"),
      render: (r) => r.profiles?.email ?? r.profiles?.display_name ?? r.user_id,
    },
    {
      key: "storage_path",
      label: tr("Evidence file"),
      render: (r) =>
        r.file_deleted_at ? (
          <span
            className="flex min-w-0 items-center gap-2"
            title={t("File deleted on {{date}}", { date: new Date(r.file_deleted_at).toLocaleString(currentLocale()) })}
          >
            <span className="truncate text-fg-subtle line-through">{r.storage_path.split("/").pop() ?? r.storage_path}</span>
            <StatusBadge label={t("File deleted")} tone="neutral" capitalize={false} />
          </span>
        ) : (
          <span className="truncate">{r.storage_path.split("/").pop() ?? r.storage_path}</span>
        ),
    },
    {
      key: "status",
      label: tr("Status"),
      render: (r) => <StatusBadge label={r.status} tone={verificationTone(r.status)} />,
    },
    {
      key: "created_at",
      label: tr("Submitted"),
      render: (r) => new Date(r.created_at).toLocaleDateString(currentLocale()),
    },
    {
      key: "actions",
      label: tr("Actions"),
      className: "text-right",
      render: (r) => (
        <div className="flex justify-end gap-1.5">
          <button
            type="button"
            onClick={() => handlePreview(r)}
            disabled={previewLoading || !!r.file_deleted_at}
            title={r.file_deleted_at ? t("The file was deleted") : t("Preview evidence")}
            className="flex size-7 cursor-pointer items-center justify-center rounded-control border border-border text-fg-muted transition hover:bg-surface-raised active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {previewLoading ? (
              <CircleNotch size={14} className="animate-spin" />
            ) : (
              <Eye size={14} weight="bold" />
            )}
          </button>
          {r.status !== "approved" && (
            <button
              type="button"
              disabled={actingId === r.id}
              onClick={() => handleApprove(r)}
              title={r.status === "rejected" ? t("Approve after all") : t("Approve")}
              className="flex size-7 cursor-pointer items-center justify-center rounded-control border border-success/40 bg-success-bg text-success transition hover:opacity-90 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Check size={14} weight="bold" />
            </button>
          )}
          {r.status === "pending" && (
            <button
              type="button"
              disabled={actingId === r.id}
              onClick={() => handleReject(r)}
              title={t("Reject")}
              className="flex size-7 cursor-pointer items-center justify-center rounded-control border border-destructive/40 bg-destructive-bg text-destructive transition hover:opacity-90 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <X size={14} weight="bold" />
            </button>
          )}
          {!r.file_deleted_at && (
            <button
              type="button"
              onClick={() => openDeleteFiles([r])}
              title={t("Delete the file, keep the request")}
              className="flex size-7 cursor-pointer items-center justify-center rounded-control border border-border text-fg-muted transition hover:border-destructive/40 hover:bg-destructive-bg hover:text-destructive active:scale-95"
            >
              <FileX size={14} weight="bold" />
            </button>
          )}
          <button
            type="button"
            onClick={() => openDelete([r.id])}
            title={t("Delete the request and its file")}
            className="flex size-7 cursor-pointer items-center justify-center rounded-control border border-border text-fg-muted transition hover:border-destructive/40 hover:bg-destructive-bg hover:text-destructive active:scale-95"
          >
            <Trash size={14} weight="bold" />
          </button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <h1 className="text-h1 font-semibold text-fg">{t("Student Verification")}</h1>
      <p className="mt-1 text-body text-fg-muted">
        {t("Review submitted student ID evidence, approve or reject verification requests. Once reviewed, you can delete the uploaded file and keep the request.")}</p>

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
              {t(tab.label)}
            </button>
          ))}
        </div>

        <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
          {selected.size > 0 && (
            <button
              type="button"
              onClick={() => openDeleteFiles(rows.filter((r) => selected.has(r.id)))}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-control border border-border px-3 py-2 text-caption font-medium text-fg-muted transition hover:border-destructive/40 hover:bg-destructive-bg hover:text-destructive active:scale-95"
            >
              <FileX size={14} weight="bold" />
              {t("Delete files ({{count}})", { count: selected.size })}
            </button>
          )}
          <button
            type="button"
            onClick={() => openDelete([...selected])}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-control border border-border px-3 py-2 text-caption font-medium text-fg-muted transition hover:border-destructive/40 hover:bg-destructive-bg hover:text-destructive active:scale-95"
          >
            <Trash size={14} weight="bold" />
            {selected.size > 0 ? t("Delete ({{count}})", { count: selected.size }) : t("Delete…")}
          </button>
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
              placeholder={t("Search by file name…")}
              className="w-full rounded-control border border-border bg-surface-muted py-2 pl-9 pr-3 text-body text-fg outline-none focus-visible:border-accent"
            />
          </div>
        </div>
      </div>

      {error && <p className="mt-4 text-caption text-destructive">{error}</p>}

      <div className="mt-4">
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={loading}
          emptyMessage={t("No verification requests found.")}
          page={page}
          pageCount={Math.max(1, Math.ceil(count / PAGE_SIZE))}
          onPageChange={setPage}
        />
      </div>

      {deleteIds && (
        <DeleteRecordsDialog
          title={tr("Delete verification requests")}
          selectedIds={deleteIds}
          statuses={DELETE_STATUSES}
          defaultStatus={statusFilter === "all" ? "rejected" : statusFilter}
          pending={deleting}
          error={deleteError}
          onCancel={() => setDeleteIds(null)}
          onConfirm={handleDelete}
        />
      )}

      {fileRows && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={() => setFileRows(null)}>
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-md overflow-hidden rounded-card border border-border bg-surface shadow-pop"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
              <p className="text-body font-medium text-fg">{t("Delete evidence files")}</p>
              <button
                type="button"
                onClick={() => setFileRows(null)}
                title={t("Close")}
                className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-control text-fg-muted transition hover:bg-surface-raised active:scale-95"
              >
                <X size={16} weight="bold" />
              </button>
            </div>
            <div className="flex flex-col gap-2 p-5">
              {fileRows.length === 0 ? (
                <p className="text-body text-fg">{t("The files of these requests are already deleted.")}</p>
              ) : (
                <>
                  <p className="text-body text-fg">
                    {fileRows.length === 1
                      ? t("Delete the file {{name}} from {{who}}?", {
                          name: fileRows[0].storage_path.split("/").pop() ?? fileRows[0].storage_path,
                          who: fileRows[0].profiles?.email ?? fileRows[0].user_id,
                        })
                      : t("Delete the files of {{count}} requests?", { count: fileRows.length })}
                  </p>
                  <p className="text-caption text-fg-muted">
                    {t("The file can't be recovered. The request stays in the list with its status, dates and reviewer, and the student's verification doesn't change.")}
                  </p>
                </>
              )}
              {fileError && <p className="text-caption text-destructive">{fileError}</p>}
              <div className="mt-3 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setFileRows(null)}
                  className="cursor-pointer rounded-control border border-border px-3 py-1.5 text-caption font-medium text-fg-muted transition hover:bg-surface-raised active:scale-95"
                >
                  {t("Cancel")}
                </button>
                {fileRows.length > 0 && (
                  <button
                    type="button"
                    disabled={deletingFiles}
                    onClick={handleDeleteFiles}
                    className="cursor-pointer rounded-control border border-destructive/40 bg-destructive-bg px-3 py-1.5 text-caption font-medium text-destructive transition hover:opacity-90 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {deletingFiles ? t("Deleting…") : t("Delete files")}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

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
                title={t("Close")}
                className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-control text-fg-muted transition hover:bg-surface-raised active:scale-95"
              >
                <X size={16} weight="bold" />
              </button>
            </div>
            <div className="flex-1 overflow-auto bg-surface-muted p-4">
              {preview.storagePath.toLowerCase().endsWith(".pdf") ? (
                <iframe src={preview.url} title={t("Evidence document")} className="h-[65vh] w-full rounded-control" />
              ) : (
                <img
                  src={preview.url}
                  alt={t("Verification evidence")}
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
