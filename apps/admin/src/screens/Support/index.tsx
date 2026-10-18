import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { EnvelopeSimple, MagnifyingGlass, ShieldWarning, Trash } from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import { DataTable, type Column } from "../../components/DataTable";
import { DeleteRecordsDialog } from "../../components/DeleteRecordsDialog";
import { selectionColumn } from "../../components/selectionColumn";
import { StatusBadge } from "../../components/StatusBadge";
import {
  deleteSupportTickets,
  getSupportSummary,
  listSupportTickets,
  type SupportCategory,
  type SupportStatus,
  type SupportSummary,
  type SupportTicketQuery,
  type SupportTicketRow,
} from "../../lib/supportApi";
import { friendlyError } from "../../lib/errors";
import { toastDeleteResult, type DeleteScope } from "../../lib/storageFiles";
import { t, tr } from "../../lib/i18n";
import { CATEGORY_LABELS, STATUS_LABELS, ago, statusTone } from "./labels";

const PAGE_SIZE = 30;

const STATUS_TABS: { key: SupportStatus | "all"; label: string }[] = [
  { key: "open", label: tr("Open") },
  { key: "pending", label: tr("Waiting on user") },
  { key: "resolved", label: tr("Resolved") },
  { key: "closed", label: tr("Closed") },
  { key: "all", label: tr("All") },
];

const DELETE_STATUSES = STATUS_TABS.filter((tab) => tab.key !== "all");

// Last result per filter combination, kept for the session. Switching back to
// a tab shows it straight away while a fresh copy loads in the background, so
// the inbox never shows rows staler than the last visit.
const pageCache = new Map<string, { items: SupportTicketRow[]; total: number }>();

const ASSIGNEE_FILTERS: { key: string; label: string }[] = [
  { key: "", label: tr("Everyone") },
  { key: "me", label: tr("Mine") },
  { key: "unassigned", label: tr("Unassigned") },
];

