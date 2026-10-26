// "How did you hear about Etymos?" — written to `public.referral_survey_responses`
// (supabase/migrations/20261026000000_referral_survey.sql) and read back by the
// admin portal's Referral sources screen.
//
// Asked once per browser: the answer (or a skip) is remembered in localStorage,
// and visitor_id is unique in the table, so a second insert from the same
// browser is refused. Like analytics, saving must never break the app.
import { supabase } from "@etymos/shared";

export type ReferralSource = "facebook" | "tiktok" | "friend" | "search" | "other";

const VISITOR_KEY = "etymos.referral.visitor";
const DONE_KEY = "etymos.referral.done";
export const OTHER_TEXT_MAX = 200;

function newId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

function visitorId(): string {
  const existing = window.localStorage.getItem(VISITOR_KEY);
  if (existing) return existing;
  const id = newId();
  window.localStorage.setItem(VISITOR_KEY, id);
  return id;
}

/** True once this browser has answered or skipped. Blocked storage counts as
 * answered: without it the dialog would come back on every page load. */
export function referralSurveyDone(): boolean {
  try {
    return window.localStorage.getItem(DONE_KEY) !== null;
  } catch {
    return true;
  }
}

/** Records the answer (`null` = closed without answering) and never throws. */
export async function submitReferralSurvey(source: ReferralSource | null, otherText = ""): Promise<void> {
  try {
    window.localStorage.setItem(DONE_KEY, source ?? "skipped");
    const { data } = await supabase.auth.getSession();
    const text = source === "other" ? otherText.trim().slice(0, OTHER_TEXT_MAX) : "";
    // A duplicate (23505) means this browser already answered — nothing to do.
    await supabase.from("referral_survey_responses").insert({
      visitor_id: visitorId(),
      user_id: data.session?.user.id ?? null,
      source: source ?? "skipped",
      other_text: text || null,
    });
  } catch {
    // Storage blocked or offline: the survey is optional, drop the answer.
  }
}
