import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { MagnifyingGlass, X } from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import { DataTable, type Column } from "../../components/DataTable";
import { StatusBadge, roleTone } from "../../components/StatusBadge";
import {
  listProfiles,
  PAGE_SIZE,
  type DateRange,
  type ProfileFilters,
  type UserActivityFilter,
  type UserSort,
} from "../../lib/supabaseQueries";
import { isProfileOnline, type AccessStatus, type AdminRole, type PlanTier, type Profile } from "../../lib/types";
import { friendlyError } from "../../lib/errors";
import { t, tn, tr, currentLocale } from "../../lib/i18n";

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

interface Option<V extends string> {
  value: V;
  label: string;
}

const ROLE_OPTIONS: Option<AdminRole | "">[] = [
  { value: "", label: tr("All roles") },
  { value: "user", label: tr("User") },
  { value: "admin", label: tr("Admin") },
];

const PLAN_OPTIONS: Option<PlanTier | "">[] = [
  { value: "", label: tr("All plans") },
  { value: "free", label: tr("Free") },
  { value: "student", label: tr("Student") },
  { value: "professional", label: tr("Professional") },
];

const ACCESS_OPTIONS: Option<AccessStatus | "">[] = [
  { value: "", label: tr("Any access") },
  { value: "approved", label: tr("Approved") },
  { value: "waitlisted", label: tr("Waitlisted") },
  { value: "rejected", label: tr("Rejected") },
];

const VERIFIED_OPTIONS: Option<"" | "yes" | "no">[] = [
  { value: "", label: tr("Any verification") },
  { value: "yes", label: tr("Student verified") },
  { value: "no", label: tr("Not verified") },
];

const ACTIVITY_OPTIONS: Option<UserActivityFilter>[] = [
  { value: "", label: tr("Any status") },
  { value: "online", label: tr("Online now") },
  { value: "banned", label: tr("Banned") },
  { value: "deletion", label: tr("Deletion requested") },
];

const SORT_OPTIONS: Option<UserSort>[] = [
  { value: "newest", label: tr("Newest first") },
  { value: "oldest", label: tr("Oldest first") },
  { value: "last_seen", label: tr("Recently active") },
  { value: "credits", label: tr("Most credits") },
];

/** Filters live in the URL query string, so the filtered view survives opening
 * a user and coming back (and can be shared as a link). */
type FilterKey = "q" | "date" | "role" | "plan" | "access" | "verified" | "activity" | "sort" | "page";

/** Keep only values that appear in the option list, so a hand-edited URL can't
 * send an arbitrary string to the query. */
function pick<V extends string>(options: Option<V>[], raw: string | null, fallback: V): V {
  return options.find((o) => o.value === raw)?.value ?? fallback;
}

function FilterSelect<V extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: V;
  options: Option<V>[];
  onChange: (value: V) => void;
}) {
  // The first option is always the "any" choice; highlight the control once
  // something narrower is picked so active filters are visible at a glance.
  const active = value !== options[0]!.value;
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as V)}
      aria-label={label}
      className={cn(
        "cursor-pointer rounded-control border bg-surface-muted px-2.5 py-2 text-caption outline-none transition-colors focus-visible:border-accent",
        active ? "border-accent text-accent" : "border-border text-fg",
      )}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {t(o.label)}
        </option>
      ))}
    </select>
  );
}

