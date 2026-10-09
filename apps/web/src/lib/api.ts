import { supabase } from "@etymos/shared";
import { tr, t } from "./i18n";

export interface BackendJob {
  job_id: string;
  status: string;
  input_type: string;
  progress?: number;
  current_step?: string;
  message?: string;
  report_id?: string;
  input_name?: string;
  error?: string;
}

export interface BackendReport {
  overall_score: number;
  total_input_chunks: number;
  input_text?: string;
  /** AI-generated-content detection (backend/ai_detector.py). Raw snake_case
   * block — parse it with `parseAiDetection` (lib/aiDetection.ts). Absent on
   * reports produced before the detector existed. */
  ai_detection?: unknown;
  matched_papers: Array<{
    source_paper_id: string;
    source_title: string;
    likely_count?: number;
    suspicious_count?: number;
    common_definition_count?: number;
    max_similarity?: number;
  }>;
  matches: Array<{
    label: string;
    input_section?: string;
    source_paper_id: string;
    source_title?: string;
    source_section?: string;
    input_chunk_id?: string;
    source_chunk_id?: string;
    input_sentence: string;
    source_sentence: string;
    semantic_similarity: number;
    word_overlap?: number;
    char_ngram_overlap?: number;
    /** Absolute character offsets of `input_sentence` inside `input_text`.
     * The backend OMITS this key (it never zeroes it) when it could not
     * localise the sentence, and reports produced before offsets shipped
     * lack it entirely — so presence of this object is the capability check
     * for "we have real offsets for this match". */
    input_offset?: BackendMatchInputOffset;
    /** Offsets of `source_sentence` inside its own source chunk. */
    source_offset?: BackendMatchSourceOffset;
  }>;
  coverage?: Record<string, unknown>;
  /** Present since the scoring fix; carries the new figure's provenance plus
   * `legacy_overall_score` for comparison. */
  scoring?: BackendScoring;
  /** Structural view of `input_text` (backend/document_model.py's
   * build_document), present whenever the backend had a `document` to
   * attach — every PDF/.docx check today; absent for reports generated
   * before this shipped. Drives the Document view's headings/lists/tables/
   * page breaks — see screens/Analyzing's passage builder. */
  document?: BackendDocument;
  queries?: string[];
  warnings?: string[];
}

export interface BackendDocumentBlock {
  block_id: string;
  section: string;
  label: string;
  /** "title" | "heading" | "paragraph" | "list_item" | "table" | "image" */
  type: string;
  index: number;
  /** Inclusive character offset into `BackendReport.input_text`. */
  start: number;
  /** Exclusive character offset into `BackendReport.input_text`. */
  end: number;
  level?: number;
  list_type?: string;
  page?: number;
  rows?: string[][];
  /** Supabase Storage URL for an extracted image; present only on
   * `type: "image"` blocks that were successfully uploaded (see
   * backend/api/report_store.py's _extract_and_upload_images). */
  image_url?: string;
  /** The block's own words when it has none in `input_text` - set on the
   * zero-length section-heading blocks (backend/document_model.py's
   * _interleave_section_headings). */
  text?: string;
  /** True for a section's own heading line kept from the original file. */
  section_heading?: boolean;
  /** Inline bold/italic ranges, offsets relative to this block's `start`. */
  marks?: Array<{ start: number; end: number; style: "bold" | "italic" }>;
}

export interface BackendDocument {
  version?: number;
  total_chars?: number;
  sections?: Array<{ section: string; label: string; start: number; end: number }>;
  blocks?: BackendDocumentBlock[];
  text_field?: string;
}

export interface BackendMatchInputOffset {
  /** Inclusive character index into `BackendReport.input_text`. */
  start: number;
  /** Exclusive character index into `BackendReport.input_text`. */
  end: number;
  length: number;
  section?: string | null;
  block_id?: string | null;
  chunk_id?: string | null;
  chunk_start?: number | null;
  chunk_end?: number | null;
}

