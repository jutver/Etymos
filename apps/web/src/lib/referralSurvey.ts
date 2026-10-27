// "How did you hear about Etymos?" — written to `public.referral_survey_responses`
// (supabase/migrations/20261026000000_referral_survey.sql) and read back by the
// admin portal's Referral sources screen.
//
// Asked once per signed-in account: the answer (or a skip) is remembered in
// localStorage under the user's id, and the user id doubles as visitor_id,
// which is unique in the table, so a second insert for the same account (from
// another browser) is refused. Like analytics, saving must never break the app.
import { supabase } from "@etymos/shared";

export type ReferralSource = "facebook" | "tiktok" | "friend" | "search" | "other";

const DONE_KEY_PREFIX = "etymos.referral.done:";
export const OTHER_TEXT_MAX = 200;

/** True once this user has answered or skipped in this browser. Blocked
 * storage counts as answered: without it the dialog would come back on every
 * page load. */
export function referralSurveyDone(userId: string): boolean {
  try {
    return window.localStorage.getItem(DONE_KEY_PREFIX + userId) !== null;
  } catch {
    return true;
  }
}

/** Records the user's answer (`null` = closed without answering) and never throws. */
export async function submitReferralSurvey(userId: string, source: ReferralSource | null, otherText = ""): Promise<void> {
  try {
    window.localStorage.setItem(DONE_KEY_PREFIX + userId, source ?? "skipped");
    const text = source === "other" ? otherText.trim().slice(0, OTHER_TEXT_MAX) : "";
    // A duplicate (23505) means this account already answered — nothing to do.
    await supabase.from("referral_survey_responses").insert({
      visitor_id: userId,
      user_id: userId,
      source: source ?? "skipped",
      other_text: text || null,
    });
  } catch {
    // Storage blocked or offline: the survey is optional, drop the answer.
  }
}
