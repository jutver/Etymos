export type PlanTier = "free" | "student" | "professional";
export type BillingCycle = "monthly" | "annual";
export type PaymentMethod = "vnpay" | "momo" | "zalopay";
export type CreditPackId = "pack1" | "pack5" | "pack10";
export type SourceKind = "web" | "academic";
export type Severity = "high" | "moderate" | "low";
export type Language = "vi" | "en" | "fr" | "ja";

export interface CreditPack {
  id: CreditPackId;
  label: string;
  checks: number;
  price: number;
  perCheck: number;
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
  aiFlag?: boolean;
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
  aiContentScore: number;
  aiContentExplanation: string;
  webSourcesScanned: number;
  academicSourcesScanned: number;
  passages: DocPassage[];
  matches: MatchedSource[];
}

export type DocStatus = "clean" | "low" | "moderate" | "high";

export interface HistoryEntry {
  id: string;
  title: string;
  date: string;
  similarityScore: number;
  status: DocStatus;
  aiFlagged: boolean;
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