export interface BackendMatchSourceOffset {
  chunk_id?: string | null;
  chunk_start?: number | null;
  chunk_end?: number | null;
  length?: number;
}

export interface BackendScoring {
  version?: string | number;
  method?: string;
  total_chars?: number;
  matched_chars?: number;
  covered_chars?: number;
  raw_coverage_percent?: number;
  /** The pre-fix percentage, which double-counted overlapping matches. */
  legacy_overall_score?: number;
  legacy_total_chars?: number;
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8000";

function buildUrl(path: string) {
  return `${API_BASE_URL}${path}`;
}

async function errorMessageFromResponse(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as { detail?: string };
    if (parsed.detail) return parsed.detail;
  } catch {
    // response wasn't JSON — fall back to raw text
  }
  return text || t("Request failed with {{status}}", { status: response.status });
}

async function getAuthHeader(): Promise<Record<string, string>> {
  const { data, error } = await supabase.auth.getSession();
  const accessToken = data.session?.access_token;
  if (error || !accessToken) {
    throw new Error(tr("Your session has expired. Please sign in again and retry."));
  }
  return { Authorization: `Bearer ${accessToken}` };
}

/** Carries the HTTP status so callers can distinguish "the backend has no
 * record of this job" (404 — the job is gone for good, e.g. the API process
 * restarted and lost its in-memory job table) from "the backend is momentarily
 * unreachable" (network error — worth retrying). Job reconciliation depends on
 * that difference: only the former may resolve a job to `failed`. */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** True when the backend positively answered "no such job" — as opposed to not
 * answering at all. */
export function isJobMissingError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const authHeader = await getAuthHeader();
  const response = await fetch(buildUrl(path), {
    ...init,
    headers: { "Content-Type": "application/json", ...authHeader, ...init?.headers },
  });

  if (!response.ok) {
    throw new ApiError(await errorMessageFromResponse(response), response.status);
  }

  return response.json() as Promise<T>;
}

export type BalanceSource = "plan" | "standard" | "premium";

export async function submitTextCheck(text: string, balanceSource: BalanceSource): Promise<BackendJob> {
  return requestJson<BackendJob>("/api/check/text", {
    method: "POST",
    body: JSON.stringify({ text, balance_source: balanceSource }),
  });
}

export async function submitPdfCheck(file: File, balanceSource: BalanceSource): Promise<BackendJob> {
  const authHeader = await getAuthHeader();
  const formData = new FormData();
  formData.append("file", file);
  formData.append("balance_source", balanceSource);
  const response = await fetch(buildUrl("/api/check/pdf"), {
    method: "POST",
    headers: { ...authHeader },
    body: formData,
  });

  if (!response.ok) {
    throw new ApiError(await errorMessageFromResponse(response), response.status);
  }

  return response.json() as Promise<BackendJob>;
}

export async function getJob(jobId: string): Promise<BackendJob> {
  return requestJson<BackendJob>(`/api/jobs/${jobId}`);
}

export async function getReport(reportId: string): Promise<BackendReport> {
  return requestJson<BackendReport>(`/api/reports/${reportId}`);
}

export interface RewriteResponse {
  success: boolean;
  rewritten_text: string;
}

export async function rewriteText(inputSentence: string, sourceSentence: string): Promise<RewriteResponse> {
  return requestJson<RewriteResponse>("/api/ai/rewrite", {
    method: "POST",
    body: JSON.stringify({ input_sentence: inputSentence, source_sentence: sourceSentence }),
  });
}

export interface DeleteAccountResponse {
  deleted: boolean;
  user_id: string;
}

/** Self-service account deletion (`DELETE /api/account` in backend/api/app.py).
 * Takes no id — the backend derives the target strictly from the caller's
 * own verified JWT, so this can only ever delete the signed-in user's own
 * account. Used both by an eventual self-delete UI and by the
 * admin-requested deletion-confirm flow (CHANGES_I_WANT.md Admin Portal #3)
 * once the user clicks "confirm" in that dialog. */