export default function UsersPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const search = params.get("q") ?? "";
  const rawDate = params.get("date") ?? "";
  const signupDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : ""; // "" = no date filter
  const role = pick(ROLE_OPTIONS, params.get("role"), "");
  const plan = pick(PLAN_OPTIONS, params.get("plan"), "");
  const access = pick(ACCESS_OPTIONS, params.get("access"), "");
  const verified = pick(VERIFIED_OPTIONS, params.get("verified"), "");
  const activity = pick(ACTIVITY_OPTIONS, params.get("activity"), "");
  const sort = pick(SORT_OPTIONS, params.get("sort"), "newest");
  const page = Math.max(0, Math.floor(Number(params.get("page"))) || 0);

  /** Update one or more filters. Any filter change resets to the first page;
   * empty / default values are dropped from the URL to keep it tidy. */
  const setFilters = useCallback(
    (patch: Partial<Record<FilterKey, string | number>>) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (!("page" in patch)) next.delete("page");
          for (const [key, value] of Object.entries(patch)) {
            const str = String(value ?? "");
            const isDefault = str === "" || (key === "sort" && str === "newest") || (key === "page" && str === "0");
            if (isDefault) next.delete(key);
            else next.set(key, str);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );
  const setPage = (p: number) => setFilters({ page: p });

  // The search box is typed into locally and pushed to the URL after a short
  // pause, so we don't fire a query on every keystroke. `pushedSearch` lets us
  // tell our own URL update apart from an outside one (back button, Clear).
  const [searchInput, setSearchInput] = useState(search);
  const pushedSearch = useRef(search);
  useEffect(() => {
    if (search !== pushedSearch.current) {
      pushedSearch.current = search;
      setSearchInput(search);
    }
  }, [search]);
  useEffect(() => {
    if (searchInput === pushedSearch.current) return;
    const timer = window.setTimeout(() => {
      pushedSearch.current = searchInput;
      setFilters({ q: searchInput });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchInput, setFilters]);

  const activeFilterCount = [signupDate, role, plan, access, verified, activity].filter(Boolean).length;
  const hasFilters = activeFilterCount > 0 || search !== "";

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

    const filters: ProfileFilters = {
      search,
      signupDateRange: signupDate ? dayRange(signupDate) : null,
      role,
      plan,
      access,
      verified,
      activity,
      sort,
    };
    listProfiles(page, filters)
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
  }, [page, search, signupDate, role, plan, access, verified, activity, sort]);

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
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={t("Search by email or name…")}
            className="w-full rounded-control border border-border bg-surface-muted py-2 pl-9 pr-8 text-body text-fg outline-none focus-visible:border-accent"
          />
          {searchInput && (
            <button
              type="button"
              onClick={() => setSearchInput("")}
              aria-label={t("Clear search")}
              className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer rounded p-1 text-fg-subtle hover:text-fg"
            >
              <X size={14} />
            </button>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setFilters({ date: isToday ? "" : toDateInputValue(new Date()) })}
            className={cn(
              "cursor-pointer rounded-control px-3 py-2 text-caption font-medium transition-colors",
              isToday ? "bg-accent-bg text-accent" : "border border-border text-fg-muted hover:bg-surface-raised",
            )}
          >
            {t("Signed up today")}</button>
          <input
            type="date"
            value={signupDate}
            onChange={(e) => setFilters({ date: e.target.value })}
            aria-label={t("Joined")}
            className={cn(
              "rounded-control border bg-surface-muted px-3 py-2 text-caption text-fg outline-none focus-visible:border-accent",
              signupDate ? "border-accent" : "border-border",
            )}
          />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <FilterSelect label={t("Role")} value={role} options={ROLE_OPTIONS} onChange={(v) => setFilters({ role: v })} />
        <FilterSelect label={t("Plan")} value={plan} options={PLAN_OPTIONS} onChange={(v) => setFilters({ plan: v })} />
        <FilterSelect
          label={t("Access")}
          value={access}
          options={ACCESS_OPTIONS}
          onChange={(v) => setFilters({ access: v })}
        />
        <FilterSelect
          label={t("Student verified")}
          value={verified}
          options={VERIFIED_OPTIONS}
          onChange={(v) => setFilters({ verified: v })}
        />
        <FilterSelect
          label={t("Status")}
          value={activity}
          options={ACTIVITY_OPTIONS}
          onChange={(v) => setFilters({ activity: v })}
        />

        <span className="mx-1 hidden h-5 w-px bg-border sm:block" aria-hidden />
        <label className="flex items-center gap-1.5 text-caption text-fg-muted">
          {t("Sort")}
          <select
            value={sort}
            onChange={(e) => setFilters({ sort: e.target.value })}
            className="cursor-pointer rounded-control border border-border bg-surface-muted px-2.5 py-2 text-caption text-fg outline-none focus-visible:border-accent"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {t(o.label)}
              </option>
            ))}
          </select>
        </label>

        {hasFilters && (
          <button
            type="button"
            onClick={() => {
              pushedSearch.current = "";
              setSearchInput("");
              setFilters({ q: "", date: "", role: "", plan: "", access: "", verified: "", activity: "" });
            }}
            className="inline-flex cursor-pointer items-center gap-1 rounded-control border border-border px-3 py-2 text-caption font-medium text-fg-muted transition hover:bg-surface-raised"
          >
            <X size={12} />
            {t("Clear filters")}
            {activeFilterCount > 0 && <span className="tabular-nums opacity-70">{activeFilterCount}</span>}
          </button>
        )}

        <span className="ml-auto text-caption tabular-nums text-fg-muted" aria-live="polite">
          {!loading && tn(count, "{{count}} user", "{{count}} users", { count: count.toLocaleString(currentLocale()) })}
        </span>
      </div>

      {error && <p className="mt-4 text-caption text-destructive">{error}</p>}

      <div className="mt-4">
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={loading}
          emptyMessage={
            signupDate && activeFilterCount === 1 && !search
              ? t("No users signed up on this day.")
              : hasFilters
                ? t("No users match these filters.")
                : t("No users found.")
          }
          onRowClick={(r) => navigate(`/users/${r.id}`)}
          page={page}
          pageCount={Math.max(1, Math.ceil(count / PAGE_SIZE))}
          onPageChange={setPage}
        />
      </div>
    </div>
  );
}
