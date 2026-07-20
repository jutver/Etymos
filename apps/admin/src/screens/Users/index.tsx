import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { DataTable, type Column } from "../../components/DataTable";
import { StatusBadge, roleTone } from "../../components/StatusBadge";
import { listProfiles, PAGE_SIZE } from "../../lib/supabaseQueries";
import type { Profile } from "../../lib/types";
import { friendlyError } from "../../lib/errors";

export default function UsersPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<Profile[]>([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    listProfiles(page, search)
      .then(({ rows, count }) => {
        if (cancelled) return;
        setRows(rows);
        setCount(count);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(friendlyError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [page, search]);

  const columns: Column<Profile>[] = [
    { key: "email", label: "Email", render: (r) => r.email ?? r.display_name ?? r.id },
    { key: "role", label: "Role", render: (r) => <StatusBadge label={r.role} tone={roleTone(r.role)} /> },
    { key: "plan", label: "Plan", render: (r) => <span className="capitalize">{r.plan_tier}</span> },
    { key: "standard_credits", label: "Standard", render: (r) => r.standard_credits },
    { key: "premium_credits", label: "Premium", render: (r) => r.premium_credits },
    {
      key: "student_verified",
      label: "Student verified",
      render: (r) => (r.student_verified ? "Yes" : "No"),
    },
    {
      key: "created_at",
      label: "Joined",
      render: (r) => new Date(r.created_at).toLocaleDateString(),
    },
  ];

  return (
    <div>
      <h1 className="text-h1 font-semibold text-fg">Users</h1>
      <p className="mt-1 text-body text-fg-muted">Search, inspect, and manually adjust plans/credits.</p>

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
          placeholder="Search by email or name…"
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
          emptyMessage="No users found."
          onRowClick={(r) => navigate(`/users/${r.id}`)}
          page={page}
          pageCount={Math.max(1, Math.ceil(count / PAGE_SIZE))}
          onPageChange={setPage}
        />
      </div>
    </div>
  );
}
