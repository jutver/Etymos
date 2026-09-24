import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import { DataTable, type Column } from "../../components/DataTable";
import { StatusBadge, roleTone } from "../../components/StatusBadge";
import { listProfiles, PAGE_SIZE, type DateRange } from "../../lib/supabaseQueries";
import { isProfileOnline, type Profile } from "../../lib/types";
import { friendlyError } from "../../lib/errors";
import { t, tr, currentLocale } from "../../lib/i18n";

/** Local YYYY-MM-DD for a Date, used both to render the date input's value
 * and to build the day's [from, to) range below — kept in the viewer's local
 * timezone rather than UTC so "today" matches what the admin actually means. */
function toDateInputValue(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dayRange(dateInputValue: string): DateRange {
  const start = new Date(`${dateInputValue}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

export default function UsersPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [signupDate, setSignupDate] = useState(""); // "" = no date filter
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<Profile[]>([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Re-render periodically so the online/offline dot reflects the passage of
  // time even if no other state changes (a user can go stale without any
  // fetch happening).
  const [, forceTick] = useState(0);

  useEffect(() => {
    const interval = window.setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const range = signupDate ? dayRange(signupDate) : null;
    listProfiles(page, search, range)
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
  }, [page, search, signupDate]);

  const isToday = signupDate === toDateInputValue(new Date());

  const columns: Column<Profile>[] = [
    { key: "email", label: tr("Email"), render: (r) => r.email ?? r.display_name ?? r.id },
    { key: "role", label: tr("Role"), render: (r) => <StatusBadge label={t(r.role)} tone={roleTone(r.role)} /> },
    { key: "plan", label: tr("Plan"), render: (r) => <span className="capitalize">{r.plan_tier}</span> },
    { key: "standard_credits", label: tr("Standard"), render: (r) => r.standard_credits },
    { key: "premium_credits", label: tr("Premium"), render: (r) => r.premium_credits },
    {
      key: "online",
      label: tr("Online"),
      render: (r) => {
        const online = isProfileOnline(r.last_seen_at);
        return (
          <span className="inline-flex items-center gap-1.5">
            <span
              className={cn("size-2 shrink-0 rounded-full", online ? "bg-success" : "bg-fg-subtle/40")}
              aria-hidden
            />
            <span className="text-caption text-fg-muted">{online ? t("Online") : t("Offline")}</span>
          </span>
        );
      },
    },
    {
      key: "student_verified",
      label: tr("Student verified"),
      render: (r) => (r.student_verified ? t("Yes") : t("No")),
    },
    {
      key: "created_at",
      label: tr("Joined"),
      render: (r) => new Date(r.created_at).toLocaleDateString(currentLocale()),
    },
  ];

  return (
    <div>
      <h1 className="text-h1 font-semibold text-fg">{t("Users")}</h1>
      <p className="mt-1 text-body text-fg-muted">{t("Search, inspect, and manually adjust plans/credits.")}</p>

      <div className="mt-5 flex flex-wrap items-center gap-3">
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
            placeholder={t("Search by email or name…")}
            className="w-full rounded-control border border-border bg-surface-muted py-2 pl-9 pr-3 text-body text-fg outline-none focus-visible:border-accent"
          />
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => {
              setPage(0);
              setSignupDate(isToday ? "" : toDateInputValue(new Date()));
            }}
            className={cn(
              "cursor-pointer rounded-control px-3 py-2 text-caption font-medium transition-colors",
              isToday ? "bg-accent-bg text-accent" : "border border-border text-fg-muted hover:bg-surface-raised",
            )}
          >
            {t("Signed up today")}</button>
          <input
            type="date"
            value={signupDate}
            onChange={(e) => {
              setPage(0);
              setSignupDate(e.target.value);
            }}
            className="rounded-control border border-border bg-surface-muted px-3 py-2 text-caption text-fg outline-none focus-visible:border-accent"
          />
          {signupDate && (
            <button
              type="button"
              onClick={() => {
                setPage(0);
                setSignupDate("");
              }}
              className="cursor-pointer rounded-control border border-border px-3 py-2 text-caption font-medium text-fg-muted transition hover:bg-surface-raised"
            >
              {t("Clear")}</button>
          )}
        </div>
      </div>

      {error && <p className="mt-4 text-caption text-destructive">{error}</p>}

      <div className="mt-4">
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={loading}
          emptyMessage={signupDate ? t("No users signed up on this day.") : t("No users found.")}
          onRowClick={(r) => navigate(`/users/${r.id}`)}
          page={page}
          pageCount={Math.max(1, Math.ceil(count / PAGE_SIZE))}
          onPageChange={setPage}
        />
      </div>
    </div>
  );
}
