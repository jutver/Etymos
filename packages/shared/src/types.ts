export type PlanTier = "free" | "student" | "professional";
export type BillingCycle = "monthly" | "annual";
export type PaymentMethod = "vnpay" | "momo" | "zalopay";
export type CreditPackId = "pack-standard" | "pack-premium";
export type SourceKind = "web" | "academic";
export type AccessStatus = "waitlisted" | "approved" | "rejected";
export type CheckoutKind = "plan" | "pack";
export type CheckoutStatus = "success" | "declined" | "pending";
export type Severity = "high" | "moderate" | "low";
export type Language = "vi" | "en" | "fr" | "ja";

// Row shapes for the two admin-gated tables. Fields are snake_case because
// these mirror the Postgres rows as Supabase returns them, not a camelCase
// view model — callers map to their own shape at the query boundary (see
// apps/web's fetchMyProfile).
export interface ProfileRow {
  id: string;
  email: string | null;
  display_name: string | null;
  role?: "user" | "admin";
  plan_tier: PlanTier;
  billing_cycle: BillingCycle | null;
  standard_credits: number;
  premium_credits: number;
  checks_used_this_period: number;
  plan_period_start: string;
  student_verified: boolean;
  access_status: AccessStatus;
  access_requested_at: string | null;
  access_reviewed_at: string | null;
  access_reviewed_by: string | null;
  access_note: string | null;
  created_at: string;
  updated_at: string;
}

export interface CheckoutEventRow {
  id: string;
  user_id: string;
  kind: CheckoutKind;
  plan_tier: Exclude<PlanTier, "free"> | null;
  billing_cycle: BillingCycle | null;
  pack_id: CreditPackId | null;
  amount: number | null;
  currency: string;
  payment_method: PaymentMethod | null;
  status: CheckoutStatus;
  reviewed_at: string | null;
  reviewed_by: string | null;
  review_note: string | null;
  created_at: string;
}

export interface CreditPack {
  id: CreditPackId;
  label: string;
  description: string;
  checks: number;
  price: number;
  badge?: string;
}

export interface PlanDefinition {
  id: PlanTier;
  name: string;
  tagline: string;
  priceMonthly: number;
  priceAnnual: number;
  audience: string;
  mostPopular?: boolean;
  requiresVerification?: boolean;
  features: string[];
}

export interface DocPassage {
  id: string;
  text: string;
  severity?: Severity;
  matchId?: string;
  /** Character offset of `text[0]` inside the report's `input_text`, when the
   * passage was split from a document whose offsets we know. Absent for
   * passages restored from Supabase (the columns predate offsets) and for
   * reports generated before the backend started emitting them — highlight
   * placement then falls back to the client-side heuristic. */
  startOffset?: number;
  /** Exclusive end offset of `text` inside `input_text`. Paired with
   * `startOffset`; both are present or both absent. */
  endOffset?: number;
}

export interface MatchedSource {
  id: string;
  severity: Severity;
  detectionType: "traditional" | "semantic";
  matchPercent: number;
  sourceTitle: string;
  sourceAuthor: string;
  sourceKind: SourceKind;
  citation: string;
  userSnippet: string;
  sourceSnippet: string;
  explanation: string;
  rewriteSuggestions: string[];
  /** --- Backend-supplied match offsets (optional) --------------------------
   * Character offsets of `userSnippet` inside the report's `input_text`, as
   * emitted by the backend's `match.input_offset`. The backend guarantees
   * `input_text.slice(startOffset, endOffset) === userSnippet` exactly.
   *
   * These are OPTIONAL on purpose: the backend omits `input_offset` (rather
   * than zeroing it) when it cannot localise a sentence, and reports stored
   * before offsets shipped have no such field at all. Consumers must treat
   * "startOffset is undefined" as "fall back to locating the snippet by
   * text search". */
  startOffset?: number;
  /** Exclusive end offset of `userSnippet` inside `input_text`. */
  endOffset?: number;
  /** Structural block the match landed in (`input_offset.block_id`), e.g.
   * `"introduction_0"`. Informational — not required for highlighting. */
  blockId?: string;
  /** Section name the match landed in (`input_offset.section`). */
  sectionId?: string;
  /** Offsets of `sourceSnippet` within its own source chunk
   * (`source_offset.chunk_start` / `chunk_end`). Not offsets into any text the
   * web app holds, so they are informational only today. */
  sourceStartOffset?: number;
  sourceEndOffset?: number;
}

export interface CheckedDocument {
  id: string;
  title: string;
  fileName: string;
  language: Language;
  wordCount: number;
  uploadedAt: string;
  similarityScore: number;
  similarityScoreFree: number;
  webSourcesScanned: number;
  academicSourcesScanned: number;
  passages: DocPassage[];
  matches: MatchedSource[];
  pdfUrl?: string;
}

export type DocStatus = "clean" | "low" | "moderate" | "high";

export interface HistoryEntry {
  id: string;
  title: string;
  date: string;
  similarityScore: number;
  status: DocStatus;
  project?: string;
  wordCount: number;
}

export interface Toast {
  id: string;
  kind: "success" | "info" | "warning" | "error";
  title: string;
  description?: string;
}

export type CheckoutItem =
  | { kind: "plan"; plan: Exclude<PlanTier, "free">; billingCycle: BillingCycle }
  | { kind: "pack"; packId: CreditPackId };
