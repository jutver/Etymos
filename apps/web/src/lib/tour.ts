// State for the first-run app tour (components/tour/Tour.tsx). It runs across
// three screens (Upload, Documents, the sample report), so where it is lives
// here rather than in any one of them. Whether a user has seen it is
// profiles.tour_completed_at (20261110000000_onboarding_trial_sample.sql),
// never browser storage: the store's copy isn't persisted, and the database is
// asked again before the tour opens by itself.
import { create } from "zustand";
import { supabase } from "@etymos/shared";
import { useAppStore } from "./store";

interface TourState {
  active: boolean;
  step: number;
  /** The sample document the report steps open. */
  sampleId: string | null;
  begin: (sampleId: string, step?: number) => void;
  go: (step: number) => void;
  end: () => void;
}

export const useTourStore = create<TourState>((set) => ({
  active: false,
  step: 0,
  sampleId: null,
  begin: (sampleId, step = 0) => set({ active: true, step, sampleId }),
  go: (step) => set({ step }),
  end: () => set({ active: false, step: 0 }),
}));

/** The user's sample document, recreated (or brought back from the trash)
 * if needed. Null when it can't be had, e.g. before the migration. */
export async function ensureSampleDocument(): Promise<string | null> {
  const { data, error } = await supabase.rpc("ensure_sample_document");
  if (error || !data) return null;
  return String(data);
}

/** Whether the account has finished or skipped the tour, asked of the
 * database right before the tour opens by itself, so a finish in another
 * browser or tab counts even if this one's profile is older. When it can't
 * be confirmed (an error, or the column doesn't exist yet) it says yes:
 * showing the tour twice is worse than not showing it. */
export async function tourDoneOnServer(userId: string): Promise<boolean> {
  const { data, error } = await supabase.from("profiles").select("tour_completed_at").eq("id", userId).maybeSingle();
  if (error || !data) return true;
  const at = (data as { tour_completed_at: string | null }).tour_completed_at;
  if (at) useAppStore.getState().markTourCompleted(at);
  return at !== null;
}

const SAVE_ATTEMPTS = 4;

/** Records that the tour was finished or skipped, so it doesn't open again
 * in any browser. Retried, since a lost save would bring it back elsewhere. */
export async function markTourDone(userId: string): Promise<void> {
  const at = new Date().toISOString();
  useAppStore.getState().markTourCompleted(at);
  for (let attempt = 1; attempt <= SAVE_ATTEMPTS; attempt++) {
    const { error } = await supabase
      .from("profiles")
      .update({ tour_completed_at: at })
      .eq("id", userId)
      .is("tour_completed_at", null);
    if (!error) return;
    if (attempt === SAVE_ATTEMPTS) console.error("Failed to save tour progress", error);
    else await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)));
  }
}

/** Starts the tour from the account menu: makes sure the sample exists and
 * skips the welcome card. */
export async function restartTour(): Promise<boolean> {
  const sampleId = await ensureSampleDocument();
  if (!sampleId) return false;
  useTourStore.getState().begin(sampleId, 1);
  return true;
}