export async function deleteOwnAccount(): Promise<DeleteAccountResponse> {
  return requestJson<DeleteAccountResponse>("/api/account", { method: "DELETE" });
}

export type MarkerPreviewStatus = "pending" | "ready" | "failed" | "unavailable";

/** Status/result of the marker-pdf conversion (backend/marker_preview.py)
 * that replaces the raw-PDF preview in the Report page's Original view —
 * see components/MarkerDocumentViewer.tsx. `html` is only present once
 * `status === "ready"`; `docx_ready` gates showing the "Download .docx"
 * button. `"unavailable"` (as opposed to "failed") covers every case where
 * no preview will ever show up for this report (a .docx-sourced check, one
 * predating this feature, or a backend restart that dropped the in-memory
 * entry) — the frontend treats it the same as "failed", just without
 * implying a retry would help. */
export interface MarkerPreview {
  status: MarkerPreviewStatus;
  html: string | null;
  docx_ready: boolean;
  error?: string | null;
}

export async function getMarkerPreview(reportId: string): Promise<MarkerPreview> {
  return requestJson<MarkerPreview>(`/api/reports/${reportId}/marker-preview`);
}

/** Polls like pollJob() until the marker-pdf conversion settles one way or
 * another. Stops on "ready", "failed", AND "unavailable" — none of those
 * three will ever change on their own without a fresh check. */
export async function pollMarkerPreview(
  reportId: string,
  onProgress?: (preview: MarkerPreview) => void,
): Promise<MarkerPreview> {
  let preview = await getMarkerPreview(reportId);
  onProgress?.(preview);

  while (preview.status === "pending") {
    await new Promise((resolve) => window.setTimeout(resolve, 2000));
    preview = await getMarkerPreview(reportId);
    onProgress?.(preview);
  }

  return preview;
}

/** Downloads the real .docx marker-pdf produced (backend Pandoc step) and
 * saves it client-side. A plain `<a href>` can't carry the auth header this
 * endpoint requires, so this fetches the bytes and triggers the save via a
 * throwaway blob URL instead. */
