import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  ChatCircleSlash,
  ClockCounterClockwise,
  Prohibit,
  ShieldWarning,
  TrashSimple,
  X,
} from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import { DetailPageSkeleton, ListItemsSkeleton } from "../../components/Skeleton";
import { StatusBadge, roleTone } from "../../components/StatusBadge";
import { Switch } from "../../components/Switch";
import {
  getProfile,
  insertAuditLog,
  listAuditLogForUser,
  updateProfile,
  type AuditLogEntry,
} from "../../lib/supabaseQueries";
import { forceDeleteUser } from "../../lib/api";
import { UserActivityLog } from "./UserActivityLog";
import {
  isProfileBanned,
  isProfileOnline,
  isProfileSupportBanned,
  type BillingCycle,
  type PlanTier,
  type Profile,
} from "../../lib/types";
import { friendlyError } from "../../lib/errors";
import { useAdminAuth } from "../../lib/auth";
import { t, tr, currentLocale } from "../../lib/i18n";
import { billingCycleLabel, planLabel } from "../../lib/plans";

const PLAN_OPTIONS: PlanTier[] = ["free", "student", "professional"];
const BILLING_OPTIONS: BillingCycle[] = ["monthly", "annual"];

const FIELD_LABELS: Record<string, string> = {
  plan_tier: tr("Plan tier"),
  billing_cycle: tr("Billing cycle"),
  plan_expires_at: tr("Plan ends"),
  standard_credits: tr("Standard credits"),
  premium_credits: tr("Premium credits"),
  student_verified: tr("Student verified"),
};

const ACTION_LABELS: Record<string, string> = {
  profile_updated: tr("Profile updated"),
  user_banned: tr("User banned"),
  user_unbanned: tr("User unbanned"),
  user_support_banned: tr("User banned from support"),
  user_support_unbanned: tr("Support ban lifted"),
  deletion_requested: tr("Account deletion requested"),
  deletion_request_cancelled: tr("Deletion request cancelled"),
  user_force_deleted: tr("User force-deleted"),
};

function formatAuditValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? t("Yes") : t("No");
  return String(value);
}

type EditableProfileFields = Pick<
  Profile,
  "plan_tier" | "billing_cycle" | "plan_expires_at" | "standard_credits" | "premium_credits" | "student_verified"
>;

/** Vietnam calendar day (yyyy-mm-dd) of a timestamp, for the date input. */
function toVNDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(new Date(iso).getTime() + 7 * 3600_000).toISOString().slice(0, 10);
}

/** A date input's day as the end of that day in Vietnam time; blank = no end date. */
function fromVNDate(day: string): string | null {
  return day ? new Date(`${day}T23:59:59+07:00`).toISOString() : null;
}

/** Diffs only the fields that actually changed, for a compact audit_log metadata payload. */
function diffProfileFields(before: EditableProfileFields, after: EditableProfileFields) {
  const beforeChanged: Record<string, unknown> = {};
  const afterChanged: Record<string, unknown> = {};
  (Object.keys(after) as (keyof EditableProfileFields)[]).forEach((key) => {
    if (before[key] !== after[key]) {
      beforeChanged[key] = before[key];
      afterChanged[key] = after[key];
    }
  });
  return { before: beforeChanged, after: afterChanged };
}

/** yyyy-MM-ddThh:mm for a <input type="datetime-local">, in the admin's local
 * timezone (matches how the input itself displays/edits the value). */
function toDatetimeLocalValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const DELETE_CONFIRM_PHRASE = "DELETE";

/** The account ban blocks sign-in; the support ban only blocks support tickets.
 * Same fields under a different prefix, so one modal serves both. */
type BanTarget = "account" | "support";

function banPatch(target: BanTarget, ban: { permanent: boolean; until: string | null; reason: string | null; by: string | null }): Partial<Profile> {
  return target === "account"
    ? { banned_permanent: ban.permanent, banned_until: ban.until, ban_reason: ban.reason, banned_by: ban.by }
    : {
        support_banned_permanent: ban.permanent,
        support_banned_until: ban.until,
        support_ban_reason: ban.reason,
        support_banned_by: ban.by,
      };
}