export default function SupportInboxPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<SupportStatus | "all">("open");
  const [assigned, setAssigned] = useState("");
  const [category, setCategory] = useState<SupportCategory | "">("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<SupportTicketRow[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<SupportSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Bumped after a delete so the list and counts load again.
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const params: SupportTicketQuery = {
      status: status === "all" ? undefined : status,
      assigned: assigned || undefined,
      category: category || undefined,
      q: search,
      page: page + 1,
      pageSize: PAGE_SIZE,
    };
    const key = JSON.stringify(params);
    const cached = pageCache.get(key);
    if (cached) {
      setRows(cached.items);
      setTotal(cached.total);
    }
    setLoading(!cached);
    setError(null);
    const timer = window.setTimeout(() => {
      listSupportTickets(params)
        .then((r) => {
          pageCache.set(key, r);
          if (cancelled) return;
          setRows(r.items);
          setTotal(r.total);
        })
        .catch((err: unknown) => !cancelled && setError(friendlyError(err)))
        .finally(() => !cancelled && setLoading(false));
    }, search ? 250 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [status, assigned, category, search, page, version]);

  // A selection only makes sense for the list it was made in.
  useEffect(() => setSelected(new Set()), [status, assigned, category, search]);

  // Tab counts don't depend on the filters, so they load once per visit.
  useEffect(() => {
    let cancelled = false;
    getSupportSummary()
      .then((s) => !cancelled && setSummary(s))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [version]);

  async function handleDelete(scope: DeleteScope) {
    setDeleting(true);
    setDeleteError(null);
    try {
      const result = await deleteSupportTickets(scope);
      pageCache.clear();
      setDeleteOpen(false);
      setSelected(new Set());
      toastDeleteResult(result);
      setVersion((v) => v + 1);
    } catch (err) {
      setDeleteError(friendlyError(err));
    } finally {
      setDeleting(false);
    }
  }

  const columns: Column<SupportTicketRow>[] = [
    selectionColumn(rows, (r) => r.id, selected, setSelected),
    {
      key: "number",
      label: tr("#"),
      className: "w-16",
      render: (r) => <span className="font-mono text-caption text-fg-muted">{r.number}</span>,
    },
    {
      key: "subject",
      label: tr("Request"),
      render: (r) => (
        <div className="min-w-0 max-w-md">
          <p className="flex items-center gap-1.5 truncate font-medium text-fg">
            {r.priority === "high" && <span className="size-1.5 shrink-0 rounded-full bg-destructive" title={t("High priority")} />}
            <span className="truncate">{r.subject}</span>
          </p>
          <p className="flex items-center gap-1.5 truncate text-caption text-fg-muted">
            {r.source === "email" && <EnvelopeSimple size={12} className="shrink-0" />}
            {!r.identity_verified && (
              <ShieldWarning size={12} className="shrink-0 text-warning" aria-label={t("Identity not verified")} />
            )}
            <span className="truncate">{r.requester_name ? `${r.requester_name} · ${r.requester_email}` : r.requester_email}</span>
          </p>
        </div>
      ),
    },
    {
      key: "category",
      label: tr("Topic"),
      render: (r) => <span className="text-fg-muted">{t(CATEGORY_LABELS[r.category])}</span>,
    },
    {
      key: "status",
      label: tr("Status"),
      render: (r) => <StatusBadge label={STATUS_LABELS[r.status]} tone={statusTone(r.status)} capitalize={false} />,
    },
    {
      key: "assignee",
      label: tr("Assignee"),
      render: (r) => <span className="text-fg-muted">{r.assignee?.name || r.assignee?.email || "—"}</span>,
    },
    {
      key: "waiting",
      label: tr("Last activity"),
      className: "text-right",
      render: (r) => (
        <span className="text-caption text-fg-muted" title={new Date(r.updated_at).toLocaleString()}>
          {r.status === "open" ? t("waiting {{time}}", { time: ago(r.last_user_message_at) }) : ago(r.updated_at)}
        </span>
      ),
    },
  ];

  return (
    <div>
      <h1 className="text-h1 font-semibold text-fg">{t("Support")}</h1>
      <p className="mt-1 text-body text-fg-muted">
        {t("Requests from the contact form and emails to support@etymos.site. Replies are emailed from the support mailbox.")}
      </p>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {STATUS_TABS.map((tab) => {
            const count = tab.key !== "all" && summary ? summary.counts[tab.key] : null;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => {
                  setPage(0);
                  setStatus(tab.key);
                }}
                className={cn(
                  "rounded-control px-3 py-1.5 text-caption font-medium transition-colors",
                  status === tab.key ? "bg-accent-bg text-accent" : "text-fg-muted hover:bg-surface-raised hover:text-fg",
                )}
              >
                {t(tab.label)}
                {count !== null && count > 0 && <span className="ml-1.5 tabular-nums opacity-70">{count}</span>}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setDeleteError(null);
              setDeleteOpen(true);
            }}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-control border border-border px-3 py-2 text-caption font-medium text-fg-muted transition hover:border-destructive/40 hover:bg-destructive-bg hover:text-destructive active:scale-95"
          >
            <Trash size={14} weight="bold" />
            {selected.size > 0 ? t("Delete ({{count}})", { count: selected.size }) : t("Delete…")}
          </button>
          <select
            value={assigned}
            onChange={(e) => {
              setPage(0);
              setAssigned(e.target.value);
            }}
            aria-label={t("Assignee")}
            className="rounded-control border border-border bg-surface-muted px-2.5 py-2 text-body text-fg outline-none focus-visible:border-accent"
          >
            {ASSIGNEE_FILTERS.map((f) => (
              <option key={f.key} value={f.key}>
                {t(f.label)}
              </option>
            ))}
          </select>
          <select
            value={category}
            onChange={(e) => {
              setPage(0);
              setCategory(e.target.value as SupportCategory | "");
            }}
            aria-label={t("Topic")}
            className="rounded-control border border-border bg-surface-muted px-2.5 py-2 text-body text-fg outline-none focus-visible:border-accent"
          >
            <option value="">{t("All topics")}</option>
            {(Object.keys(CATEGORY_LABELS) as SupportCategory[]).map((c) => (
              <option key={c} value={c}>
                {t(CATEGORY_LABELS[c])}
              </option>
            ))}
          </select>
          <div className="relative min-w-[220px]">
            <MagnifyingGlass size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
            <input
              value={search}
              onChange={(e) => {
                setPage(0);
                setSearch(e.target.value);
              }}
              placeholder={t("Number, email or subject…")}
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
          emptyMessage={t("No support requests here.")}
          onRowClick={(r) => navigate(`/support/${r.number}`)}
          page={page}
          pageCount={Math.max(1, Math.ceil(total / PAGE_SIZE))}
          onPageChange={setPage}
        />
      </div>

      {deleteOpen && (
        <DeleteRecordsDialog
          title={tr("Delete support requests")}
          selectedIds={[...selected]}
          statuses={DELETE_STATUSES}
          defaultStatus={status === "all" ? "closed" : status}
          pending={deleting}
          error={deleteError}
          onCancel={() => setDeleteOpen(false)}
          onConfirm={handleDelete}
        />
      )}
    </div>
  );
}