export async function downloadMarkerPreviewDocx(reportId: string, fileName: string): Promise<void> {
  const authHeader = await getAuthHeader();
  const response = await fetch(buildUrl(`/api/reports/${reportId}/marker-preview/docx`), {
    headers: { ...authHeader },
  });
  if (!response.ok) {
    throw new ApiError(await errorMessageFromResponse(response), response.status);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName.endsWith(".docx") ? fileName : `${fileName}.docx`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function pollJob(jobId: string, onProgress?: (job: BackendJob) => void): Promise<BackendJob> {
  let job = await getJob(jobId);
  onProgress?.(job);

  while (job.status !== "completed" && job.status !== "failed") {
    await new Promise((resolve) => window.setTimeout(resolve, 1500));
    job = await getJob(jobId);
    onProgress?.(job);
  }

  return job;
}

// --- Recovery email (backend/api/recovery_email.py) ------------------------

export interface RecoveryEmailStatus {
  email: string | null;
  verified: boolean;
  pending: boolean;
}

export function getRecoveryEmail(): Promise<RecoveryEmailStatus> {
  return requestJson<RecoveryEmailStatus>("/api/account/recovery-email");
}

/** Saves the address and emails it a 6-digit confirmation code (valid 30
 * minutes). It can't be used for account recovery until the code is confirmed. */
export function setRecoveryEmail(email: string): Promise<RecoveryEmailStatus> {
  return requestJson<RecoveryEmailStatus>("/api/account/recovery-email", {
    method: "PUT",
    body: JSON.stringify({ email }),
  });
}

export function removeRecoveryEmail(): Promise<RecoveryEmailStatus> {
  return requestJson<RecoveryEmailStatus>("/api/account/recovery-email", { method: "DELETE" });
}

/** Checks the 6-digit code emailed to the pending recovery address. ApiError
 * detail: wrong_code, expired, too_many_attempts, no_code, in_use. */
export function confirmRecoveryEmail(code: string): Promise<RecoveryEmailStatus> {
  return requestJson<RecoveryEmailStatus>("/api/account/recovery-email/confirm", {
    method: "POST",
    body: JSON.stringify({ code }),
  });
}

async function postPublic<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(buildUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new ApiError(await errorMessageFromResponse(response), response.status);
  return response.json() as Promise<T>;
}

/** Account recovery, step 1: if `email` is a confirmed recovery address, the
 * backend emails it a 6-digit code. Answers the same either way. */
export function requestRecoveryCode(email: string): Promise<{ ok: boolean }> {
  return postPublic("/api/auth/recovery/request", { email });
}

export interface RecoveryAccount {
  user_id: string;
  email: string;
  name: string;
}

/** Account recovery, step 2. Without `userId`, a correct code returns the
 * accounts using this recovery email ({ accounts }) and stays valid. With
 * the chosen `userId`, the code is spent and that account's Supabase
 * recovery token_hash returned, to redeem with `supabase.auth.verifyOtp`.
 * Any failure is ApiError 400 "invalid_code" (or 429 when rate limited). */
export function verifyRecoveryCode(email: string, code: string): Promise<{ accounts: RecoveryAccount[] }>;
export function verifyRecoveryCode(email: string, code: string, userId: string): Promise<{ token_hash: string }>;
export function verifyRecoveryCode(email: string, code: string, userId?: string) {
  return postPublic("/api/auth/recovery/verify", userId ? { email, code, user_id: userId } : { email, code });
}

// --- Payments (backend/api/payments.py) ------------------------------------

export type PaymentItem =
  | { kind: "plan"; plan_tier: "student" | "professional"; billing_cycle: "monthly" | "annual" }
  | { kind: "pack"; pack_id: "pack-standard" | "pack-premium"; quantity: number };

export interface PaymentDiscount {
  source: "auto" | "code";
  type: "percent" | "fixed";
  value: number;
}

export interface PaymentQuote {
  list_amount: number;
  amount: number;
  discount: PaymentDiscount | null;
}

export interface PaymentTransfer {
  bank: string;
  account_number: string;
  account_name: string;
  amount: number;
  /** Transfer content: the order's payment code. */
  content: string;
  qr_url: string;
}

export interface PaymentOrder {
  id: string;
  status: "pending" | "success" | "declined" | "cancelled";
  kind: "plan" | "pack";
  plan_tier: "student" | "professional" | null;
  billing_cycle: "monthly" | "annual" | null;
  pack_id: "pack-standard" | "pack-premium" | null;
  quantity: number;
  amount: number;
  list_amount: number;
  payment_code: string | null;
  created_at: string;
  expires_at: string | null;
  paid_at: string | null;
  /** Bank transfer details; null once the order is paid, cancelled or expired. */
  transfer: PaymentTransfer | null;
}

/** Server-side price for an item. ApiError detail on a bad discount code:
 * discount_invalid, discount_inactive, discount_not_started,
 * discount_expired, discount_limit_reached, discount_already_used. */
export function quotePayment(item: PaymentItem, discountCode?: string): Promise<PaymentQuote> {
  return requestJson<PaymentQuote>("/api/payments/quote", {
    method: "POST",
    body: JSON.stringify({ ...item, discount_code: discountCode || null }),
  });
}

/** Creates an order to pay by bank transfer. Any earlier unpaid order is
 * cancelled. A fully discounted order comes back already `success`. */
export function createPaymentOrder(item: PaymentItem, discountCode?: string): Promise<PaymentOrder> {
  return requestJson<PaymentOrder>("/api/payments/orders", {
    method: "POST",
    body: JSON.stringify({ ...item, discount_code: discountCode || null }),
  });
}

export async function getActivePaymentOrder(): Promise<PaymentOrder | null> {
  return (await requestJson<{ order: PaymentOrder | null }>("/api/payments/orders/active")).order;
}

export function getPaymentOrder(orderId: string): Promise<PaymentOrder> {
  return requestJson<PaymentOrder>(`/api/payments/orders/${encodeURIComponent(orderId)}`);
}

export function cancelPaymentOrder(orderId: string): Promise<PaymentOrder> {
  return requestJson<PaymentOrder>(`/api/payments/orders/${encodeURIComponent(orderId)}/cancel`, { method: "POST" });
}

// --- Account notices ---------------------------------------------------------

/** Tells the backend the password was just changed, so the login email gets a
 * "your password was changed" notice. Best-effort: never throws. Call it
 * while the session is still valid (before any sign-out). */
export async function notifyPasswordChanged(): Promise<void> {
  try {
    await requestJson<{ ok: boolean }>("/api/account/password-changed", { method: "POST" });
  } catch (err) {
    console.warn("Password-change notice failed", err);
  }
}

// --- Support (backend/api/support.py) --------------------------------------

export type SupportCategory = "billing" | "account" | "checks" | "bug" | "other";
export type SupportStatus = "open" | "pending" | "resolved" | "closed";

export interface SupportAttachment {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  /** Signed, expires after ~10 minutes. */
  url: string | null;
}

export interface SupportTicketSummary {
  number: number;
  subject: string;
  category: SupportCategory;
  status: SupportStatus;
  created_at: string;
  updated_at: string;
  last_agent_message_at: string | null;
}

export interface SupportMessage {
  id: string;
  from: "you" | "support";
  body: string;
  channel: "web" | "email" | "admin";
  created_at: string;
  attachments: SupportAttachment[];
}

export interface SupportConversation extends SupportTicketSummary {
  messages: SupportMessage[];
}

/** Attachment limits, mirrored from support.py so the form can say no before uploading. */
export const SUPPORT_MAX_FILES = 5;
export const SUPPORT_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const SUPPORT_FILE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp,application/pdf";

async function optionalAuthHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function sendForm<T>(path: string, form: FormData, headers: Record<string, string>): Promise<T> {
  const response = await fetch(buildUrl(path), { method: "POST", headers, body: form });
  if (!response.ok) throw new ApiError(await errorMessageFromResponse(response), response.status);
  return response.json() as Promise<T>;
}

function supportForm(fields: Record<string, string | undefined>, files: File[]): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) form.append(key, value);
  for (const file of files) form.append("files", file);
  return form;
}

