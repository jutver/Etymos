// "How did you hear about Etymos?" — written to `public.referral_survey_responses`
// (supabase/migrations/20261026000000_referral_survey.sql) and read back by the
// admin portal's Referral sources screen.
//
// Asked once per signed-in account. The answer (or a skip) is remembered in
// localStorage under the user's id, and before asking in a browser that has no
// record the app asks the database (referral_survey_answered(),
// 20261111000000_referral_survey_answered.sql), so a new browser doesn't ask
// again. The user id doubles as visitor_id, which is unique in the table, so a
// second insert for the same account is refused anyway. Like analytics,
// saving must never break the app.
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

function rememberDone(userId: string, value: string) {
  try {
    window.localStorage.setItem(DONE_KEY_PREFIX + userId, value);
  } catch {
    // Blocked storage already counts as answered.
  }
}

/** Whether this account has answered or skipped in any browser, asked of the
 * database. A yes is remembered here too. Only a missing function (the
 * migration not applied yet) gives no; any other failure gives yes, since
 * asking twice is worse than not asking. */
export async function referralSurveyAnsweredAnywhere(userId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc("referral_survey_answered");
    if (error) return !(error.code === "PGRST202" || error.code === "42883");
    if (data === true) rememberDone(userId, "answered");
    return data === true;
  } catch {
    return true;
  }
}

/** Records the user's answer (`null` = closed without answering) and never throws. */
export async function submitReferralSurvey(userId: string, source: ReferralSource | null, otherText = ""): Promise<void> {
  try {
    rememberDone(userId, source ?? "skipped");
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
