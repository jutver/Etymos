// State for the first-run app tour (components/tour/Tour.tsx). It runs across
// three screens (Upload, Documents, the sample report), so where it is lives
// here rather than in any one of them. Whether a user has seen it is
// profiles.tour_completed_at (20261110000000_onboarding_trial_sample.sql).
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

/** Records that the tour was finished or skipped, so it doesn't open again. */
export async function markTourDone(userId: string): Promise<void> {
  const at = new Date().toISOString();
  useAppStore.getState().markTourCompleted(at);
  const { error } = await supabase.from("profiles").update({ tour_completed_at: at }).eq("id", userId);
  if (error) console.error("Failed to save tour progress", error);
}

/** Starts the tour from the account menu: makes sure the sample exists and
 * skips the welcome card. */
export async function restartTour(): Promise<boolean> {
  const sampleId = await ensureSampleDocument();
  if (!sampleId) return false;
  useTourStore.getState().begin(sampleId, 1);
  return true;
}
