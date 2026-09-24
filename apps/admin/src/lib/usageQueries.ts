// "Usage log" (CHANGES_I_WANT.md Admin Portal #4) = the user's own activity —
// distinct from audit_log, which only records admin-caused changes. Built
// from data that already exists: `documents` (their checks) and
// `checkout_events` (their purchases), scoped to user_id and merged/sorted
// by date. No new table. RLS already permits admin reads on both
// (documents_all_self_or_admin, checkout_events_select_self_or_admin).
import { supabase } from "@etymos/shared";
import { tr, t } from "./i18n";

export type UsageLogKind = "document" | "checkout";

export interface UsageLogEntry {
  id: string;
  kind: UsageLogKind;
  created_at: string;
  title: string;
  detail: string;
}

interface DocumentUsageRow {
  id: string;
  title: string | null;
  file_name: string | null;
  status: string | null;
  similarity_score: number | null;
  word_count: number | null;
  uploaded_at: string;
}

interface CheckoutUsageRow {
  id: string;
  kind: string;
  plan_tier: string | null;
  pack_id: string | null;
  amount: number | null;
  currency: string;
  status: string;
  created_at: string;
}

function describeDocument(d: DocumentUsageRow): UsageLogEntry {
  const parts = [
    d.status ? t("Status: {{status}}", { status: d.status }) : null,
    d.similarity_score != null ? t("{{score}}% similarity", { score: d.similarity_score }) : null,
    d.word_count != null ? t("{{count}} words", { count: d.word_count }) : null,
  ].filter(Boolean);
  return {
    id: `doc-${d.id}`,
    kind: "document",
    created_at: d.uploaded_at,
    title: d.title || d.file_name || tr("Untitled document"),
    detail: parts.length > 0 ? parts.join(" · ") : tr("Document check"),
  };
}

function describeCheckout(c: CheckoutUsageRow): UsageLogEntry {
  const label = c.kind === "plan" ? t("Plan purchase: {{tier}}", { tier: c.plan_tier ?? "—" }) : t("Credit pack: {{pack}}", { pack: c.pack_id ?? "—" });
  const amount = c.amount != null ? `${c.amount} ${c.currency}` : "—";
  return {
    id: `checkout-${c.id}`,
    kind: "checkout",
    created_at: c.created_at,
    title: label,
    detail: `${c.status} · ${amount}`,
  };
}

export async function listUserUsageLog(userId: string): Promise<UsageLogEntry[]> {
  const [documentsResult, checkoutsResult] = await Promise.all([
    supabase
      .from("documents")
      .select("id, title, file_name, status, similarity_score, word_count, uploaded_at")
      .eq("user_id", userId)
      .order("uploaded_at", { ascending: false }),
    supabase
      .from("checkout_events")
      .select("id, kind, plan_tier, pack_id, amount, currency, status, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false }),
  ]);

  if (documentsResult.error) throw documentsResult.error;
  if (checkoutsResult.error) throw checkoutsResult.error;

  const entries: UsageLogEntry[] = [
    ...((documentsResult.data ?? []) as DocumentUsageRow[]).map(describeDocument),
    ...((checkoutsResult.data ?? []) as CheckoutUsageRow[]).map(describeCheckout),
  ];

  entries.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  return entries;
}
