// Support inbox. The ticket list and the status counts are plain reads, so
// they query Supabase directly (admins may read the support tables under
// RLS) and keep working when the backend is down. Everything else goes
// through the backend (backend/api/support.py, /api/admin/support/*): replies
// must be emailed from the support mailbox, statuses kept consistent with
// them, and attachment links signed.
import { supabase } from "@etymos/shared";
import { ApiError } from "./api";
import { t } from "./i18n";
import { sanitizeSearch } from "./supabaseQueries";

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
}

const SUPPORT_STATUSES: SupportStatus[] = ["open", "pending", "resolved", "closed"];

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

export async function getSupportSummary(): Promise<SupportSummary> {
  const results = await Promise.all(
    SUPPORT_STATUSES.map((status) =>
      supabase.from("support_tickets").select("id", { count: "exact", head: true }).eq("status", status),
    ),
  );
  const counts = {} as Record<SupportStatus, number>;
  results.forEach(({ count, error }, i) => {
    if (error) throw error;
    counts[SUPPORT_STATUSES[i]] = count ?? 0;
  });
  return { counts };
}

export function listSupportAgents(): Promise<{ items: SupportPerson[] }> {
  return request("/api/admin/support/agents");
}

// Same columns as admin_ticket_row() in backend/api/support.py, with the
// assignee embedded through the assigned_to foreign key.
const TICKET_ROW_COLUMNS =
  "id, number, subject, category, status, priority, source, user_id, requester_email, requester_name, " +
  "identity_verified, previous_ticket_id, created_at, updated_at, last_user_message_at, last_agent_message_at, " +
  "resolved_at, closed_at, assignee:profiles!support_tickets_assigned_to_fkey(id, email, display_name)";

type TicketRowRecord = Omit<SupportTicketRow, "assignee"> & {
  assignee: { id: string; email: string | null; display_name: string | null } | null;
};

export interface SupportTicketQuery {
  status?: SupportStatus;
  category?: SupportCategory;
  /** "me", "unassigned" or an admin's id. */
  assigned?: string;
  q?: string;
  page: number;
  pageSize: number;
}

export async function listSupportTickets(params: SupportTicketQuery): Promise<{ items: SupportTicketRow[]; total: number }> {
  let query = supabase.from("support_tickets").select(TICKET_ROW_COLUMNS, { count: "exact" });
  if (params.status) query = query.eq("status", params.status);
  if (params.category) query = query.eq("category", params.category);
  if (params.assigned === "me") {
    const { data } = await supabase.auth.getSession();
    const userId = data.session?.user.id;
    if (!userId) throw new ApiError(t("Your session has expired. Sign in again."), 401);
    query = query.eq("assigned_to", userId);
  } else if (params.assigned === "unassigned") {
    query = query.is("assigned_to", null);
  } else if (params.assigned) {
    query = query.eq("assigned_to", params.assigned);
  }
  const term = (params.q ?? "").trim().replace(/^#/, "");
  if (/^\d+$/.test(term)) {
    query = query.eq("number", Number(term));
  } else {
    const safe = sanitizeSearch(term).slice(0, 80);
    if (safe) {
      query = query.or(`subject.ilike.*${safe}*,requester_email.ilike.*${safe}*,requester_name.ilike.*${safe}*`);
    }
  }
  // Open tickets: whoever has waited longest first. Elsewhere: newest activity.
  query =
    params.status === "open"
      ? query.order("last_user_message_at", { ascending: true })
      : query.order("updated_at", { ascending: false });
  const from = (params.page - 1) * params.pageSize;
  const { data, count, error } = await query.range(from, from + params.pageSize - 1);
  if (error) throw error;
  const rows = (data ?? []) as unknown as TicketRowRecord[];
  return {
    items: rows.map(({ assignee, ...row }) => ({
      ...row,
      assignee: assignee ? { id: assignee.id, email: assignee.email, name: assignee.display_name } : null,
    })),
    total: count ?? rows.length,
  };
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
