// Query module for public pricing config (plan_definitions/credit_packs).
// Modeled on apps/admin/src/lib/configQueries.ts: plain async functions that
// throw on Supabase error. Both tables have "select_all" RLS policies, so no
// auth scoping is needed here — these are read by anonymous/public visitors
// on the Pricing page too.
import { supabase } from "@etymos/shared";
import type { CreditPack, CreditPackId, PlanDefinition, PlanTier } from "@etymos/shared";
import { setPlanLimitsFromConfig } from "./store";

interface PlanDefinitionRow {
  id: PlanTier;
  name: string;
  tagline: string | null;
  price_monthly: number;
  price_annual: number;
  audience: string | null;
  most_popular: boolean;
  requires_verification: boolean;
  features: string[] | null;
  doc_limit: number | null;
  word_limit: number | null;
  sort_order: number;
}

interface CreditPackRow {
  id: CreditPackId;
  label: string;
  description: string | null;
  checks: number;
  price: number;
  badge: string | null;
  sort_order: number;
}

function toPlanDefinition(row: PlanDefinitionRow): PlanDefinition {
  return {
    id: row.id,
    name: row.name,
    tagline: row.tagline ?? "",
    priceMonthly: Number(row.price_monthly),
    priceAnnual: Number(row.price_annual),
    audience: row.audience ?? "",
    mostPopular: row.most_popular,
    requiresVerification: row.requires_verification,
    features: row.features ?? [],
  };
}

function toCreditPack(row: CreditPackRow): CreditPack {
  return {
    id: row.id,
    label: row.label,
    description: row.description ?? "",
    checks: row.checks,
    price: Number(row.price),
    badge: row.badge ?? undefined,
  };
}

/**
 * Fetches plan_definitions, ordered for display. As a side effect, pushes
 * doc_limit/word_limit into store.ts's PLAN_DOC_LIMITS/PLAN_WORD_LIMITS maps
 * so the rest of the app (which reads those synchronously via planDocLimit/
 * planWordLimit) picks up live limits the moment this resolves, without every
 * call site needing to become async.
 */
export async function fetchPlanDefinitions(): Promise<PlanDefinition[]> {
  const { data, error } = await supabase.from("plan_definitions").select("*").order("sort_order");
  if (error) throw error;
  const rows = (data ?? []) as PlanDefinitionRow[];
  setPlanLimitsFromConfig(rows.map((r) => ({ id: r.id, docLimit: r.doc_limit, wordLimit: r.word_limit })));
  return rows.map(toPlanDefinition);
}

export async function fetchCreditPacks(): Promise<CreditPack[]> {
  const { data, error } = await supabase.from("credit_packs").select("*").order("sort_order");
  if (error) throw error;
  return ((data ?? []) as CreditPackRow[]).map(toCreditPack);
}
