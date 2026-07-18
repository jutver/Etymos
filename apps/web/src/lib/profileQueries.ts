// Fetches the signed-in user's own `profiles` row. Only surface fields the
// UI actually reflects (plan/usage/verification) — never role, which is an
// authorization concern the frontend has no business reading or trusting.
import { supabase } from "@etymos/shared";
import type { BillingCycle, PlanTier } from "@etymos/shared";

export interface MyProfile {
  plan: PlanTier;
  billingCycle: BillingCycle | null;
  credits: number;
  checksUsedThisPeriod: number;
  planPeriodStart: string;
  studentVerified: boolean;
}

interface ProfileRow {
  plan_tier: PlanTier;
  billing_cycle: BillingCycle | null;
  credits: number;
  checks_used_this_period: number;
  plan_period_start: string;
  student_verified: boolean;
}

export async function fetchMyProfile(userId: string): Promise<MyProfile> {
  const { data, error } = await supabase
    .from("profiles")
    .select("plan_tier, billing_cycle, credits, checks_used_this_period, plan_period_start, student_verified")
    .eq("id", userId)
    .single();
  if (error) throw error;

  const row = data as ProfileRow;
  return {
    plan: row.plan_tier,
    billingCycle: row.billing_cycle,
    credits: row.credits,
    checksUsedThisPeriod: row.checks_used_this_period,
    planPeriodStart: row.plan_period_start,
    studentVerified: row.student_verified,
  };
}