/** Opens a ticket. Signed in, it is tied to the account (email/name are
 * ignored); signed out, `email` is required. ApiError detail: invalid_email,
 * invalid_subject, invalid_body, body_too_long, invalid_category,
 * too_many_files, file_too_large, file_type, too_many_requests. */
export async function openSupportTicket(input: {
  category: SupportCategory;
  subject: string;
  body: string;
  email?: string;
  name?: string;
  website?: string;
  files: File[];
}): Promise<{ number: number; signed_in: boolean }> {
  const { files, ...fields } = input;
  return sendForm("/api/support/tickets", supportForm(fields, files), await optionalAuthHeader());
}

export function listMySupportTickets(): Promise<{ items: SupportTicketSummary[] }> {
  return requestJson("/api/support/tickets");
}

export function getMySupportTicket(number: number): Promise<SupportConversation> {
  return requestJson(`/api/support/tickets/${number}`);
}

/** ApiError 409 "closed" when the ticket is closed. */
export async function replyToMySupportTicket(number: number, body: string, files: File[]): Promise<SupportConversation> {
  return sendForm(`/api/support/tickets/${number}/messages`, supportForm({ body }, files), await getAuthHeader());
}

export async function getGuestSupportTicket(token: string): Promise<SupportConversation> {
  const response = await fetch(buildUrl(`/api/support/guest/${encodeURIComponent(token)}`));
  if (!response.ok) throw new ApiError(await errorMessageFromResponse(response), response.status);
  return response.json() as Promise<SupportConversation>;
}

export function replyAsGuest(token: string, body: string, files: File[]): Promise<SupportConversation> {
  return sendForm(`/api/support/guest/${encodeURIComponent(token)}/messages`, supportForm({ body }, files), {});
}
