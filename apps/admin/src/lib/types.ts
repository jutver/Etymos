export type AdminRole = "user" | "admin";
export type PlanTier = "free" | "student" | "professional";
export type BillingCycle = "monthly" | "annual";

export interface Profile {
  id: string;
  email: string | null;
  display_name: string | null;
  role: AdminRole;
  plan_tier: PlanTier;
  billing_cycle: BillingCycle | null;
  credits: number;
  checks_used_this_period: number;
  plan_period_start: string;
  student_verified: boolean;
  created_at: string;
  updated_at: string;
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
