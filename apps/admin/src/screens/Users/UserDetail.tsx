// A user's page: who they are and their key numbers up top, then four tabs
// (Actions, Messages, Documents, Activity), each its own route under
// /users/:id so a tab can be linked to and Back works.
import { Suspense, useEffect, useState, type ReactNode } from "react";
import { NavLink, Outlet, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft } from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import { ListItemsSkeleton, Skeleton } from "../../components/Skeleton";
import { StatusBadge, roleTone } from "../../components/StatusBadge";
import { getProfile } from "../../lib/supabaseQueries";
import { countUserDocuments } from "../../lib/userDocumentsQueries";
import { isProfileBanned, isProfileOnline, isProfileSupportBanned, type PlanTier, type Profile } from "../../lib/types";
import { friendlyError } from "../../lib/errors";
import { t, tr, currentLocale } from "../../lib/i18n";
import { planChecks, planLabel } from "../../lib/plans";
import { listPlanDefinitions } from "../../lib/configQueries";
import type { UserDetailContext } from "./userDetailContext";

const TABS = [
  { to: "actions", label: tr("Actions") },
  { to: "messages", label: tr("Messages") },
  { to: "documents", label: tr("Documents") },
  { to: "activity", label: tr("Activity") },
];

function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string | null }) {
  return (
    <div className="min-w-0 rounded-control border border-border bg-surface px-3.5 py-2.5 shadow-card">
      <p className="truncate text-caption text-fg-muted">{label}</p>
      <p className="mt-0.5 truncate text-body font-semibold tabular-nums text-fg">{value}</p>
      {hint && <p className="truncate text-caption text-fg-subtle">{hint}</p>}
    </div>
  );
}

function HeaderSkeleton() {
  return (
    <div aria-busy="true">
      <Skeleton className="h-8 w-72" />
      <Skeleton className="mt-2 h-4 w-48" />
      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-16" rounded="control" />
        ))}
      </div>
    </div>
  );
}

export default function UserDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [documents, setDocuments] = useState<number | null>(null);
  // Each plan's monthly check allowance, from Pricing (plan_definitions.doc_limit).
  const [docLimits, setDocLimits] = useState<Partial<Record<PlanTier, number | null>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    getProfile(id)
      .then((p) => !cancelled && setProfile(p))
      .catch((err: unknown) => !cancelled && setError(friendlyError(err)))
      .finally(() => !cancelled && setLoading(false));
    listPlanDefinitions()
      .then((plans) => !cancelled && setDocLimits(Object.fromEntries(plans.map((p) => [p.id, p.doc_limit]))))
      .catch(() => !cancelled && setDocLimits(null));
    countUserDocuments(id)
      .then((n) => !cancelled && setDocuments(n))
      .catch(() => !cancelled && setDocuments(null));
    return () => {
      cancelled = true;
    };
  }, [id]);

  const back = (
    <button
      type="button"
      onClick={() => navigate("/users")}
      className="mb-4 flex cursor-pointer items-center gap-1.5 text-caption font-medium text-fg-muted transition-colors hover:text-fg"
    >
      <ArrowLeft size={14} weight="bold" />
      {t("Back to Users")}
    </button>
  );

  if (loading) {
    return (
      <div className="max-w-[1800px]">
        {back}
        <HeaderSkeleton />
      </div>
    );
  }

  if (!profile) {
    return (
      <div>
        {back}
        <p className="text-body text-destructive">{error ?? t("User not found.")}</p>
      </div>
    );
  }

  const online = isProfileOnline(profile.last_seen_at);
  const name = profile.display_name?.trim() || null;
  const paid = profile.plan_tier !== "free";
  const context: UserDetailContext = { profile, setProfile };
  const checks = docLimits ? planChecks(profile, docLimits) : null;

  return (
    <div className="max-w-[1800px]">
      {back}

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="min-w-0 break-all text-h1 font-semibold text-fg">{name ?? profile.email ?? profile.id}</h1>
        <StatusBadge label={t(profile.role)} tone={roleTone(profile.role)} />
        <span className="inline-flex items-center gap-1.5">
          <span className={cn("size-2 shrink-0 rounded-full", online ? "bg-success" : "bg-fg-subtle/40")} aria-hidden />
          <span className="text-caption text-fg-muted">{online ? t("Online now") : t("Offline")}</span>
        </span>
        {isProfileBanned(profile) && <StatusBadge label={t("Banned")} tone="destructive" />}
        {isProfileSupportBanned(profile) && <StatusBadge label={t("Support banned")} tone="destructive" />}
        {profile.deletion_requested_at && <StatusBadge label={t("Deletion requested")} tone="warning" />}
      </div>
      {name && profile.email && <p className="mt-1 break-all text-body text-fg-muted">{profile.email}</p>}

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Stat
          label={t("Plan")}
          value={planLabel(profile.plan_tier)}
          hint={
            paid
              ? profile.plan_expires_at
                ? t("Ends {{date}}", { date: new Date(profile.plan_expires_at).toLocaleDateString(currentLocale()) })
                : t("No end date")
              : null
          }
        />
        <Stat
          label={t("Credits")}
          value={`${profile.standard_credits} · ${profile.premium_credits}`}
          hint={t("Standard · Premium")}
        />
        <Stat label={t("Documents")} value={documents === null ? "—" : documents.toLocaleString(currentLocale())} />
        <Stat
          label={t("Plan checks left")}
          value={
            !checks
              ? "—"
              : checks.left === null
                ? t("Unlimited")
                : t("{{left}} of {{limit}}", { left: checks.left, limit: checks.limit ?? 0 })
          }
          hint={
            checks
              ? t("{{used}} used · resets {{date}}", {
                  used: checks.used,
                  date: checks.resetsAt.toLocaleDateString(currentLocale(), { day: "numeric", month: "short" }),
                })
              : null
          }
        />
        <Stat label={t("Joined")} value={new Date(profile.created_at).toLocaleDateString(currentLocale())} />
        <Stat
          label={t("Last seen")}
          value={
            online
              ? t("Online now")
              : profile.last_seen_at
                ? new Date(profile.last_seen_at).toLocaleDateString(currentLocale())
                : t("Never")
          }
          hint={
            !online && profile.last_seen_at
              ? new Date(profile.last_seen_at).toLocaleTimeString(currentLocale(), { hour: "2-digit", minute: "2-digit" })
              : null
          }
        />
      </div>

      <nav className="mt-6 flex gap-1 overflow-x-auto border-b border-border" aria-label={t("User sections")}>
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) =>
              cn(
                "shrink-0 border-b-2 px-3 py-2 text-body font-medium transition-colors",
                isActive ? "border-accent text-accent" : "border-transparent text-fg-muted hover:text-fg",
              )
            }
          >
            {t(tab.label)}
          </NavLink>
        ))}
      </nav>

      <div className="mt-5">
        {/* Tabs load on demand; keep the header up while one does. */}
        <Suspense
          fallback={
            <div className="rounded-card border border-border bg-surface p-6 shadow-card">
              <ListItemsSkeleton count={4} />
            </div>
          }
        >
          <Outlet context={context} />
        </Suspense>
      </div>
    </div>
  );
}
