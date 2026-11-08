// Plans, credit packs and the viewer's discounts for the public pages, shared
// and kept for a minute. Pricing reads it on mount, so whatever Home or a
// hover over the Pricing link already fetched shows with the first paint
// instead of popping in after the page.
import { supabase } from "@etymos/shared";
import type { CreditPack, PlanDefinition } from "@etymos/shared";
import {
  fetchActivePlanDiscounts,
  fetchCreditPacks,
  fetchPlanDefinitions,
  type ActivePlanDiscount,
} from "./configQueries";

export interface PricingData {
  plans: PlanDefinition[];
  packs: CreditPack[];
  discounts: ActivePlanDiscount[];
}

const FRESH_MS = 60_000;

let entry: { at: number; promise: Promise<PricingData>; value?: PricingData } | null = null;

const isFresh = () => entry !== null && Date.now() - entry.at < FRESH_MS;

/** The data, from the cache while it's fresh, otherwise fetched again. */
export function loadPricingData(): Promise<PricingData> {
  if (entry && isFresh()) return entry.promise;
  const started = {
    at: Date.now(),
    promise: Promise.all([fetchPlanDefinitions(), fetchCreditPacks(), fetchActivePlanDiscounts()]).then(
      ([plans, packs, discounts]) => ({ plans, packs, discounts }),
    ),
  } as NonNullable<typeof entry>;
  entry = started;
  started.promise.then(
    (value) => {
      started.value = value;
    },
    () => {
      if (entry === started) entry = null; // let the next caller retry
    },
  );
  return started.promise;
}

/** The fresh cached data if it has already arrived, for a page's first render. */
export function cachedPricingData(): PricingData | undefined {
  return isFresh() ? entry?.value : undefined;
}

/** Start loading ahead of a visit; errors surface when the page loads it. */
export function prefetchPricingData(): void {
  loadPricingData().catch(() => {});
}

// Discounts depend on who's signed in, so a sign-in or sign-out drops the cache.
supabase.auth.onAuthStateChange((event) => {
  if (event === "SIGNED_IN" || event === "SIGNED_OUT") entry = null;
});
