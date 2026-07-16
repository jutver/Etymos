import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft } from "@phosphor-icons/react";
import { StatusBadge, roleTone } from "../../components/StatusBadge";
import { Switch } from "../../components/Switch";
import { getProfile, updateProfile } from "../../lib/supabaseQueries";
import type { BillingCycle, PlanTier, Profile } from "../../lib/types";
import { friendlyError } from "../../lib/errors";

const PLAN_OPTIONS: PlanTier[] = ["free", "student", "professional"];
const BILLING_OPTIONS: BillingCycle[] = ["monthly", "annual"];

export default function UserDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [planTier, setPlanTier] = useState<PlanTier>("free");
  const [billingCycle, setBillingCycle] = useState<BillingCycle>("monthly");
  const [credits, setCredits] = useState(0);
  const [studentVerified, setStudentVerified] = useState(false);

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
        setCredits(p.credits);
        setStudentVerified(p.student_verified);
      })
      .catch((err: unknown) => !cancelled && setError(friendlyError(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function handleSave() {
    if (!id) return;
    setSaving(true);
    setError(null);
    try {
      await updateProfile(id, {
        plan_tier: planTier,
        billing_cycle: billingCycle,
        credits,
        student_verified: studentVerified,
      });
      const refreshed = await getProfile(id);
      setProfile(refreshed);
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

      <div className="mt-6 space-y-5 rounded-card border border-border bg-surface p-6">
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
            <label className="mb-1.5 block text-caption font-medium text-fg-muted">Credits</label>
            <input
              type="number"
              min={0}
              value={credits}
              onChange={(e) => setCredits(Number(e.target.value))}
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
    </div>
  );
}
