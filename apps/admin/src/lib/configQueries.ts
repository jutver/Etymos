import { ANNOUNCEMENT_IMAGE_BUCKET, supabase } from "@etymos/shared";
import { sanitizeSearch } from "./supabaseQueries";
import type {
  AdminCreditPack,
  AdminDiscountCode,
  AdminPlanDefinition,
  AdminPlanDiscount,
  Announcement,
  FeatureFlag,
} from "./types";

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
  patch: Partial<Pick<AdminPlanDefinition, "price_monthly" | "price_annual" | "doc_limit" | "word_limit" | "recheck_free_limit" | "recheck_change_limit">>,
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
  return (data ?? []) as Announcement[];
}

/** The fields the editor sets. */
export type AnnouncementInput = Pick<
  Announcement,
  | "kind"
  | "title"
  | "message"
  | "title_vi"
  | "message_vi"
  | "severity"
  | "icon"
  | "countdown_to"
  | "image_path"
  | "starts_at"
  | "ends_at"
  | "is_active"
  | "audience"
  | "audience_plans"
>;

/** Returns the new announcement's id. */
export async function createAnnouncement(input: AnnouncementInput, adminId: string): Promise<string> {
  const { data, error } = await supabase
    .from("announcements")
    .insert({ ...input, created_by: adminId })
    .select("id")
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

export async function updateAnnouncement(id: string, patch: Partial<AnnouncementInput>): Promise<void> {
  const { error } = await supabase.from("announcements").update(patch).eq("id", id);
  if (error) throw error;
}

export async function setAnnouncementActive(id: string, isActive: boolean): Promise<void> {
  await updateAnnouncement(id, { is_active: isActive });
}

export async function deleteAnnouncement(a: Pick<Announcement, "id" | "image_path">): Promise<void> {
  const { error } = await supabase.from("announcements").delete().eq("id", a.id);
  if (error) throw error;
  if (a.image_path) await removeAnnouncementImage(a.image_path);
}

/** Each announcement's email list, keyed by announcement id: who sees a top
 * bar or pop-up aimed at chosen people, or who gets through maintenance. */
export async function listAnnouncementEmails(): Promise<Map<string, string[]>> {
  const { data, error } = await supabase.from("announcement_emails").select("announcement_id, email").order("email");
  if (error) throw error;
  const byId = new Map<string, string[]>();
  for (const row of (data ?? []) as { announcement_id: string; email: string }[]) {
    byId.set(row.announcement_id, [...(byId.get(row.announcement_id) ?? []), row.email]);
  }
  return byId;
}

/** Replaces an announcement's email list. */
export async function setAnnouncementEmails(announcementId: string, emails: string[]): Promise<void> {
  const { error } = await supabase.rpc("set_announcement_emails", { p_announcement: announcementId, p_emails: emails });
  if (error) throw error;
}

const IMAGE_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
export const ANNOUNCEMENT_IMAGE_TYPES = Object.keys(IMAGE_EXT);
export const ANNOUNCEMENT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** Uploads a pop-up image to the public bucket and returns its path. */
export async function uploadAnnouncementImage(file: File): Promise<string> {
  const path = `${crypto.randomUUID()}.${IMAGE_EXT[file.type] ?? "img"}`;
  const { error } = await supabase.storage
    .from(ANNOUNCEMENT_IMAGE_BUCKET)
    .upload(path, file, { contentType: file.type, cacheControl: "31536000" });
  if (error) throw error;
  return path;
}

/** Best effort: a leftover image costs a little storage, nothing more. */
export async function removeAnnouncementImage(path: string): Promise<void> {
  const { error } = await supabase.storage.from(ANNOUNCEMENT_IMAGE_BUCKET).remove([path]);
  if (error) console.warn("Couldn't remove announcement image", path, error);
}

export async function listPlanDiscounts(): Promise<AdminPlanDiscount[]> {
  const { data, error } = await supabase
    .from("plan_discounts")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

/** The fields an admin sets on an automatic discount. */
export type PlanDiscountInput = Omit<AdminPlanDiscount, "id" | "created_at" | "updated_at">;

export async function createPlanDiscount(input: PlanDiscountInput): Promise<void> {
  const { error } = await supabase.from("plan_discounts").insert(input);
  if (error) throw error;
}

export async function updatePlanDiscount(id: string, patch: Partial<PlanDiscountInput>): Promise<void> {
  const { error } = await supabase.from("plan_discounts").update(patch).eq("id", id);
  if (error) throw error;
}

export async function deletePlanDiscount(id: string): Promise<void> {
  const { error } = await supabase.from("plan_discounts").delete().eq("id", id);
  if (error) throw error;
}

export async function listDiscountCodes(): Promise<AdminDiscountCode[]> {
  const { data, error } = await supabase
    .from("discount_codes")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

/** The fields an admin sets on a discount code. */
export type DiscountCodeInput = Omit<AdminDiscountCode, "id" | "redemption_count" | "created_at" | "updated_at">;

export async function createDiscountCode(input: DiscountCodeInput): Promise<void> {
  const { error } = await supabase.from("discount_codes").insert(input);
  if (error) throw error;
}

export async function updateDiscountCode(id: string, patch: Partial<DiscountCodeInput>): Promise<void> {
  const { error } = await supabase.from("discount_codes").update(patch).eq("id", id);
  if (error) throw error;
}

export async function deleteDiscountCode(id: string): Promise<void> {
  const { error } = await supabase.from("discount_codes").delete().eq("id", id);
  if (error) throw error;
}

/** Accounts whose email or name matches, for adding emails to a discount. */
export async function searchProfileEmails(search: string): Promise<{ email: string; display_name: string | null }[]> {
  const term = sanitizeSearch(search);
  if (!term) return [];
  const { data, error } = await supabase
    .from("profiles")
    .select("email, display_name")
    .or(`email.ilike.%${term}%,display_name.ilike.%${term}%`)
    .not("email", "is", null)
    .order("email")
    .limit(8);
  if (error) throw error;
  return (data ?? []) as { email: string; display_name: string | null }[];
}
