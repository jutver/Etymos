import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { DataTable, type Column } from "../../components/DataTable";
import { StatusBadge, moderationTone, docStatusTone } from "../../components/StatusBadge";
import { listDocuments } from "../../lib/moderationQueries";
import { PAGE_SIZE } from "../../lib/supabaseQueries";
import type { AdminDocument } from "../../lib/types";

export default function ModerationPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<AdminDocument[]>([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    listDocuments(page, search)
      .then(({ rows, count }) => {
        if (cancelled) return;
        setRows(rows);
        setCount(count);
      })
      .catch((err: Error) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));

    return () => {
      cancelled = true;
    };
  }, [page, search]);

  const columns: Column<AdminDocument>[] = [
    { key: "title", label: "Document", render: (r) => r.title ?? r.file_name ?? r.id },
    {
      key: "owner",
      label: "Owner",
      render: (r) => r.profiles?.email ?? r.profiles?.display_name ?? r.user_id,
    },
    {
      key: "status",
      label: "Similarity",
      render: (r) => r.status ? <StatusBadge label={r.status} tone={docStatusTone(r.status)} /> : "—",
    },
    {
      key: "moderation_status",
      label: "Moderation",
      render: (r) => <StatusBadge label={r.moderation_status} tone={moderationTone(r.moderation_status)} />,
    },
    {
      key: "uploaded_at",
      label: "Uploaded",
      render: (r) => new Date(r.uploaded_at).toLocaleDateString(),
    },
  ];

  return (
    <div>
      <h1 className="text-h1 font-semibold text-fg">Moderation</h1>
      <p className="mt-1 text-body text-fg-muted">Browse documents across all users, flag or remove content.</p>

      <div className="relative mt-5 max-w-sm">
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
          placeholder="Search by document title…"
          className="w-full rounded-control border border-border bg-surface-muted py-2 pl-9 pr-3 text-body text-fg outline-none focus-visible:border-accent"
        />
      </div>

      {error && <p className="mt-4 text-caption text-destructive">{error}</p>}

      <div className="mt-4">
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={loading}
          emptyMessage="No documents found."
          onRowClick={(r) => navigate(`/moderation/${r.id}`)}
          page={page}
          pageCount={Math.max(1, Math.ceil(count / PAGE_SIZE))}
          onPageChange={setPage}
        />
      </div>
    </div>
  );
}
