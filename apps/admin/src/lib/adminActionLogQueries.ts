// Logs > Admin actions: everything admins did, newest first. Rows are written
// by database triggers (portal changes, sign-ins) and by the backend (support
// replies, force deletes, server actions, reading users' documents); see
// supabase/migrations/20261108000000_admin_action_log.sql. Admins can only
// read them.
import { supabase } from "@etymos/shared";
import { sanitizeSearch } from "./supabaseQueries";
import { t, tr } from "./i18n";

export interface AdminActionEntry {
  id: number;
  created_at: string;
  actor_id: string | null;
  actor_email: string | null;
  source: "portal" | "backend";
  action: string;
  target_table: string | null;
  target_id: string | null;
  target_user_id: string | null;
  summary: string | null;
  changes: Record<string, { from?: unknown; to?: unknown }>;
  metadata: Record<string, unknown>;
}

/** What the "Area" filter picks: tables, or exact actions. */
export const AREAS = {
  accounts: { label: tr("Accounts"), tables: ["profiles"] },
  documents: { label: tr("Documents"), tables: ["documents", "document_versions"] },
  messages: { label: tr("Announcements and messages"), tables: ["announcements", "announcement_emails", "announcement_views"] },
  pricing: { label: tr("Pricing"), tables: ["plan_definitions", "plan_discounts", "discount_codes", "credit_packs"] },
  payments: { label: tr("Orders and payments"), tables: ["checkout_events", "payment_transactions"] },
  support: { label: tr("Support"), tables: ["support_tickets", "support_messages"] },
  verification: { label: tr("Student verification"), tables: ["student_verification_requests"] },
  settings: { label: tr("Settings"), tables: ["feature_flags", "maintenance_bypass"] },
  server: { label: tr("Server"), tables: ["server"] },
  viewing: { label: tr("Viewing users' documents"), actions: ["user_data.viewed"] },
  signins: { label: tr("Sign-ins"), actions: ["auth.sign_in"] },
} as const satisfies Record<string, { label: string; tables?: readonly string[]; actions?: readonly string[] }>;

export type AreaKey = keyof typeof AREAS;

export interface AdminActionFilters {
  actorId: string;
  area: AreaKey | "";
  /** yyyy-mm-dd, local time, inclusive. */
  from: string;
  to: string;
  search: string;
  targetUserId: string;
}

export const PAGE_SIZE = 50;

export async function listAdminActions(
  filters: AdminActionFilters,
  beforeId?: number,
): Promise<{ rows: AdminActionEntry[]; more: boolean }> {
  let query = supabase
    .from("admin_action_log")
    .select("*")
    .order("id", { ascending: false })
    .limit(PAGE_SIZE + 1);
  if (beforeId) query = query.lt("id", beforeId);
  if (filters.actorId) query = query.eq("actor_id", filters.actorId);
  if (filters.targetUserId) query = query.eq("target_user_id", filters.targetUserId);
  if (filters.area) {
    const area: { tables?: readonly string[]; actions?: readonly string[] } = AREAS[filters.area];
    if (area.tables) query = query.in("target_table", [...area.tables]);
    if (area.actions) query = query.in("action", [...area.actions]);
  }
  if (filters.from) query = query.gte("created_at", new Date(`${filters.from}T00:00:00`).toISOString());
  if (filters.to) {
    const end = new Date(`${filters.to}T00:00:00`);
    end.setDate(end.getDate() + 1);
    query = query.lt("created_at", end.toISOString());
  }
  const q = sanitizeSearch(filters.search);
  if (q) {
    query = query.or(
      ["summary", "action", "actor_email", "target_id", "target_table"].map((c) => `${c}.ilike.%${q}%`).join(","),
    );
  }
  const { data, error } = await query;
  if (error) throw error;
  const rows = (data ?? []) as AdminActionEntry[];
  return { rows: rows.slice(0, PAGE_SIZE), more: rows.length > PAGE_SIZE };
}

export async function listAdmins(): Promise<{ id: string; email: string | null }[]> {
  const { data, error } = await supabase.from("profiles").select("id, email").eq("role", "admin").order("email");
  if (error) throw error;
  return data ?? [];
}

// --- Describing an entry ---------------------------------------------------------

const TABLE_THINGS: Record<string, string> = {
  profiles: tr("account"),
  documents: tr("document"),
  document_versions: tr("document version"),
  announcements: tr("announcement"),
  announcement_emails: tr("announcement recipient"),
  announcement_views: tr("message view"),
  plan_definitions: tr("plan"),
  plan_discounts: tr("plan discount"),
  discount_codes: tr("discount code"),
  credit_packs: tr("credit pack"),
  feature_flags: tr("feature flag"),
  maintenance_bypass: tr("maintenance bypass"),
  student_verification_requests: tr("student verification"),
  checkout_events: tr("order"),
  payment_transactions: tr("bank transfer"),
  support_tickets: tr("support ticket"),
  support_messages: tr("support message"),
  referral_survey_responses: tr("referral survey answer"),
};

const VERBS: Record<string, string> = {
  insert: tr("Created {{thing}}"),
  update: tr("Changed {{thing}}"),
  delete: tr("Deleted {{thing}}"),
};

const BACKEND_ACTIONS: Record<string, string> = {
  "auth.sign_in": tr("Signed in"),
  "support.replied": tr("Replied to a support ticket"),
  "support.note_added": tr("Added an internal note to a support ticket"),
  "support.ticket_updated": tr("Updated a support ticket"),
  "user.force_deleted": tr("Force-deleted an account"),
  "user_data.viewed": tr("Opened a user's document"),
  "server.log_level": tr("Changed the server log level"),
  "server.dump_threads": tr("Wrote thread stacks to the server log"),
  "server.free_gpu": tr("Unloaded idle GPU models"),
  "server.run_notifications": tr("Sent due notifications"),
  "server.poll_support_inbox": tr("Checked the support inbox"),
  "server.restart_api": tr("Restarted the API"),
};

/** "Changed account", "Replied to a support ticket"... in the current language. */
export function describeAction(entry: AdminActionEntry): string {
  const known = BACKEND_ACTIONS[entry.action];
  if (known) return t(known);
  if (entry.action.startsWith("audit.")) {
    return t("Account action: {{action}}", { action: entry.action.slice("audit.".length).replace(/_/g, " ") });
  }
  const [table, op] = entry.action.split(".");
  const verb = VERBS[op ?? ""];
  const personal = table === "announcements" && (entry.changes.personal?.to === true || entry.changes.personal?.from === true);
  const thing = personal ? tr("personal message") : TABLE_THINGS[table ?? ""];
  if (verb && thing) return t(verb, { thing: t(thing) });
  return entry.action;
}

export type ActionTone = "create" | "change" | "delete" | "neutral";

export function actionTone(entry: AdminActionEntry): ActionTone {
  if (entry.action.endsWith(".insert")) return "create";
  if (entry.action.endsWith(".delete") || entry.action === "user.force_deleted") return "delete";
  if (entry.action.endsWith(".update") || entry.action.startsWith("support.") || entry.action.startsWith("server.")) {
    return "change";
  }
  return "neutral";
}

/** A logged value as short text. */
export function formatValue(value: unknown): string {
  if (value === undefined) return "—";
  if (value === null) return t("empty");
  if (typeof value === "string") return value === "" ? t("empty") : value;
  if (typeof value === "boolean") return value ? t("yes") : t("no");
  return JSON.stringify(value);
}
