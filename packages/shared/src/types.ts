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
  /** Number of packs purchased in this request. Always 1 for `kind: "plan"`. */
  quantity: number;
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

/** Kind of structural block a passage renders as in the Document view.
 * Absent (or "paragraph") is the historical default — every passage before
 * this field existed, and every passage from a source that can't classify
 * structure (plain pasted text), is a plain paragraph. */
export type DocBlockType = "title" | "heading" | "paragraph" | "list_item" | "table" | "image";

/** An inline formatting range inside a passage's `text` (offsets into it,
 * end exclusive) - bold/italic kept from the original file. */
export interface TextMark {
  start: number;
  end: number;
  style: "bold" | "italic";
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
  /** --- Structure metadata (backend/document_model.py's `document.blocks`) ---
   * All optional and additive: a passage with none of these renders exactly
   * as before (a plain paragraph), so historical Supabase rows and the
   * pasted-text check path (which has no structure to report) keep working
   * unchanged. */
  blockType?: DocBlockType;
  /** Heading level 1-3, meaningful only when `blockType === "heading"`. */
  level?: 1 | 2 | 3;
  /** Bullet vs. numbered, meaningful only when `blockType === "list_item"`. */
  listType?: "bullet" | "number";
  /** 1-based source page number (PDF page, or a synthetic bucket for
   * .docx — see backend/extract_docx.py). Consecutive passages sharing a
   * page render inside the same "sheet"; a change in `page` is where the
   * Document view draws a real blank-space page break. Undefined means
   * "no page information" — the whole document renders as one sheet, the
   * same single-scroll layout the view always used before this field
   * existed. */
  page?: number;
  /** Grid contents, meaningful only when `blockType === "table"`. */
  tableRows?: string[][];
  /** Supabase Storage URL for an extracted image, meaningful only when
   * `blockType === "image"`. Undefined when extraction/upload failed, the
   * source document had no image at this position, or the report predates
   * image extraction — the Document view falls back to a placeholder box
   * in that case (see DocumentCanvas's "image" case). */
  imageUrl?: string;
  /** Bold/italic ranges from the original file (backend block "marks").
   * Undefined for passages without inline formatting and for reports saved
   * before this existed - the text then renders plain, as before. */
  textMarks?: TextMark[];
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
  /** --- Citation metadata (optional) ---------------------------------------
   * Populated for freshly-run checks (backend/paper_cache.py now carries
   * these through); absent for matches restored from Supabase, whose
   * `document_matches` rows predate these columns. The Copy Citation dialog
   * degrades gracefully (same rule as backend/citations.py's
   * format_reference) when any of these are missing. */
  sourceYear?: string;
  sourceUrl?: string;
  sourceDoi?: string;
}

/** One analysed paragraph from the backend's AI-content detector. */
export interface AiDetectionSegment {
  /** Offsets into the report's `input_text`. */
  start: number;
  end: number;
  blockId?: string | null;
  words: number;
  /** 0-100, likelihood this paragraph is machine-written. */
  score: number;
  /** First ~160 characters of the paragraph, so the UI can show which one it is. */
  excerpt?: string;
  /** The detector's three measurements for this paragraph (absent on reports
   * checked before they were stored) — lets the UI explain the score. */
  features?: AiSegmentFeatures;
}

export interface AiSegmentFeatures {
  /** Mean negative log-likelihood per token; perplexity = e^meanNll. Lower = more predictable. */
  meanNll?: number;
  /** 0-1 share of tokens that were the reference model's single top guess. */
  topOneShare?: number;
  /** Spread of per-sentence meanNll ("burstiness"). Lower = more even rhythm. */
  sentenceSpread?: number;
}

export type AiDetectionLevel = "low" | "possible" | "likely";

/**
 * Result of backend/ai_detector.py, stored in `documents.ai_detection`.
 * Deliberately separate from `similarityScore`: plagiarism and machine-written
 * text are different signals. `available: false` means the detector could not
 * run for this check (no GPU/model, or disabled by an admin) — not "no AI".
 */
export type AiDetection =
  | { available: false; reason?: string }
  | {
      available: true;
      method: string;
      model: string;
      /** 0-100, word-weighted across the analysed paragraphs. */
      overallScore: number;
      level: AiDetectionLevel;
      /** "low" for non-English text or very short documents. */
      confidence: "normal" | "low";
      language: string;
      analyzedWords: number;
      /** % of analysed words sitting in paragraphs that individually look machine-written. */
      aiShare: number;
      segments: AiDetectionSegment[];
      reasons: string[];
      disclaimer: string;
    };

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
  /** AI-generated-content detection; absent for reports checked before it shipped. */
  aiDetection?: AiDetection;
}

export type DocStatus = "clean" | "low" | "moderate" | "high";

export interface HistoryEntry {
  id: string;
  title: string;
  /** Original uploaded file name, when the check came from a file (not pasted
   * text). Used to group multiple checks of "the same file" as versions. */
  fileName?: string;
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
