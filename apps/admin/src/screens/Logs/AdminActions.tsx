// Logs > Admin actions: every change an admin made, who made it, when, and
// what it changed (from → to). Filter by admin, area, dates or text; ?user=
// narrows it to actions about one account.
import { Fragment, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowClockwise, CaretDown, CaretRight, MagnifyingGlass, X } from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import {
  AREAS,
  actionTone,
  describeAction,
  formatValue,
  listAdminActions,
  listAdmins,
  type ActionTone,
  type AdminActionEntry,
  type AdminActionFilters,
  type AreaKey,
} from "../../lib/adminActionLogQueries";
import { friendlyError } from "../../lib/errors";
import { currentLocale, t } from "../../lib/i18n";

const TONE: Record<ActionTone, string> = {
  create: "bg-success",
  change: "bg-accent",
  delete: "bg-destructive",
  neutral: "bg-fg-subtle",
};

const field =
  "h-8 rounded-control border border-border bg-surface px-2 text-caption text-fg outline-none focus:border-accent";

function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(currentLocale(), { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

function Changes({ entry }: { entry: AdminActionEntry }) {
  const changes = Object.entries(entry.changes);
  const extra = Object.entries(entry.metadata).filter(([k]) => k !== "from_audit_log");
  return (
    <div className="space-y-2 text-caption">
      {changes.length > 0 && (
        <table className="w-full">
          <tbody>
            {changes.map(([key, change]) => (
              <tr key={key} className="align-top">
                <td className="w-44 py-0.5 pr-3 font-mono text-fg-subtle">{key}</td>
                <td className="break-all py-0.5 font-mono">
                  {"from" in change && <span className="text-destructive line-through decoration-destructive/40">{formatValue(change.from)}</span>}
                  {"from" in change && "to" in change && <span className="px-1.5 text-fg-subtle">→</span>}
                  {"to" in change && <span className="text-success">{formatValue(change.to)}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {extra.length > 0 && (
        <dl className="grid grid-cols-[11rem_1fr] gap-x-3 gap-y-0.5">
          {extra.map(([key, value]) => (
            <Fragment key={key}>
              <dt className="font-mono text-fg-subtle">{key}</dt>
              <dd className="break-all font-mono text-fg-muted">
                {key === "request_id" ? (
                  <Link to={`/logs/server/live?request=${encodeURIComponent(String(value))}`} className="text-accent hover:underline">
                    {String(value)}
                  </Link>
                ) : (
                  formatValue(value)
                )}
              </dd>
            </Fragment>
          ))}
        </dl>
      )}
      <p className="font-mono text-micro text-fg-subtle">
        {entry.action}
        {entry.target_table && ` · ${entry.target_table}`}
        {entry.target_id && ` · ${entry.target_id}`}
        {` · ${entry.source === "portal" ? t("recorded by the database") : t("recorded by the backend")}`}
      </p>
    </div>
  );
}

export default function AdminActionsPage() {
  const [params, setParams] = useSearchParams();
  const [admins, setAdmins] = useState<{ id: string; email: string | null }[]>([]);
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<AdminActionFilters>(() => ({
    actorId: params.get("admin") ?? "",
    area: (params.get("area") as AreaKey | null) ?? "",
    from: params.get("from") ?? "",
    to: params.get("to") ?? "",
    search: "",
    targetUserId: params.get("user") ?? "",
  }));
  const [rows, setRows] = useState<AdminActionEntry[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [reload, setReload] = useState(0);

  useEffect(() => {
    listAdmins().then(setAdmins).catch(() => undefined);
  }, []);

  // Typing: search after a pause.
  useEffect(() => {
    const timer = window.setTimeout(() => setFilters((f) => (f.search === search ? f : { ...f, search })), 400);
    return () => window.clearTimeout(timer);
  }, [search]);

  // Keep the filters in the URL, so a filtered view can be shared or reloaded.
  useEffect(() => {
    const next = new URLSearchParams();
    if (filters.actorId) next.set("admin", filters.actorId);
    if (filters.area) next.set("area", filters.area);
    if (filters.from) next.set("from", filters.from);
    if (filters.to) next.set("to", filters.to);
    if (filters.targetUserId) next.set("user", filters.targetUserId);
    setParams(next, { replace: true });
  }, [filters.actorId, filters.area, filters.from, filters.to, filters.targetUserId, setParams]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listAdminActions(filters)
      .then((page) => {
        if (cancelled) return;
        setRows(page.rows);
        setMore(page.more);
        setOpen(new Set());
      })
      .catch((err: unknown) => !cancelled && setError(friendlyError(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [filters, reload]);

  function loadMore() {
    const last = rows[rows.length - 1];
    if (!last) return;
    setLoading(true);
    listAdminActions(filters, last.id)
      .then((page) => {
        setRows((prev) => [...prev, ...page.rows]);
        setMore(page.more);
      })
      .catch((err: unknown) => setError(friendlyError(err)))
      .finally(() => setLoading(false));
  }

  function toggle(id: number) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const hasFilters =
    filters.actorId || filters.area || filters.from || filters.to || filters.targetUserId || search.trim();

  let lastDay = "";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative">
          <MagnifyingGlass size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("Search email, title, action…")}
            aria-label={t("Search admin actions")}
            className={cn(field, "w-60 pl-8")}
          />
        </label>
        <select
          value={filters.actorId}
          onChange={(e) => setFilters((f) => ({ ...f, actorId: e.target.value }))}
          aria-label={t("Admin")}
          className={cn(field, "cursor-pointer")}
        >
          <option value="">{t("All admins")}</option>
          {admins.map((a) => (
            <option key={a.id} value={a.id}>
              {a.email ?? a.id.slice(0, 8)}
            </option>
          ))}
        </select>
        <select
          value={filters.area}
          onChange={(e) => setFilters((f) => ({ ...f, area: e.target.value as AreaKey | "" }))}
          aria-label={t("Area")}
          className={cn(field, "cursor-pointer")}
        >
          <option value="">{t("All areas")}</option>
          {(Object.keys(AREAS) as AreaKey[]).map((key) => (
            <option key={key} value={key}>
              {t(AREAS[key].label)}
            </option>
          ))}
        </select>
        <div className={cn(field, "flex items-center gap-1.5")}>
          <input
            type="date"
            value={filters.from}
            max={filters.to || undefined}
            onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))}
            aria-label={t("Start date")}
            className="bg-transparent outline-none"
          />
          <span className="text-fg-subtle">–</span>
          <input
            type="date"
            value={filters.to}
            min={filters.from || undefined}
            onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
            aria-label={t("End date")}
            className="bg-transparent outline-none"
          />
        </div>
        {filters.targetUserId && (
          <span className="inline-flex h-8 items-center gap-1.5 rounded-control border border-accent/40 bg-accent-bg px-2.5 text-caption text-accent">
            <span className="text-fg-muted">{t("About user")}</span>
            <span className="font-mono">{filters.targetUserId.slice(0, 8)}</span>
            <button
              type="button"
              onClick={() => setFilters((f) => ({ ...f, targetUserId: "" }))}
              aria-label={t("Remove filter")}
              className="cursor-pointer hover:text-fg"
            >
              <X size={12} weight="bold" />
            </button>
          </span>
        )}
        {hasFilters && (
          <button
            type="button"
            className="h-8 cursor-pointer px-1 text-caption font-medium text-accent hover:underline"
            onClick={() => {
              setSearch("");
              setFilters({ actorId: "", area: "", from: "", to: "", search: "", targetUserId: "" });
            }}
          >
            {t("Clear filters")}
          </button>
        )}
        <button
          type="button"
          onClick={() => setReload((n) => n + 1)}
          disabled={loading}
          className="ml-auto flex h-8 cursor-pointer items-center gap-1.5 rounded-control border border-border bg-surface px-2.5 text-caption font-medium text-fg-muted transition hover:bg-surface-raised hover:text-fg disabled:opacity-60"
        >
          <ArrowClockwise size={14} weight="bold" className={cn(loading && "animate-spin")} />
          {t("Refresh")}
        </button>
      </div>

      {error && (
        <p className="rounded-card border border-destructive/40 bg-destructive-bg px-3 py-2 text-caption text-destructive">
          {error}
        </p>
      )}

      <section className="rounded-card border border-border bg-surface shadow-card">
        {rows.length === 0 && !loading ? (
          <p className="px-4 py-8 text-center text-body text-fg-muted">
            {hasFilters ? t("No admin actions match these filters.") : t("No admin actions recorded yet.")}
          </p>
        ) : (
          <ul>
            {rows.map((entry) => {
              const day = dayLabel(entry.created_at);
              const showDay = day !== lastDay;
              lastDay = day;
              const isOpen = open.has(entry.id);
              const changeCount = Object.keys(entry.changes).length;
              return (
                <Fragment key={entry.id}>
                  {showDay && (
                    <li className="sticky top-0 z-10 border-b border-border bg-surface/95 px-4 py-2 text-caption font-semibold text-fg-muted backdrop-blur first:rounded-t-card">
                      {day}
                    </li>
                  )}
                  <li className="border-b border-border/60 last:border-0">
                    <button
                      type="button"
                      onClick={() => toggle(entry.id)}
                      aria-expanded={isOpen}
                      className="flex w-full cursor-pointer items-start gap-3 px-4 py-2.5 text-left transition hover:bg-surface-raised/50"
                    >
                      <span className="mt-0.5 w-24 shrink-0 whitespace-nowrap font-mono text-caption tabular-nums text-fg-subtle">
                        {new Date(entry.created_at).toLocaleTimeString(currentLocale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                      </span>
                      <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", TONE[actionTone(entry)])} />
                      <span className="min-w-0 flex-1">
                        <span className="text-body text-fg">
                          <span className="font-medium">{entry.actor_email ?? entry.actor_id?.slice(0, 8) ?? t("Unknown admin")}</span>{" "}
                          <span className="text-fg-muted">{describeAction(entry).toLowerCase()}</span>
                          {entry.summary && <span className="font-medium"> {entry.summary}</span>}
                        </span>
                        {!isOpen && changeCount > 0 && (
                          <span className="mt-0.5 block truncate font-mono text-caption text-fg-subtle">
                            {Object.keys(entry.changes).slice(0, 6).join(", ")}
                            {changeCount > 6 && ` +${changeCount - 6}`}
                          </span>
                        )}
                      </span>
                      {entry.target_user_id && (
                        <Link
                          to={`/users/${entry.target_user_id}`}
                          onClick={(e) => e.stopPropagation()}
                          className="mt-0.5 shrink-0 text-caption font-medium text-accent hover:underline"
                        >
                          {t("Open user")}
                        </Link>
                      )}
                      <span className="mt-1 shrink-0 text-fg-subtle">
                        {isOpen ? <CaretDown size={14} weight="bold" /> : <CaretRight size={14} weight="bold" />}
                      </span>
                    </button>
                    {isOpen && (
                      <div className="pb-3 pl-[9rem] pr-4">
                        <Changes entry={entry} />
                      </div>
                    )}
                  </li>
                </Fragment>
              );
            })}
          </ul>
        )}
        {(more || loading) && (
          <div className="border-t border-border p-3 text-center">
            <button
              type="button"
              onClick={loadMore}
              disabled={loading}
              className="cursor-pointer rounded-control border border-border px-3 py-1.5 text-caption font-medium text-fg-muted transition hover:bg-surface-raised disabled:opacity-60"
            >
              {loading ? t("Loading…") : t("Load older actions")}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
