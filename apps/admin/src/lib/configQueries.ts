import { supabase } from "@etymos/shared";
import type { AdminCreditPack, AdminPlanDefinition, Announcement, FeatureFlag } from "./types";

export async function listFeatureFlags(): Promise<FeatureFlag[]> {
  const { data, error } = await supabase.from("feature_flags").select("*").order("key");
  if (error) throw error;
  return data ?? [];
}

export async function setFeatureFlagEnabled(key: string, enabled: boolean, adminId: string): Promise<void> {
  const { error } = await supabase
    .from("feature_flags")
    .update({ enabled, updated_by: adminId })
    .eq("key", key);
  if (error) throw error;
}

export async function listPlanDefinitions(): Promise<AdminPlanDefinition[]> {
  const { data, error } = await supabase.from("plan_definitions").select("*").order("sort_order");
  if (error) throw error;
  return data ?? [];
}

export async function updatePlanDefinition(
  id: string,
  patch: Partial<Pick<AdminPlanDefinition, "price_monthly" | "price_annual" | "doc_limit" | "word_limit">>,
): Promise<void> {
  const { error } = await supabase.from("plan_definitions").update(patch).eq("id", id);
  if (error) throw error;
}

export async function listCreditPacks(): Promise<AdminCreditPack[]> {
  const { data, error } = await supabase.from("credit_packs").select("*").order("sort_order");
  if (error) throw error;
  return data ?? [];
}

export async function updateCreditPack(
  id: string,
  patch: Partial<Pick<AdminCreditPack, "price" | "checks">>,
): Promise<void> {
  const { error } = await supabase.from("credit_packs").update(patch).eq("id", id);
  if (error) throw error;
}

export async function listAnnouncements(): Promise<Announcement[]> {
  const { data, error } = await supabase
    .from("announcements")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function createAnnouncement(
  input: Pick<Announcement, "message" | "severity">,
  adminId: string,
): Promise<void> {
  const { error } = await supabase
    .from("announcements")
    .insert({ ...input, is_active: true, created_by: adminId });
  if (error) throw error;
}

export async function setAnnouncementActive(id: string, isActive: boolean): Promise<void> {
  const { error } = await supabase.from("announcements").update({ is_active: isActive }).eq("id", id);
  if (error) throw error;
}
