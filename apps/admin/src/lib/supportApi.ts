// Support inbox. Everything except replying goes straight to Supabase:
// admins may read the support tables and the support-attachments bucket, and
// edit a ticket's fields through admin_update_support_ticket(). Replies and
// notes go through the backend (backend/api/support.py, /api/admin/support/*)
// because replies are emailed from the support mailbox.
import { supabase } from "@etymos/shared";
import { ApiError } from "./api";
import { t } from "./i18n";
import { sanitizeSearch } from "./supabaseQueries";
import { deleteRecordsWithFiles, type DeleteResult, type DeleteScope } from "./storageFiles";

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
  /** In the support-attachments bucket; see openSupportFile(). */
  path: string;
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
  raw_email_path: string | null;
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
  support_banned_permanent: boolean | null;
  support_banned_until: string | null;
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

type ProfileRef = { id: string; email: string | null; display_name: string | null };

function toPerson(p: ProfileRef): SupportPerson {
  return { id: p.id, email: p.email, name: p.display_name };
}

export async function listSupportAgents(): Promise<{ items: SupportPerson[] }> {
  const { data, error } = await supabase.from("profiles").select("id, email, display_name").eq("role", "admin");
  if (error) throw error;
  const items = (data ?? []).map(toPerson);
  items.sort((a, b) => (a.name || a.email || "").toLowerCase().localeCompare((b.name || b.email || "").toLowerCase()));
  return { items };
}

// Same columns as admin_ticket_row() in backend/api/support.py, with the
// assignee embedded through the assigned_to foreign key.
const TICKET_ROW_COLUMNS =
  "id, number, subject, category, status, priority, source, user_id, requester_email, requester_name, " +
  "identity_verified, previous_ticket_id, created_at, updated_at, last_user_message_at, last_agent_message_at, " +
  "resolved_at, closed_at, assignee:profiles!support_tickets_assigned_to_fkey(id, email, display_name)";

type TicketRowRecord = Omit<SupportTicketRow, "assignee"> & { assignee: ProfileRef | null };

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
  return { items: rows.map(toTicketRow), total: count ?? rows.length };
}

function toTicketRow({ assignee, ...row }: TicketRowRecord): SupportTicketRow {
  return { ...row, assignee: assignee ? toPerson(assignee) : null };
}

const ACCOUNT_COLUMNS =
  "id, email, display_name, role, plan_tier, billing_cycle, plan_expires_at, standard_credits, premium_credits, " +
  "student_verified, created_at, banned_permanent, banned_until, support_banned_permanent, support_banned_until, " +
  "deletion_requested_at";

const MESSAGE_COLUMNS =
  "id, author_type, body, internal, channel, sender_email, sender_auth, sender_mismatch, raw_email_path, created_at, " +
  "author:profiles(id, email, display_name), attachments:support_attachments(id, filename, content_type, size_bytes, path)";

type MessageRecord = Omit<SupportAdminMessage, "author"> & { author: ProfileRef | null };

/** The ticket with its conversation and the requester's account: the same
 * shape the backend's admin_conversation() built. */
export async function getSupportTicket(number: number): Promise<SupportTicketDetail> {
  const { data: ticket, error } = await supabase
    .from("support_tickets")
    .select(`${TICKET_ROW_COLUMNS}, previous:previous_ticket_id(number)`)
    .eq("number", number)
    .maybeSingle();
  if (error) throw error;
  if (!ticket) throw new ApiError(t("This support request doesn't exist."), 404);
  const row = ticket as unknown as TicketRowRecord & { previous: { number: number } | null };

  // A guest or email ticket shows the account using the same address, which
  // isn't proof it's the same person (the page says so).
  const account = row.user_id
    ? supabase.from("profiles").select(ACCOUNT_COLUMNS).eq("id", row.user_id).maybeSingle()
    : supabase.from("profiles").select(ACCOUNT_COLUMNS).eq("email", row.requester_email).limit(1).maybeSingle();
  const [messages, accountResult] = await Promise.all([
    supabase.from("support_messages").select(MESSAGE_COLUMNS).eq("ticket_id", row.id).order("created_at"),
    account,
  ]);
  if (messages.error) throw messages.error;
  if (accountResult.error) throw accountResult.error;

  const { previous, ...rest } = row;
  return {
    ...toTicketRow(rest),
    previous_ticket_number: previous?.number ?? null,
    account: (accountResult.data as SupportAccount | null) ?? null,
    messages: ((messages.data ?? []) as unknown as MessageRecord[]).map(({ author, ...m }) => ({
      ...m,
      author: author ? toPerson(author) : null,
    })),
  };
}

/** Deletes tickets with their messages, attachments and original emails. */
export function deleteSupportTickets(scope: DeleteScope): Promise<DeleteResult> {
  return deleteRecordsWithFiles("admin_delete_support_tickets", "support-attachments", scope);
}

/** Opens an attachment or original email in a new tab. The link is signed
 * on click, so it never goes stale however long the ticket stays open. The
 * tab opens first, before the await, so the browser doesn't treat it as a
 * popup. */
export async function openSupportFile(path: string): Promise<void> {
  const tab = window.open("about:blank", "_blank");
  if (tab) tab.opener = null;
  const { data, error } = await supabase.storage.from("support-attachments").createSignedUrl(path, 60);
  if (error || !data) {
    tab?.close();
    throw error ?? new Error(t("Couldn't open the file."));
  }
  if (tab) tab.location.href = data.signedUrl;
  else window.open(data.signedUrl, "_blank", "noopener");
}

/** A public reply is emailed to the requester (ApiError 502 "send_failed"
 * if the mail server refuses it — nothing is saved then). An internal note
 * is only visible here. Reload the ticket with getSupportTicket() after. */
export function postSupportMessage(
  number: number,
  input: { body: string; internal: boolean; setStatus?: SupportStatus; files: File[] },
): Promise<{ id: string }> {
  const form = new FormData();
  form.append("body", input.body);
  form.append("internal", String(input.internal));
  if (input.setStatus) form.append("set_status", input.setStatus);
  for (const file of input.files) form.append("files", file);
  return request(`/api/admin/support/tickets/${number}/messages`, { method: "POST", body: form });
}

export type SupportTicketPatch = Partial<{
  status: SupportStatus;
  priority: "normal" | "high";
  category: SupportCategory;
  /** An admin's id, or "" to unassign. */
  assigned_to: string;
}>;

/** The ticket fields as saved, from admin_update_support_ticket(). */
export type SupportTicketFields = Pick<
  SupportTicketRow,
  "status" | "priority" | "category" | "resolved_at" | "closed_at" | "updated_at"
> & { assigned_to: string | null };

/** Ticket fields send no email, so they're saved straight to the database
 * (supabase/migrations/20261018040000_admin_update_support_ticket.sql)
 * rather than through the backend. */
export async function updateSupportTicket(number: number, patch: SupportTicketPatch): Promise<SupportTicketFields> {
  const { data, error } = await supabase
    .rpc("admin_update_support_ticket", {
      p_number: number,
      p_status: patch.status ?? null,
      p_priority: patch.priority ?? null,
      p_category: patch.category ?? null,
      p_assigned_to: patch.assigned_to ?? null,
    })
    .single();
  if (error) throw error;
  return data as SupportTicketFields;
}
