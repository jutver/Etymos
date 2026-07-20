import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ClockCounterClockwise } from "@phosphor-icons/react";
import { StatusBadge, roleTone } from "../../components/StatusBadge";
import { Switch } from "../../components/Switch";
import {
  getProfile,
  insertAuditLog,
  listAuditLogForUser,
  updateProfile,
  type AuditLogEntry,
} from "../../lib/supabaseQueries";
import type { BillingCycle, PlanTier, Profile } from "../../lib/types";
import { friendlyError } from "../../lib/errors";
import { useAdminAuth } from "../../lib/auth";

const PLAN_OPTIONS: PlanTier[] = ["free", "student", "professional"];
const BILLING_OPTIONS: BillingCycle[] = ["monthly", "annual"];

const FIELD_LABELS: Record<string, string> = {
  plan_tier: "Plan tier",
  billing_cycle: "Billing cycle",
  standard_credits: "Standard credits",
  premium_credits: "Premium credits",
  student_verified: "Student verified",
};

const ACTION_LABELS: Record<string, string> = {
  profile_updated: "Profile updated",
};

function formatAuditValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

type EditableProfileFields = Pick<
  Profile,
  "plan_tier" | "billing_cycle" | "standard_credits" | "premium_credits" | "student_verified"
>;

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

export default function UserDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user: adminUser } = useAdminAuth();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [planTier, setPlanTier] = useState<PlanTier>("free");
  const [billingCycle, setBillingCycle] = useState<BillingCycle>("monthly");
  const [standardCredits, setStandardCredits] = useState(0);
  const [premiumCredits, setPremiumCredits] = useState(0);
  const [studentVerified, setStudentVerified] = useState(false);

  const [auditLog, setAuditLog] = useState<AuditLogEntry[]>([]);
  const [auditLoading, setAuditLoading] = useState(true);

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
        standard_credits: profile.standard_credits,
        premium_credits: profile.premium_credits,
        student_verified: profile.student_verified,
      };
      const after: EditableProfileFields = {
        plan_tier: planTier,
        billing_cycle: billingCycle,
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

  if (loading) {
    return <p className="text-body text-fg-muted">Loading…</p>;
  }

  if (!profile) {
    return <p className="text-body text-destructive">{error ?? "User not found."}</p>;
  }

  return (
    <div className="max-w-2xl">
      <button
        type="button"
        onClick={() => navigate("/users")}
        className="mb-4 flex cursor-pointer items-center gap-1.5 text-caption font-medium text-fg-muted transition-colors hover:text-fg"
      >
        <ArrowLeft size={14} weight="bold" />
        Back to Users
      </button>

      <div className="flex items-center gap-3">
        <h1 className="text-h1 font-semibold text-fg">{profile.email ?? profile.display_name ?? profile.id}</h1>
        <StatusBadge label={profile.role} tone={roleTone(profile.role)} />
      </div>
      <p className="mt-1 text-body text-fg-muted">
        Joined {new Date(profile.created_at).toLocaleDateString()} · {profile.checks_used_this_period} checks used this period
      </p>

      <div className="mt-6 space-y-5 rounded-card border border-border bg-surface p-6 shadow-card">
        <h2 className="text-h2 font-semibold text-fg">Plan & credits</h2>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="mb-1.5 block text-caption font-medium text-fg-muted">Plan tier</label>
            <select
              value={planTier}
              onChange={(e) => setPlanTier(e.target.value as PlanTier)}
              className="w-full rounded-control border border-border bg-surface-muted px-3 py-2 text-body text-fg outline-none focus-visible:border-accent"
            >
              {PLAN_OPTIONS.map((p) => (
                <option key={p} value={p} className="capitalize">
                  {p}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1.5 block text-caption font-medium text-fg-muted">Billing cycle</label>
            <select
              value={billingCycle}
              onChange={(e) => setBillingCycle(e.target.value as BillingCycle)}
              className="w-full rounded-control border border-border bg-surface-muted px-3 py-2 text-body text-fg outline-none focus-visible:border-accent"
            >
              {BILLING_OPTIONS.map((b) => (
                <option key={b} value={b} className="capitalize">
                  {b}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1.5 block text-caption font-medium text-fg-muted">Standard credits</label>
            <input
              type="number"
              min={0}
              value={standardCredits}
              onChange={(e) => setStandardCredits(Number(e.target.value))}
              className="w-full rounded-control border border-border bg-surface-muted px-3 py-2 text-body text-fg outline-none focus-visible:border-accent"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-caption font-medium text-fg-muted">Premium credits</label>
            <input
              type="number"
              min={0}
              value={premiumCredits}
              onChange={(e) => setPremiumCredits(Number(e.target.value))}
              className="w-full rounded-control border border-border bg-surface-muted px-3 py-2 text-body text-fg outline-none focus-visible:border-accent"
            />
          </div>

          <div className="flex items-end">
            <div className="flex items-center gap-2.5">
              <Switch checked={studentVerified} onChange={setStudentVerified} />
              <span className="text-body text-fg">Student verified</span>
            </div>
          </div>
        </div>

        {error && <p className="text-caption text-destructive">{error}</p>}

        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="cursor-pointer rounded-control bg-accent px-4 py-2 text-body font-semibold text-bg transition hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>

      <div className="mt-6 space-y-4 rounded-card border border-border bg-surface p-6 shadow-card">
        <div className="flex items-center gap-2">
          <ClockCounterClockwise size={18} weight="bold" className="text-fg-muted" />
          <h2 className="text-h2 font-semibold text-fg">Audit trail</h2>
        </div>

        {auditLoading ? (
          <p className="text-body text-fg-muted">Loading…</p>
        ) : auditLog.length === 0 ? (
          <p className="text-body text-fg-muted">No audit events recorded for this user yet.</p>
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
                      {ACTION_LABELS[entry.action] ?? entry.action}
                    </span>
                    <span className="text-caption text-fg-muted">
                      {new Date(entry.created_at).toLocaleString()}
                    </span>
                  </div>
                  {entry.actor_id && (
                    <p className="mt-0.5 text-caption text-fg-muted">
                      By {entry.actor_id === adminUser?.id ? "you" : entry.actor_id}
                    </p>
                  )}
                  {changedFields.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {changedFields.map((field) => (
                        <li key={field} className="text-caption text-fg-muted">
                          <span className="font-medium text-fg">{FIELD_LABELS[field] ?? field}</span>:{" "}
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
  );
}
