// "User activities log" in the user panel: everything that happened to one
// account — sign-ins, plan and credit changes, purchases, document actions,
// recovery email, support. Rows are written by database triggers
// (supabase/migrations/20261018020000_user_activity_log.sql), never by this
// app; admins can only read them (user_activity_log_select_admin_only).
import { supabase } from "@etymos/shared";
import { currentLocale, t, tr } from "./i18n";

export type ActivityCategory =
  | "account"
  | "plan"
  | "credits"
  | "purchase"
  | "document"
  | "security"
  | "verification"
  | "support";

export type ActivityActorKind = "user" | "admin" | "system";

export interface ActivityLogEntry {
  id: number;
  user_id: string;
  actor_id: string | null;
  actor_kind: ActivityActorKind;
  category: ActivityCategory;
  action: string;
  subject: string | null;
  ref_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export const ACTIVITY_CATEGORIES: { id: ActivityCategory; label: string }[] = [
  { id: "account", label: tr("Account") },
  { id: "plan", label: tr("Plan") },
  { id: "credits", label: tr("Credits") },
  { id: "purchase", label: tr("Purchases") },
  { id: "document", label: tr("Documents") },
  { id: "security", label: tr("Security") },
  { id: "verification", label: tr("Verification") },
  { id: "support", label: tr("Support") },
];

export const ACTIVITY_PAGE_SIZE = 50;

/** Newest first, one page at a time; `category` null means every category. */
export async function listUserActivity(
  userId: string,
  { category, offset = 0 }: { category: ActivityCategory | null; offset?: number },
): Promise<ActivityLogEntry[]> {
  let query = supabase
    .from("user_activity_log")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(offset, offset + ACTIVITY_PAGE_SIZE - 1);
  if (category) query = query.eq("category", category);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as ActivityLogEntry[];
}

// --- Describing an entry -----------------------------------------------------

type Change<T = unknown> = { from?: T; to?: T };

const PLAN_NAMES: Record<string, string> = {
  free: tr("Free"),
  student: tr("Standard"),
  professional: tr("Premium"),
};

const PACK_NAMES: Record<string, string> = {
  "pack-standard": tr("Standard"),
  "pack-premium": tr("Premium"),
};

const NONE = "—";

function plan(tier: unknown): string {
  return typeof tier === "string" ? t(PLAN_NAMES[tier] ?? tier) : NONE;
}

function date(value: unknown): string {
  return typeof value === "string" ? new Date(value).toLocaleString(currentLocale()) : NONE;
}

function text(value: unknown): string {
  return value == null || value === "" ? NONE : String(value);
}

function money(amount: unknown, currency: unknown): string {
  if (typeof amount !== "number") return NONE;
  try {
    return new Intl.NumberFormat(currentLocale(), {
      style: "currency",
      currency: typeof currency === "string" ? currency : "VND",
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${amount} ${text(currency)}`;
  }
}

function arrow(change: Change | undefined, format: (v: unknown) => string = text): string {
  return `${format(change?.from)} → ${format(change?.to)}`;
}

/** "Premium plan (monthly) · 199.000 ₫" / "3 × Standard checks · 57.000 ₫". */
function order(m: Record<string, unknown>): string {
  const what =
    m.kind === "plan"
      ? m.billing_cycle
        ? t("{{plan}} plan ({{cycle}})", { plan: plan(m.plan_tier), cycle: t(text(m.billing_cycle)) })
        : t("{{plan}} plan", { plan: plan(m.plan_tier) })
      : t("{{quantity}} × {{pack}} checks", {
          quantity: text(m.quantity ?? 1),
          pack: t(PACK_NAMES[String(m.pack_id)] ?? text(m.pack_id)),
        });
  return `${what} · ${money(m.amount, m.currency)}`;
}

export interface ActivityDescription {
  title: string;
  /** Second line: the specifics, e.g. "5 → 4" or a document title. */
  detail: string | null;
}

/** Turns one log row into the two lines the panel shows, in the UI language. */
export function describeActivity(entry: ActivityLogEntry): ActivityDescription {
  const m = entry.metadata ?? {};
  const subject = entry.subject;

  switch (entry.action) {
    // account
    case "account.created":
      return { title: t("Signed up"), detail: subject };
    case "account.signed_in":
      return { title: t("Signed in"), detail: m.provider ? t("via {{provider}}", { provider: text(m.provider) }) : null };
    case "account.profile_updated": {
      const parts: string[] = [];
      if (m.display_name) parts.push(`${t("Display name")}: ${arrow(m.display_name as Change)}`);
      if (m.email) parts.push(`${t("Email")}: ${arrow(m.email as Change)}`);
      return { title: t("Profile updated"), detail: parts.join(" · ") || null };
    }
    case "account.role_changed":
      return { title: t("Role changed"), detail: arrow(m as Change) };
    case "account.access_changed":
      return { title: t("Access changed"), detail: arrow(m as Change) };
    case "account.banned":
      return {
        title: t("Banned"),
        detail: [
          m.permanent ? t("Permanently") : t("Until {{n}}", { n: date(m.until) }),
          m.reason ? `“${text(m.reason)}”` : null,
        ]
          .filter(Boolean)
          .join(" · "),
      };
    case "account.unbanned":
      return { title: t("Unbanned"), detail: null };
    case "account.deletion_requested":
      return { title: t("Account deletion requested"), detail: null };
    case "account.deletion_cancelled":
      return { title: t("Account deletion request cancelled"), detail: null };

    // plan
    case "plan.changed": {
      const parts: string[] = [];
      if (m.plan_tier) parts.push(`${t("Plan")}: ${arrow(m.plan_tier as Change, plan)}`);
      if (m.billing_cycle) parts.push(`${t("Billing cycle")}: ${arrow(m.billing_cycle as Change, (v) => t(text(v)))}`);
      if (m.plan_expires_at) parts.push(`${t("Plan ends")}: ${arrow(m.plan_expires_at as Change, date)}`);
      return { title: t("Plan changed"), detail: parts.join(" · ") };
    }
    case "plan.expired":
      return { title: t("Plan expired"), detail: arrow(m.plan_tier as Change, plan) };
    case "plan.usage":
      return { title: t("Used a plan check"), detail: t("Checks used this period: {{change}}", { change: arrow(m as Change) }) };
    case "plan.usage_reset":
      return { title: t("Plan usage reset"), detail: t("Checks used this period: {{change}}", { change: arrow(m as Change) }) };

    // credits
    case "credits.changed": {
      const delta = typeof m.delta === "number" ? m.delta : 0;
      const premium = m.balance === "premium";
      const title =
        delta >= 0
          ? premium
            ? t("Premium credits added")
            : t("Standard credits added")
          : premium
            ? t("Premium credits used")
            : t("Standard credits used");
      return { title, detail: `${arrow(m as Change)} (${delta > 0 ? "+" : ""}${delta})` };
    }

    // purchases
    case "purchase.started":
      return { title: t("Started a purchase"), detail: order(m) };
    case "purchase.completed":
      return {
        title: t("Purchase completed"),
        detail:
          typeof m.paid_amount === "number" && m.paid_amount !== m.amount
            ? `${order(m)} · ${t("paid {{amount}}", { amount: money(m.paid_amount, m.currency) })}`
            : order(m),
      };
    case "purchase.declined":
      return { title: t("Purchase declined"), detail: order(m) };
    case "purchase.cancelled":
      return { title: t("Purchase cancelled"), detail: order(m) };
    case "purchase.status_changed":
      return { title: t("Purchase status changed"), detail: `${order(m)} · ${arrow(m.status as Change)}` };

    // documents
    case "document.uploaded":
      return { title: t("Uploaded a document"), detail: subject };
    case "document.check_completed":
      return {
        title: t("Check completed"),
        detail: [
          subject,
          typeof m.similarity_score === "number" ? t("{{score}}% similarity", { score: Math.round(m.similarity_score) }) : null,
        ]
          .filter(Boolean)
          .join(" · "),
      };
    case "document.check_failed":
      return { title: t("Check failed"), detail: [subject, m.error ? text(m.error) : null].filter(Boolean).join(" · ") };
    case "document.renamed":
      return { title: t("Renamed a document"), detail: `“${text(m.from)}” → “${text(m.to)}”` };
    case "document.moved":
      return {
        title: t("Moved a document"),
        detail: `${subject ?? ""} · ${arrow(m as Change, (v) => (v == null ? t("No project") : String(v)))}`,
      };
    case "document.trashed":
      return { title: t("Moved a document to trash"), detail: subject };
    case "document.restored":
      return { title: t("Restored a document from trash"), detail: subject };
    case "document.deleted":
      return { title: t("Deleted a document permanently"), detail: subject };
    case "document.version_saved":
      return { title: t("Saved a document version"), detail: [subject, m.label ? text(m.label) : null].filter(Boolean).join(" · ") };
    case "document.rechecked":
      return {
        title: m.kind === "paid_recheck" ? t("Re-checked a document (1 check)") : t("Re-checked a document (free)"),
        detail: [
          subject,
          typeof m.changed_ratio === "number" ? t("{{percent}}% changed", { percent: Math.round(m.changed_ratio * 100) }) : null,
          typeof m.similarity_score === "number" ? t("{{score}}% similarity", { score: Math.round(m.similarity_score) }) : null,
        ]
          .filter(Boolean)
          .join(" · "),
      };
    case "document.moderated":
      return { title: t("Document moderation changed"), detail: `${subject ?? ""} · ${arrow(m as Change)}` };

    // security
    case "security.recovery_email_added":
      return { title: t("Added a recovery email"), detail: subject };
    case "security.recovery_email_changed":
      return { title: t("Changed the recovery email"), detail: arrow(m as Change) };
    case "security.recovery_email_verified":
      return { title: t("Verified the recovery email"), detail: subject };
    case "security.recovery_email_removed":
      return { title: t("Removed the recovery email"), detail: subject };
    case "security.password_reset_requested":
      return { title: t("Requested a password reset"), detail: subject };
    case "security.password_changed":
      return { title: t("Changed password"), detail: null };
    case "security.login_email_changed":
      return { title: t("Changed sign-in email"), detail: arrow(m as Change) };

    // verification
    case "verification.submitted":
      return { title: t("Submitted student verification"), detail: null };
    case "verification.approved":
      return { title: t("Student verification approved"), detail: null };
    case "verification.rejected":
      return { title: t("Student verification rejected"), detail: null };
    case "verification.reopened":
      return { title: t("Student verification reopened"), detail: null };
    case "verification.granted":
      return { title: t("Marked as student verified"), detail: null };
    case "verification.revoked":
      return { title: t("Student verification removed"), detail: null };

    // support
    case "support.ticket_opened":
      return { title: t("Opened a support ticket"), detail: [m.number ? `#${text(m.number)}` : null, subject].filter(Boolean).join(" · ") };
    case "support.ticket_status_changed":
      return { title: t("Support ticket status changed"), detail: `#${text(m.number)} · ${arrow(m as Change)}` };
    case "support.message_sent":
      return { title: t("Replied on a support ticket"), detail: `#${text(m.number)} · ${subject ?? ""}` };
    case "support.reply_received":
      return { title: t("Received a support reply"), detail: `#${text(m.number)} · ${subject ?? ""}` };

    default:
      return { title: entry.action, detail: subject };
  }
}
