export type AdminRole = "user" | "admin";
export type PlanTier = "free" | "student" | "professional";
export type BillingCycle = "monthly" | "annual";
/** Gate on whether a signed-up user may actually use the app (item 3 waitlist). */
export type AccessStatus = "waitlisted" | "approved" | "rejected";

export interface Profile {
  id: string;
  email: string | null;
  display_name: string | null;
  role: AdminRole;
  plan_tier: PlanTier;
  billing_cycle: BillingCycle | null;
  standard_credits: number;
  premium_credits: number;
  checks_used_this_period: number;
  plan_period_start: string;
  student_verified: boolean;
  access_status: AccessStatus;
  access_requested_at: string | null;
  access_reviewed_at: string | null;
  access_reviewed_by: string | null;
  access_note: string | null;
  /** Presence heartbeat — written by the web app every ~60s while a user has
   * it open (see apps/web/src/lib/auth.tsx). Null means "never seen". */
  last_seen_at: string | null;
  banned_permanent: boolean;
  banned_until: string | null;
  ban_reason: string | null;
  banned_by: string | null;
  deletion_requested_at: string | null;
  deletion_requested_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Presence threshold: a user is considered "online" if their last heartbeat
 * was within this window. 2 minutes comfortably covers the ~60s heartbeat
 * interval plus one missed beat before flipping to offline. */
export const ONLINE_THRESHOLD_MS = 2 * 60 * 1000;

export function isProfileOnline(lastSeenAt: string | null): boolean {
  if (!lastSeenAt) return false;
  return Date.now() - new Date(lastSeenAt).getTime() < ONLINE_THRESHOLD_MS;
}

export function isProfileBanned(p: Pick<Profile, "banned_permanent" | "banned_until">): boolean {
  if (p.banned_permanent) return true;
  if (p.banned_until) return new Date(p.banned_until).getTime() > Date.now();
  return false;
}

export type ModerationStatus = "none" | "flagged" | "removed";
export type DocStatus = "clean" | "low" | "moderate" | "high";

export interface AdminDocument {
  id: string;
  user_id: string;
  title: string | null;
  file_name: string | null;
  status: DocStatus | null;
  similarity_score: number | null;
  moderation_status: ModerationStatus;
  moderation_notes: string | null;
  is_trashed: boolean;
  uploaded_at: string;
  profiles?: Pick<Profile, "id" | "email" | "display_name"> | null;
}

export interface FeatureFlag {
  key: string;
  label: string;
  description: string | null;
  enabled: boolean;
  updated_at: string;
  updated_by: string | null;
}

export interface AdminPlanDefinition {
  id: PlanTier;
  name: string;
  tagline: string | null;
  price_monthly: number;
  price_annual: number;
  audience: string | null;
  most_popular: boolean;
  requires_verification: boolean;
  features: string[];
  doc_limit: number | null;
  word_limit: number | null;
  sort_order: number;
  updated_at: string;
}

export interface AdminCreditPack {
  id: string;
  label: string;
  description: string | null;
  checks: number;
  price: number;
  badge: string | null;
  sort_order: number;
  updated_at: string;
}

export type DiscountType = "percent" | "fixed";

export interface AdminPlanDiscount {
  id: string;
  target_type: "plan" | "pack";
  target_id: string;
  discount_type: DiscountType;
  amount: number;
  starts_at: string | null;
  ends_at: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface AdminDiscountCode {
  id: string;
  code: string;
  discount_type: DiscountType;
  amount: number;
  starts_at: string | null;
  ends_at: string | null;
  max_redemptions: number | null;
  redemption_count: number;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export type AnnouncementSeverity = "info" | "warning" | "success" | "error";

export interface Announcement {
  id: string;
  message: string;
  severity: AnnouncementSeverity;
  is_active: boolean;
  starts_at: string | null;
  ends_at: string | null;
  created_by: string | null;
  created_at: string;
}
