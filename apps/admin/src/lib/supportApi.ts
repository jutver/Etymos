// Support inbox (backend/api/support.py, /api/admin/support/*). Everything
// goes through the backend rather than Supabase directly: replies must be
// emailed from the support mailbox, and statuses kept consistent with them.
import { supabase } from "@etymos/shared";
import { ApiError } from "./api";
import { t } from "./i18n";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8000";

export type SupportStatus = "open" | "pending" | "resolved" | "closed";
export type SupportCategory = "billing" | "account" | "checks" | "bug" | "other";

export interface SupportPerson {
  id: string;
  email: string | null;
  name: string | null;
}

export interface SupportTicketRow {
  id: string;
  number: number;
  subject: string;
  category: SupportCategory;
  status: SupportStatus;
  priority: "normal" | "high";
  source: "form" | "email";
  user_id: string | null;
  requester_email: string;
  requester_name: string | null;
  identity_verified: boolean;
  previous_ticket_id: string | null;
  created_at: string;
  updated_at: string;
  last_user_message_at: string | null;
  last_agent_message_at: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  assignee: SupportPerson | null;
}

export interface SupportAttachment {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  url: string | null;
}

export interface SupportAdminMessage {
  id: string;
  author_type: "user" | "agent" | "system";
  author: SupportPerson | null;
  body: string;
  internal: boolean;
  channel: "web" | "email" | "admin";
  sender_email: string | null;
  sender_auth: "pass" | "fail" | "none" | null;
  sender_mismatch: boolean;
  raw_email_url: string | null;
  created_at: string;
  attachments: SupportAttachment[];
}

export interface SupportAccount {
  id: string;
  email: string | null;
  display_name: string | null;
  role: string;
  plan_tier: string;
  billing_cycle: string | null;
  plan_expires_at: string | null;
  standard_credits: number | null;
  premium_credits: number | null;
  student_verified: boolean | null;
  created_at: string;
  banned_permanent: boolean | null;
  banned_until: string | null;
  deletion_requested_at: string | null;
}

export interface SupportTicketDetail extends SupportTicketRow {
  previous_ticket_number: number | null;
  account: SupportAccount | null;
  messages: SupportAdminMessage[];
}

export interface SupportSummary {
  counts: Record<SupportStatus, number>;
  unassigned_open: number;
  mine_open: number;
}

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new ApiError(t("Your session has expired. Sign in again."), 401);
  return { Authorization: `Bearer ${token}` };
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: { ...(await authHeader()), ...init.headers },
  });
  if (!response.ok) {
    const text = await response.text();
    let message = text || t("Request failed with {{status}}", { status: response.status });
    try {
      const parsed = JSON.parse(text) as { detail?: unknown };
      if (typeof parsed.detail === "string") message = parsed.detail;
    } catch {
      // not JSON
    }
    throw new ApiError(message, response.status);
  }
  return response.json() as Promise<T>;
}

export function getSupportSummary(): Promise<SupportSummary> {
  return request("/api/admin/support/summary");
}

export function listSupportAgents(): Promise<{ items: SupportPerson[] }> {
  return request("/api/admin/support/agents");
}

export function listSupportTickets(params: {
  status?: SupportStatus;
  category?: SupportCategory;
  assigned?: string;
  q?: string;
  page: number;
  pageSize: number;
}): Promise<{ items: SupportTicketRow[]; total: number }> {
  const query = new URLSearchParams({ page: String(params.page), page_size: String(params.pageSize) });
  if (params.status) query.set("status", params.status);
  if (params.category) query.set("category", params.category);
  if (params.assigned) query.set("assigned", params.assigned);
  if (params.q?.trim()) query.set("q", params.q.trim());
  return request(`/api/admin/support/tickets?${query}`);
}

export function getSupportTicket(number: number): Promise<SupportTicketDetail> {
  return request(`/api/admin/support/tickets/${number}`);
}

/** A public reply is emailed to the requester (ApiError 502 "send_failed"
 * if the mail server refuses it — nothing is saved then). An internal note
 * is only visible here. */
export function postSupportMessage(
  number: number,
  input: { body: string; internal: boolean; setStatus?: SupportStatus; files: File[] },
): Promise<SupportTicketDetail> {
  const form = new FormData();
  form.append("body", input.body);
  form.append("internal", String(input.internal));
  if (input.setStatus) form.append("set_status", input.setStatus);
  for (const file of input.files) form.append("files", file);
  return request(`/api/admin/support/tickets/${number}/messages`, { method: "POST", body: form });
}

export function updateSupportTicket(
  number: number,
  patch: Partial<{ status: SupportStatus; priority: "normal" | "high"; category: SupportCategory; assigned_to: string }>,
): Promise<SupportTicketDetail> {
  return request(`/api/admin/support/tickets/${number}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}
