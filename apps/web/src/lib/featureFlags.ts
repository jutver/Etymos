// Minimal Supabase-backed feature flag reader. Foundational for future
// flag-gated experiments — not a feature in itself. Modeled on the plain
// async-function pattern used by apps/admin/src/lib/configQueries.ts, plus a
// small hook for components that just need one flag's current value.
import { useEffect, useState } from "react";
import { supabase } from "@etymos/shared";

export interface FeatureFlag {
  key: string;
  label: string;
  description: string | null;
  enabled: boolean;
}

/** `feature_flags` has a public-select RLS policy, so this works signed out too. */
export async function fetchFeatureFlags(): Promise<FeatureFlag[]> {
  const { data, error } = await supabase.from("feature_flags").select("*").order("key");
  if (error) throw error;
  return (data ?? []) as FeatureFlag[];
}

export async function fetchFeatureFlag(key: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("feature_flags")
    .select("enabled")
    .eq("key", key)
    .maybeSingle();
  if (error) throw error;
  return data?.enabled ?? false;
}

/** Gate UI on a single flag. Defaults to `false` until the fetch resolves, or
 * if the flag doesn't exist / the fetch fails. */
export function useFeatureFlag(key: string): boolean {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchFeatureFlag(key)
      .then((value) => {
        if (!cancelled) setEnabled(value);
      })
      .catch((err: unknown) => console.error(`Failed to load feature flag "${key}"`, err));
    return () => {
      cancelled = true;
    };
  }, [key]);

  return enabled;
}