export default function UserDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user: adminUser, session } = useAdminAuth();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [planTier, setPlanTier] = useState<PlanTier>("free");
  const [billingCycle, setBillingCycle] = useState<BillingCycle>("monthly");
  const [planEnds, setPlanEnds] = useState("");
  const [standardCredits, setStandardCredits] = useState(0);
  const [premiumCredits, setPremiumCredits] = useState(0);
  const [studentVerified, setStudentVerified] = useState(false);

  const [auditLog, setAuditLog] = useState<AuditLogEntry[]>([]);
  const [auditLoading, setAuditLoading] = useState(true);
  const [activityVersion, setActivityVersion] = useState(0);


  // Ban modal (account or support ban)
  const [banModalOpen, setBanModalOpen] = useState(false);
  const [banTarget, setBanTarget] = useState<BanTarget>("account");
  const [banMode, setBanMode] = useState<"permanent" | "until">("permanent");
  const [banUntilInput, setBanUntilInput] = useState(() => toDatetimeLocalValue(new Date(Date.now() + 86_400_000)));
  const [banReasonInput, setBanReasonInput] = useState("");
  const [banSubmitting, setBanSubmitting] = useState(false);
  const [unbanSubmitting, setUnbanSubmitting] = useState<BanTarget | null>(null);

  // Deletion
  const [requestingDeletion, setRequestingDeletion] = useState(false);
  const [cancellingDeletion, setCancellingDeletion] = useState(false);
  const [forceDeleteModalOpen, setForceDeleteModalOpen] = useState(false);
  const [forceDeleteConfirmText, setForceDeleteConfirmText] = useState("");
  const [forceDeleting, setForceDeleting] = useState(false);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    getProfile(id)
      .then((p) => {
        if (cancelled) return;
        setProfile(p);
        setPlanTier(p.plan_tier);
        setBillingCycle(p.billing_cycle ?? "monthly");
        setPlanEnds(toVNDate(p.plan_expires_at));
        setStandardCredits(p.standard_credits);
        setPremiumCredits(p.premium_credits);
        setStudentVerified(p.student_verified);
      })
      .catch((err: unknown) => !cancelled && setError(friendlyError(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [id]);

  function refreshAuditLog(userId: string) {
    // An admin action also adds entries to the activities log; reload it too.
    setActivityVersion((v) => v + 1);
    setAuditLoading(true);
    return listAuditLogForUser(userId)
      .then((rows) => setAuditLog(rows))
      .catch((err: unknown) => console.warn("Failed to load audit log:", friendlyError(err)))
      .finally(() => setAuditLoading(false));
  }

  useEffect(() => {
    if (!id) return;
    refreshAuditLog(id);
  }, [id]);

  async function handleSave() {
    if (!id || !profile) return;
    setSaving(true);
    setError(null);
    try {
      const before: EditableProfileFields = {
        plan_tier: profile.plan_tier,
        billing_cycle: profile.billing_cycle,
        plan_expires_at: profile.plan_expires_at,
        standard_credits: profile.standard_credits,
        premium_credits: profile.premium_credits,
        student_verified: profile.student_verified,
      };
      const after: EditableProfileFields = {
        plan_tier: planTier,
        billing_cycle: billingCycle,
        // Untouched (same day shown) keeps the exact stored time; Free keeps
        // the old value so a lapsed account still shows when it ended.
        plan_expires_at:
          planTier === "free" || planEnds === toVNDate(profile.plan_expires_at)
            ? profile.plan_expires_at
            : fromVNDate(planEnds),
        standard_credits: standardCredits,
        premium_credits: premiumCredits,
        student_verified: studentVerified,
      };

      await updateProfile(id, after);

      const { before: changedBefore, after: changedAfter } = diffProfileFields(before, after);
      if (adminUser && Object.keys(changedAfter).length > 0) {
        try {
          await insertAuditLog({
            actor_id: adminUser.id,
            target_user_id: id,
            action: "profile_updated",
            metadata: { before: changedBefore, after: changedAfter },
          });
        } catch (auditErr) {
          // Don't fail the whole save if the audit write is rejected (e.g. by RLS) —
          // the profile update itself already succeeded.
          console.warn("Failed to write audit_log entry:", friendlyError(auditErr));
        }
      }

      const refreshed = await getProfile(id);
      setProfile(refreshed);
      await refreshAuditLog(id);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setSaving(false);
    }
  }

  function openBanModal(target: BanTarget) {
    setBanTarget(target);
    setBanMode("permanent");
    setBanUntilInput(toDatetimeLocalValue(new Date(Date.now() + 86_400_000)));
    setBanReasonInput((target === "account" ? profile?.ban_reason : profile?.support_ban_reason) ?? "");
    setError(null);
    setBanModalOpen(true);
  }

  async function handleSubmitBan() {
    if (!id || !adminUser) return;
    setBanSubmitting(true);
    setError(null);
    try {
      const untilIso = banMode === "until" ? new Date(banUntilInput).toISOString() : null;
      await updateProfile(
        id,
        banPatch(banTarget, {
          permanent: banMode === "permanent",
          until: untilIso,
          reason: banReasonInput.trim() || null,
          by: adminUser.id,
        }),
      );
      try {
        await insertAuditLog({
          actor_id: adminUser.id,
          target_user_id: id,
          action: banTarget === "account" ? "user_banned" : "user_support_banned",
          metadata: { permanent: banMode === "permanent", until: untilIso, reason: banReasonInput.trim() || null },
        });
      } catch (auditErr) {
        console.warn("Failed to write audit_log entry:", friendlyError(auditErr));
      }
      const refreshed = await getProfile(id);
      setProfile(refreshed);
      await refreshAuditLog(id);
      setBanModalOpen(false);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBanSubmitting(false);
    }
  }

  async function handleUnban(target: BanTarget) {
    if (!id || !adminUser) return;
    setUnbanSubmitting(target);
    setError(null);
    try {
      await updateProfile(id, banPatch(target, { permanent: false, until: null, reason: null, by: null }));
      try {
        await insertAuditLog({
          actor_id: adminUser.id,
          target_user_id: id,
          action: target === "account" ? "user_unbanned" : "user_support_unbanned",
          metadata: {},
        });
      } catch (auditErr) {
        console.warn("Failed to write audit_log entry:", friendlyError(auditErr));
      }
      const refreshed = await getProfile(id);
      setProfile(refreshed);
      await refreshAuditLog(id);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setUnbanSubmitting(null);
    }
  }

  /** Normal delete path: only flags the account for deletion. The user's own
   * browser executes it via `DELETE /api/account` once they confirm — see
   * apps/web's deletion-confirm gate. This admin side never calls the
   * backend for this path. */
  async function handleRequestDeletion() {
    if (!id || !adminUser) return;
    setRequestingDeletion(true);
    setError(null);
    try {
      await updateProfile(id, {
        deletion_requested_at: new Date().toISOString(),
        deletion_requested_by: adminUser.id,
      });
      try {
        await insertAuditLog({
          actor_id: adminUser.id,
          target_user_id: id,
          action: "deletion_requested",
          metadata: {},
        });
      } catch (auditErr) {
        console.warn("Failed to write audit_log entry:", friendlyError(auditErr));
      }
      const refreshed = await getProfile(id);
      setProfile(refreshed);
      await refreshAuditLog(id);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setRequestingDeletion(false);
    }
  }

  async function handleCancelDeletionRequest() {
    if (!id || !adminUser) return;
    setCancellingDeletion(true);
    setError(null);
    try {
      await updateProfile(id, {
        deletion_requested_at: null,
        deletion_requested_by: null,
      });
      try {
        await insertAuditLog({
          actor_id: adminUser.id,
          target_user_id: id,
          action: "deletion_request_cancelled",
          metadata: {},
        });
      } catch (auditErr) {
        console.warn("Failed to write audit_log entry:", friendlyError(auditErr));
      }
      const refreshed = await getProfile(id);
      setProfile(refreshed);
      await refreshAuditLog(id);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setCancellingDeletion(false);
    }
  }

  /** Force delete: immediate, irreversible, no consent from the target user.
   * Audit log is written *before* the backend call — once the account is
   * gone, an insert referencing it as target_user_id would fail the FK. */
  async function handleForceDelete() {
    if (!id || !adminUser || !session?.access_token) return;
    setForceDeleting(true);
    setError(null);
    try {
      try {
        await insertAuditLog({
          actor_id: adminUser.id,
          target_user_id: id,
          action: "user_force_deleted",
          metadata: { email: profile?.email ?? null },
        });
      } catch (auditErr) {
        console.warn("Failed to write audit_log entry:", friendlyError(auditErr));
      }
      await forceDeleteUser(id, session.access_token);
      navigate("/users");
    } catch (err) {
      setError(friendlyError(err));
      setForceDeleting(false);
    }
  }

  if (loading) {
    // Plan & credits, then the ban and delete cards.
    return <DetailPageSkeleton cards={[6, 2, 2, 2]} />;
  }

  if (!profile) {
    return <p className="text-body text-destructive">{error ?? t("User not found.")}</p>;
  }

  const online = isProfileOnline(profile.last_seen_at);
  const banned = isProfileBanned(profile);
  const supportBanned = isProfileSupportBanned(profile);
  const deletionRequested = !!profile.deletion_requested_at;

  return (
    <div className="max-w-[1800px]">
      <button
        type="button"
        onClick={() => navigate("/users")}
        className="mb-4 flex cursor-pointer items-center gap-1.5 text-caption font-medium text-fg-muted transition-colors hover:text-fg"
      >
        <ArrowLeft size={14} weight="bold" />
        {t("Back to Users")}</button>

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-h1 font-semibold text-fg">{profile.email ?? profile.display_name ?? profile.id}</h1>
        <StatusBadge label={t(profile.role)} tone={roleTone(profile.role)} />
        <span className="inline-flex items-center gap-1.5">
          <span className={cn("size-2 shrink-0 rounded-full", online ? "bg-success" : "bg-fg-subtle/40")} aria-hidden />
          <span className="text-caption text-fg-muted">{online ? t("Online now") : t("Offline")}</span>
        </span>
        {banned && <StatusBadge label={t("Banned")} tone="destructive" />}
        {supportBanned && <StatusBadge label={t("Support banned")} tone="destructive" />}
        {deletionRequested && <StatusBadge label={t("Deletion requested")} tone="warning" />}
      </div>
      <p className="mt-1 text-body text-fg-muted">
        {t("Joined")}{" "}{new Date(profile.created_at).toLocaleDateString(currentLocale())} · {profile.checks_used_this_period} {" "}{t("checks used this period")}{profile.last_seen_at && <> {" "}{t("· Last seen")}{" "}{new Date(profile.last_seen_at).toLocaleString(currentLocale())}</>}
      </p>

      {error && <p className="mt-4 text-caption text-destructive">{error}</p>}

      {/* Three columns on very wide screens: what the admin edits, the admin
          audit trail, and the user's activities log. Two below 2xl (the log
          drops underneath, full width) and one below xl, where the side-by-side
          plan fields would get cramped. */}
      <div className="mt-6 grid items-start gap-6 xl:grid-cols-2 2xl:grid-cols-3">
        <div className="space-y-6">
          <div className="space-y-5 rounded-card border border-border bg-surface p-6 shadow-card">
            <h2 className="text-h2 font-semibold text-fg">{t("Plan & credits")}</h2>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="mb-1.5 block text-caption font-medium text-fg-muted">{t("Plan tier")}</label>
                <select
                  value={planTier}
                  onChange={(e) => setPlanTier(e.target.value as PlanTier)}
                  className="w-full rounded-control border border-border bg-surface-muted px-3 py-2 text-body text-fg outline-none focus-visible:border-accent"
                >
                  {PLAN_OPTIONS.map((p) => (
                    <option key={p} value={p}>
                      {planLabel(p)}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1.5 block text-caption font-medium text-fg-muted">{t("Billing cycle")}</label>
                <select
                  value={billingCycle}
                  onChange={(e) => setBillingCycle(e.target.value as BillingCycle)}
                  className="w-full rounded-control border border-border bg-surface-muted px-3 py-2 text-body text-fg outline-none focus-visible:border-accent"
                >
                  {BILLING_OPTIONS.map((b) => (
                    <option key={b} value={b}>
                      {billingCycleLabel(b)}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1.5 block text-caption font-medium text-fg-muted">{t("Plan ends")}</label>
                <input
                  type="date"
                  value={planTier === "free" ? "" : planEnds}
                  disabled={planTier === "free"}
                  onChange={(e) => setPlanEnds(e.target.value)}
                  className="w-full rounded-control border border-border bg-surface-muted px-3 py-2 text-body text-fg outline-none focus-visible:border-accent disabled:opacity-50"
                />
                <p className="mt-1 text-caption text-fg-subtle">
                  {planTier === "free" ? t("Free has no end date.") : t("End of that day, Vietnam time. Leave blank for no end date.")}
                </p>
              </div>

              <div>
                <label className="mb-1.5 block text-caption font-medium text-fg-muted">{t("Standard credits")}</label>
                <input
                  type="number"
                  min={0}
                  value={standardCredits}
                  onChange={(e) => setStandardCredits(Number(e.target.value))}
                  className="w-full rounded-control border border-border bg-surface-muted px-3 py-2 text-body text-fg outline-none focus-visible:border-accent"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-caption font-medium text-fg-muted">{t("Premium credits")}</label>
                <input
                  type="number"
                  min={0}
                  value={premiumCredits}
                  onChange={(e) => setPremiumCredits(Number(e.target.value))}
                  className="w-full rounded-control border border-border bg-surface-muted px-3 py-2 text-body text-fg outline-none focus-visible:border-accent"
                />
              </div>

              <div className="flex items-end">
                {/* Same height as the inputs beside it (border + py-2), so the switch
                    lines up with the Premium credits field. A <label> forwards clicks
                    on the text to the switch button. */}
                <label className="flex cursor-pointer items-center gap-2.5 border border-transparent py-2 text-body text-fg">
                  <Switch checked={studentVerified} onChange={setStudentVerified} />
                  {t("Student verified")}
                </label>
              </div>
            </div>

            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="cursor-pointer rounded-control bg-accent px-4 py-2 text-body font-semibold text-bg transition hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? t("Saving…") : t("Save changes")}
            </button>
          </div>

          <div className="space-y-4 rounded-card border border-border bg-surface p-6 shadow-card">
            <div className="flex items-center gap-2">
              <ShieldWarning size={18} weight="bold" className="text-fg-muted" />
              <h2 className="text-h2 font-semibold text-fg">{t("Ban")}</h2>
            </div>

            {banned ? (
              <div className="rounded-control border border-destructive/40 bg-destructive-bg p-3.5">
                <p className="text-body font-medium text-destructive">
                  {profile.banned_permanent ? t("Banned permanently") : t("Banned until {{n}}", { n: new Date(profile.banned_until!).toLocaleString(currentLocale()) })}
                </p>
                {profile.ban_reason && <p className="mt-1 text-caption text-destructive/90">"{profile.ban_reason}"</p>}
                <button
                  type="button"
                  onClick={() => handleUnban("account")}
                  disabled={unbanSubmitting !== null}
                  className="mt-3 cursor-pointer rounded-control border border-destructive/40 bg-surface px-3.5 py-1.5 text-caption font-semibold text-destructive transition hover:bg-destructive-bg active:scale-95 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {unbanSubmitting === "account" ? t("Unbanning…") : t("Unban user")}
                </button>
              </div>
            ) : (
              <>
                <p className="text-body text-fg-muted">
                  {t("Banning signs this user out immediately and blocks sign-in until unbanned. They'll see your message.")}</p>
                <button
                  type="button"
                  onClick={() => openBanModal("account")}
                  className="flex cursor-pointer items-center gap-1.5 rounded-control border border-destructive/40 bg-destructive-bg px-3.5 py-1.5 text-caption font-semibold text-destructive transition hover:opacity-90 active:scale-95"
                >
                  <Prohibit size={14} weight="bold" />
                  {t("Ban user")}</button>
              </>
            )}
          </div>

          <div className="space-y-4 rounded-card border border-border bg-surface p-6 shadow-card">
            <div className="flex items-center gap-2">
              <ChatCircleSlash size={18} weight="bold" className="text-fg-muted" />
              <h2 className="text-h2 font-semibold text-fg">{t("Support ban")}</h2>
            </div>

            {supportBanned ? (
              <div className="rounded-control border border-destructive/40 bg-destructive-bg p-3.5">
                <p className="text-body font-medium text-destructive">
                  {profile.support_banned_permanent
                    ? t("Banned from support permanently")
                    : t("Banned from support until {{n}}", { n: new Date(profile.support_banned_until!).toLocaleString(currentLocale()) })}
                </p>
                {profile.support_ban_reason && <p className="mt-1 text-caption text-destructive/90">"{profile.support_ban_reason}"</p>}
                <button
                  type="button"
                  onClick={() => handleUnban("support")}
                  disabled={unbanSubmitting !== null}
                  className="mt-3 cursor-pointer rounded-control border border-destructive/40 bg-surface px-3.5 py-1.5 text-caption font-semibold text-destructive transition hover:bg-destructive-bg active:scale-95 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {unbanSubmitting === "support" ? t("Lifting…") : t("Lift support ban")}
                </button>
              </div>
            ) : (
              <>
                <p className="text-body text-fg-muted">
                  {t("Stops this user from opening or replying to support tickets, on the site or by email. The rest of their account keeps working. They'll see your message.")}</p>
                <button
                  type="button"
                  onClick={() => openBanModal("support")}
                  className="flex cursor-pointer items-center gap-1.5 rounded-control border border-destructive/40 bg-destructive-bg px-3.5 py-1.5 text-caption font-semibold text-destructive transition hover:opacity-90 active:scale-95"
                >
                  <Prohibit size={14} weight="bold" />
                  {t("Ban from support")}</button>
              </>
            )}
          </div>

          <div className="space-y-4 rounded-card border border-border bg-surface p-6 shadow-card">
            <div className="flex items-center gap-2">
              <TrashSimple size={18} weight="bold" className="text-fg-muted" />
              <h2 className="text-h2 font-semibold text-fg">{t("Delete account")}</h2>
            </div>

            {deletionRequested ? (
              <div className="rounded-control border border-warning/40 bg-warning-bg p-3.5">
                <p className="text-body font-medium text-warning">
                  {t("Deletion requested")}{" "}{new Date(profile.deletion_requested_at!).toLocaleString(currentLocale())}
                </p>
                <p className="mt-1 text-caption text-warning/90">
                  {t("Waiting for the user to confirm from their account — nothing is deleted until they click confirm.")}</p>
                <button
                  type="button"
                  onClick={handleCancelDeletionRequest}
                  disabled={cancellingDeletion}
                  className="mt-3 cursor-pointer rounded-control border border-border bg-surface px-3.5 py-1.5 text-caption font-semibold text-fg transition hover:bg-surface-raised active:scale-95 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {cancellingDeletion ? t("Cancelling…") : t("Cancel deletion request")}
                </button>
              </div>
            ) : (
              <div>
                <p className="text-body text-fg-muted">
                  {t("Requesting deletion prompts the user to confirm in their own account before anything is removed.")}</p>
                <button
                  type="button"
                  onClick={handleRequestDeletion}
                  disabled={requestingDeletion}
                  className="mt-3 cursor-pointer rounded-control border border-border px-3.5 py-1.5 text-caption font-semibold text-fg-muted transition hover:bg-surface-raised active:scale-95 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {requestingDeletion ? t("Requesting…") : t("Request deletion")}
                </button>
              </div>
            )}

            <div className="border-t border-border pt-4">
              <p className="text-body text-fg-muted">
                {t("Force delete removes the account and all its data immediately —")}{" "}
                <span className="font-semibold text-fg">{t("no confirmation from the user, cannot be undone.")}</span>
              </p>
              <button
                type="button"
                onClick={() => {
                  setForceDeleteConfirmText("");
                  setForceDeleteModalOpen(true);
                }}
                className="mt-3 flex cursor-pointer items-center gap-1.5 rounded-control border border-destructive/40 bg-destructive-bg px-3.5 py-1.5 text-caption font-semibold text-destructive transition hover:opacity-90 active:scale-95"
              >
                <TrashSimple size={14} weight="bold" />
                {t("Force delete account")}</button>
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="space-y-4 rounded-card border border-border bg-surface p-6 shadow-card">
            <div className="flex items-center gap-2">
              <ClockCounterClockwise size={18} weight="bold" className="text-fg-muted" />
              <h2 className="text-h2 font-semibold text-fg">{t("Audit trail")}</h2>
            </div>

            {auditLoading ? (
              <ListItemsSkeleton />
            ) : auditLog.length === 0 ? (
              <p className="text-body text-fg-muted">{t("No audit events recorded for this user yet.")}</p>
            ) : (
              <ul className="space-y-3">
                {auditLog.map((entry) => {
                  const metadata = entry.metadata ?? {};
                  const before = (metadata.before ?? {}) as Record<string, unknown>;
                  const after = (metadata.after ?? {}) as Record<string, unknown>;
                  const changedFields = Object.keys(after);

                  return (
                    <li key={entry.id} className="rounded-control border border-border bg-surface-muted p-3">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-body font-medium text-fg">
                          {t(ACTION_LABELS[entry.action] ?? entry.action)}
                        </span>
                        <span className="text-caption text-fg-muted">
                          {new Date(entry.created_at).toLocaleString(currentLocale())}
                        </span>
                      </div>
                      {entry.actor_id && (
                        <p className="mt-0.5 text-caption text-fg-muted">
                          {t("By")}{" "}{entry.actor_id === adminUser?.id ? "you" : entry.actor_id}
                        </p>
                      )}
                      {changedFields.length > 0 && (
                        <ul className="mt-2 space-y-1">
                          {changedFields.map((field) => (
                            <li key={field} className="text-caption text-fg-muted">
                              <span className="font-medium text-fg">{t(FIELD_LABELS[field] ?? field)}</span>:{" "}
                              {formatAuditValue(before[field])} → {formatAuditValue(after[field])}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        <div className="xl:col-span-2 2xl:col-span-1">
          <UserActivityLog userId={profile.id} adminId={adminUser?.id} refreshKey={activityVersion} />
        </div>
      </div>

      {banModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
          onClick={() => !banSubmitting && setBanModalOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-card border border-border bg-surface shadow-pop"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
              <p className="text-body font-medium text-fg">{banTarget === "account" ? t("Ban user") : t("Ban from support")}</p>
              <button
                type="button"
                onClick={() => setBanModalOpen(false)}
                title={t("Close")}
                className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-control text-fg-muted transition hover:bg-surface-raised active:scale-95"
              >
                <X size={16} weight="bold" />
              </button>
            </div>
            <div className="space-y-4 p-5">
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => setBanMode("permanent")}
                  className={cn(
                    "flex-1 cursor-pointer rounded-control border px-3 py-2 text-caption font-medium transition",
                    banMode === "permanent"
                      ? "border-destructive/40 bg-destructive-bg text-destructive"
                      : "border-border text-fg-muted hover:bg-surface-raised",
                  )}
                >
                  {t("Permanent")}</button>
                <button
                  type="button"
                  onClick={() => setBanMode("until")}
                  className={cn(
                    "flex-1 cursor-pointer rounded-control border px-3 py-2 text-caption font-medium transition",
                    banMode === "until"
                      ? "border-destructive/40 bg-destructive-bg text-destructive"
                      : "border-border text-fg-muted hover:bg-surface-raised",
                  )}
                >
                  {t("For a period")}</button>
              </div>

              {banMode === "until" && (
                <div>
                  <label className="mb-1.5 block text-caption font-medium text-fg-muted">{t("Banned until")}</label>
                  <input
                    type="datetime-local"
                    value={banUntilInput}
                    onChange={(e) => setBanUntilInput(e.target.value)}
                    className="w-full rounded-control border border-border bg-surface-muted px-3 py-2 text-body text-fg outline-none focus-visible:border-accent"
                  />
                </div>
              )}

              <div>
                <label className="mb-1.5 block text-caption font-medium text-fg-muted">
                  {t("Message shown to the user")}</label>
                <textarea
                  value={banReasonInput}
                  onChange={(e) => setBanReasonInput(e.target.value)}
                  rows={3}
                  placeholder={
                    banTarget === "account"
                      ? t("Explain why this account is banned…")
                      : t("Explain why this account can't contact support…")
                  }
                  className="w-full resize-none rounded-control border border-border bg-surface-muted px-3 py-2 text-body text-fg outline-none focus-visible:border-accent"
                />
              </div>

              <button
                type="button"
                onClick={handleSubmitBan}
                disabled={banSubmitting || (banMode === "until" && !banUntilInput)}
                className="w-full cursor-pointer rounded-control bg-destructive px-4 py-2 text-body font-semibold text-white transition hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {banSubmitting ? t("Banning…") : banTarget === "account" ? t("Ban user") : t("Ban from support")}
              </button>
            </div>
          </div>
        </div>
      )}

      {forceDeleteModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
          onClick={() => !forceDeleting && setForceDeleteModalOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-card border border-border bg-surface shadow-pop"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
              <p className="text-body font-medium text-destructive">{t("Force delete account")}</p>
              <button
                type="button"
                onClick={() => setForceDeleteModalOpen(false)}
                title={t("Close")}
                className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-control text-fg-muted transition hover:bg-surface-raised active:scale-95"
              >
                <X size={16} weight="bold" />
              </button>
            </div>
            <div className="space-y-4 p-5">
              <p className="text-body text-fg-muted">
                {t("This immediately and permanently deletes")}{" "}
                <span className="font-semibold text-fg">{profile.email ?? profile.id}</span> {" "}{t("and all their data. The user is not asked for consent. This cannot be undone.")}</p>
              <div>
                <label className="mb-1.5 block text-caption font-medium text-fg-muted">
                  {t("Type")}{" "}{DELETE_CONFIRM_PHRASE} {" "}{t("to confirm")}</label>
                <input
                  value={forceDeleteConfirmText}
                  onChange={(e) => setForceDeleteConfirmText(e.target.value)}
                  placeholder={DELETE_CONFIRM_PHRASE}
                  className="w-full rounded-control border border-border bg-surface-muted px-3 py-2 text-body text-fg outline-none focus-visible:border-destructive"
                />
              </div>
              <button
                type="button"
                onClick={handleForceDelete}
                disabled={forceDeleting || forceDeleteConfirmText !== DELETE_CONFIRM_PHRASE}
                className="w-full cursor-pointer rounded-control bg-destructive px-4 py-2 text-body font-semibold text-white transition hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {forceDeleting ? t("Deleting…") : t("Permanently delete account")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
