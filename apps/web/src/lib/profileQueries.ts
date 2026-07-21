// Fetches the signed-in user's own `profiles` row. Surfaces the fields the UI
// actually reflects (plan/usage/verification) plus the closed-beta access
// fields the client-side route guard needs.
//
// `role` and `accessStatus` are read here purely to decide *which screen to
// render* (app vs. /waitlist). They are a UI convenience, never an
// authorization boundary — RLS and the backend remain the real gate, and a
// user tampering with these client-side only changes what they see, not what
// they can do.
import { supabase } from "@etymos/shared";
import type { AccessStatus, BillingCycle, PlanTier } from "@etymos/shared";

export interface MyProfile {
  plan: PlanTier;
  billingCycle: BillingCycle | null;
  standardCredits: number;
  premiumCredits: number;
  checksUsedThisPeriod: number;
  planPeriodStart: string;
  studentVerified: boolean;
  accessStatus: AccessStatus;
  accessRequestedAt: string | null;
  accessReviewedAt: string | null;
  accessNote: string | null;
  role: "user" | "admin";
}

interface ProfileRow {
  plan_tier: PlanTier;
  billing_cycle: BillingCycle | null;
  standard_credits: number;
  premium_credits: number;
  checks_used_this_period: number;
  plan_period_start: string;
  student_verified: boolean;
  access_status: AccessStatus | null;
  access_requested_at: string | null;
  access_reviewed_at: string | null;
  access_note: string | null;
  role: "user" | "admin" | null;
}

export async function fetchMyProfile(userId: string): Promise<MyProfile> {
  const { data, error } = await supabase
    .from("profiles")
    .select(
      "plan_tier, billing_cycle, standard_credits, premium_credits, checks_used_this_period, plan_period_start, student_verified, access_status, access_requested_at, access_reviewed_at, access_note, role",
    )
    .eq("id", userId)
    .single();
  if (error) throw error;

  const row = data as ProfileRow;
  return {
    plan: row.plan_tier,
    billingCycle: row.billing_cycle,
    standardCredits: row.standard_credits,
    premiumCredits: row.premium_credits,
    checksUsedThisPeriod: row.checks_used_this_period,
    planPeriodStart: row.plan_period_start,
    studentVerified: row.student_verified,
    // Fail closed: an unexpected/absent value is treated as not-yet-approved
    // rather than silently granting access.
    accessStatus: row.access_status ?? "waitlisted",
    accessRequestedAt: row.access_requested_at,
    accessReviewedAt: row.access_reviewed_at,
    accessNote: row.access_note,
    role: row.role ?? "user",
  };
}
