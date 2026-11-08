// The free 7-day Standard trial (start_student_trial in
// supabase/migrations/20261110000000_onboarding_trial_sample.sql). It's an
// ordinary Standard ("student") plan with an end date, so once started the rest
// of the app treats it like any plan; these helpers only decide whether to
// offer it and how to label it.
import { supabase } from "@etymos/shared";
import type { PlanTier } from "@etymos/shared";
import { tr } from "./i18n";

export const TRIAL_DAYS = 7;

const DAY_MS = 86_400_000;

/** Whether to offer the trial. The server has the final say (it also refuses
 * anyone who has bought a plan before); this only hides the offer from people
 * who obviously can't take it. */
export function canOfferTrial(state: { plan: PlanTier; trialStartedAt: string | null; profileLoaded: boolean }): boolean {
  return state.profileLoaded && state.plan === "free" && !state.trialStartedAt;
}

/** True while the plan in force is the trial itself, not a plan bought later
 * (buying adds a term, which pushes the end past the trial's 7 days). */
export function isOnTrial(
  state: { plan: PlanTier; trialStartedAt: string | null; planExpiresAt: string | null },
  now: number = Date.now(),
): boolean {
  if (state.plan !== "student" || !state.trialStartedAt || !state.planExpiresAt) return false;
  const ends = new Date(state.planExpiresAt).getTime();
  const started = new Date(state.trialStartedAt).getTime();
  return ends > now && ends - started <= TRIAL_DAYS * DAY_MS + 60 * 60_000;
}

const ERRORS: Record<string, string> = {
  TRIAL_ALREADY_USED: tr("You've already used your free trial."),
  TRIAL_ON_PAID_PLAN: tr("You're already on a paid plan."),
  TRIAL_NOT_ELIGIBLE: tr("This account can't start a free trial."),
};

/** Starts the trial; resolves to when it ends. Rejects with a readable message. */
export async function startTrial(): Promise<string> {
  const { data, error } = await supabase.rpc("start_student_trial");
  if (error) {
    const known = Object.keys(ERRORS).find((code) => error.message.includes(code));
    throw new Error(known ? ERRORS[known] : tr("Couldn't start your trial. Please try again."));
  }
  return String(data);
}
