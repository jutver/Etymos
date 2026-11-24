// Read-time projection and human formatting for Logs > Admin actions.
// Keeps Simple mode concise and noise-free without modifying immutable rows in
// public.admin_action_log (Debug mode still renders raw ungrouped entries).
import { actionTone, describeAction, type ActionTone, type AdminActionEntry } from "./adminActionLogQueries";
import { currentLocale, t, tn, tr } from "./i18n";
import { billingCycleLabel, planLabel } from "./plans";

export const DEBUG_MODE_STORAGE_KEY = "etymos_admin_actions_debug_mode";
const BURST_WINDOW_MS = 5000;
const RECIPIENT_TABLES = new Set(["announcement_emails", "maintenance_bypass"]);
const IGNORED_SIMPLE_FIELDS = new Set([
  "id",
  "created_at",
  "created_by",
  "updated_at",
  "announcement_id",
  "user_id",
  "personal",
  "banned_by",
  "support_banned_by",
]);

export interface SimpleFieldChange {
  key: string;
  label: string;
  from?: string;
  to?: string;
  kind: "diff" | "added" | "removed" | "info";
}

export interface SimpleActionItem {
  key: string;
  primaryEntry: AdminActionEntry;
  entries: AdminActionEntry[];
  createdAt: string;
  actorLabel: string;
  actionText: string;
  subjectText: string | null;
  inlineSummary: string | null;
  tone: ActionTone;
  targetUserId: string | null;
  fieldChanges: SimpleFieldChange[];
  canExpand: boolean;
}

const FIELD_LABELS: Record<string, string> = {
  title: tr("Title"),
  title_vi: tr("Title (VI)"),
  message: tr("Message"),
  message_vi: tr("Message (VI)"),
  severity: tr("Colour"),
  icon: tr("Icon"),
  image_path: tr("Image"),
  countdown_to: tr("Countdown"),
  starts_at: tr("Start time"),
  ends_at: tr("End time"),
  is_active: tr("Active"),
  enabled: tr("Enabled"),
  audience: tr("Audience"),
  audience_plans: tr("Audience plans"),
  popup_placement: tr("Placement"),
  button_label: tr("Button text"),
  button_label_vi: tr("Button text (VI)"),
  button_url: tr("Button link"),
  plan_tier: tr("Plan tier"),
  billing_cycle: tr("Billing cycle"),
  plan_expires_at: tr("Plan ends"),
  standard_credits: tr("Standard credits"),
  premium_credits: tr("Premium credits"),
  student_verified: tr("Student verified"),
  role: tr("Role"),
  banned_permanent: tr("Permanent ban"),
  banned_until: tr("Banned until"),
  ban_reason: tr("Ban reason"),
  support_banned_permanent: tr("Support ban"),
  support_banned_until: tr("Support banned until"),
  support_ban_reason: tr("Support ban reason"),
  status: tr("Status"),
  priority: tr("Priority"),
  category: tr("Category"),
  subject: tr("Subject"),
  code: tr("Code"),
  discount_percent: tr("Discount"),
  price_vnd: tr("Price"),
  amount: tr("Amount"),
  max_uses: tr("Max uses"),
  expires_at: tr("Expires"),
  value: tr("Value"),
  email: tr("Email"),
  kind: tr("Type"),
  level: tr("Log level"),
};

const KIND_VALUE_LABELS: Record<string, string> = {
  banner: tr("Top bar"),
  popup: tr("Pop-up"),
  maintenance: tr("Maintenance"),
};

const SEVERITY_VALUE_LABELS: Record<string, string> = {
  info: tr("Info"),
  success: tr("Success"),
  warning: tr("Warning"),
  error: tr("Critical"),
};

const AUDIENCE_VALUE_LABELS: Record<string, string> = {
  everyone: tr("Everyone"),
  signed_in: tr("Signed-in users"),
  plans: tr("Plans"),
  emails: tr("Chosen people"),
};

const PLACEMENT_VALUE_LABELS: Record<string, string> = {
  home: tr("Home page"),
  landing: tr("Landing page"),
  both: tr("Both"),
};

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

export function readDebugMode(): boolean {
  try {
    if (typeof window === "undefined" || !window.localStorage) return false;
    return window.localStorage.getItem(DEBUG_MODE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeDebugMode(enabled: boolean): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    window.localStorage.setItem(DEBUG_MODE_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // Ignore storage errors (private browsing / restricted storage).
  }
}

function truncateText(text: string, max = 120): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

export function formatHumanFieldLabel(fieldKey: string): string {
  const mapped = FIELD_LABELS[fieldKey];
  if (mapped) return t(mapped);
  const spaced = fieldKey.replace(/_/g, " ").trim();
  if (!spaced) return fieldKey;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function formatHumanValue(fieldKey: string, value: unknown): string {
  if (value === undefined) return "—";
  if (value === null || value === "") {
    if (fieldKey === "starts_at") return t("Immediately");
    if (fieldKey === "ends_at" || fieldKey === "plan_expires_at" || fieldKey === "expires_at") return t("No end date");
    if (fieldKey === "countdown_to") return t("Off");
    return t("None");
  }
  if (typeof value === "boolean") return value ? t("Yes") : t("No");
  if (typeof value === "number") return value.toLocaleString(currentLocale());
  if (Array.isArray(value)) {
    if (value.length === 0) return t("None");
    return value
      .map((item) => (fieldKey === "audience_plans" && typeof item === "string" ? planLabel(item) : formatHumanValue("", item)))
      .join(", ");
  }
  if (typeof value === "string") {
    if (fieldKey === "kind" && KIND_VALUE_LABELS[value]) return t(KIND_VALUE_LABELS[value]);
    if (fieldKey === "severity" && SEVERITY_VALUE_LABELS[value]) return t(SEVERITY_VALUE_LABELS[value]);
    if (fieldKey === "audience" && AUDIENCE_VALUE_LABELS[value]) return t(AUDIENCE_VALUE_LABELS[value]);
    if (fieldKey === "popup_placement" && PLACEMENT_VALUE_LABELS[value]) return t(PLACEMENT_VALUE_LABELS[value]);
    if (fieldKey === "plan_tier") return planLabel(value);
    if (fieldKey === "billing_cycle") return billingCycleLabel(value);
    if (ISO_TIMESTAMP_RE.test(value)) {
      const ms = Date.parse(value);
      if (Number.isFinite(ms)) {
        return new Date(ms).toLocaleString(currentLocale(), { dateStyle: "medium", timeStyle: "short" });
      }
    }
    return truncateText(value, 120);
  }
  return truncateText(JSON.stringify(value), 120);
}

function announcementIdOf(entry: AdminActionEntry): string | null {
  if (entry.target_table === "announcements" && entry.target_id) {
    return entry.target_id;
  }
  if (entry.target_table && RECIPIENT_TABLES.has(entry.target_table)) {
    if (entry.target_id) {
      const prefix = entry.target_id.split("/")[0]?.trim();
      if (prefix) return prefix;
    }
    const toId = entry.changes.announcement_id?.to;
    if (typeof toId === "string" && toId.trim()) return toId.trim();
    const fromId = entry.changes.announcement_id?.from;
    if (typeof fromId === "string" && fromId.trim()) return fromId.trim();
  }
  return null;
}

function recipientEmailOf(entry: AdminActionEntry): string | null {
  const candidates = [entry.changes.email?.to, entry.changes.email?.from, entry.summary, entry.target_id?.split("/")[1]];
  for (const raw of candidates) {
    if (typeof raw === "string" && raw.trim()) return raw.trim();
  }
  return null;
}

function actorKeyOf(entry: AdminActionEntry): string {
  return entry.actor_id ?? entry.actor_email ?? "__unknown__";
}

function actorLabelOf(entry: AdminActionEntry): string {
  return entry.actor_email ?? entry.actor_id?.slice(0, 8) ?? t("Unknown admin");
}

function pickChangeText(change: { from?: unknown; to?: unknown } | undefined): string | null {
  if (!change) return null;
  for (const candidate of [change.to, change.from]) {
    if (typeof candidate === "string" && candidate.trim()) return truncateText(candidate, 80);
  }
  return null;
}

function subjectForEntry(entry: AdminActionEntry): string | null {
  if (entry.summary && entry.summary.trim()) {
    return truncateText(entry.summary, 90);
  }
  if (entry.target_table === "announcements") {
    for (const key of ["title", "title_vi", "message", "message_vi"]) {
      const val = pickChangeText(entry.changes[key]);
      if (val) return val;
    }
  }
  return null;
}

function buildFieldChangesForEntry(entry: AdminActionEntry): SimpleFieldChange[] {
  const out: SimpleFieldChange[] = [];
  for (const [key, change] of Object.entries(entry.changes)) {
    if (IGNORED_SIMPLE_FIELDS.has(key)) continue;
    const hasFrom = "from" in change;
    const hasTo = "to" in change;
    if (!hasFrom && !hasTo) continue;
    const fromFormatted = hasFrom ? formatHumanValue(key, change.from) : undefined;
    const toFormatted = hasTo ? formatHumanValue(key, change.to) : undefined;
    if (hasFrom && hasTo && fromFormatted === toFormatted && change.from === change.to) continue;
    out.push({
      key,
      label: formatHumanFieldLabel(key),
      ...(hasFrom ? { from: fromFormatted } : {}),
      ...(hasTo ? { to: toFormatted } : {}),
      kind: hasFrom && hasTo ? "diff" : hasTo ? "added" : "removed",
    });
  }
  return out;
}

function formatRecipientList(emails: string[]): string {
  if (emails.length <= 5) return emails.join(", ");
  return `${emails.slice(0, 5).join(", ")} (+${emails.length - 5})`;
}

function recipientBadgeText(kind: "added" | "removed", emails: string[]): string {
  if (emails.length <= 2) {
    return `${kind === "added" ? t("Recipients added") : t("Recipients removed")}: ${emails.join(", ")}`;
  }
  return kind === "added"
    ? tn(emails.length, "Added {{count}} recipient", "Added {{count}} recipients")
    : tn(emails.length, "Removed {{count}} recipient", "Removed {{count}} recipients");
}

function buildInlineSummary(
  fieldChanges: SimpleFieldChange[],
  netAdded: string[],
  netRemoved: string[],
): string | null {
  if (fieldChanges.length === 0) return null;
  if (fieldChanges.length === 1) {
    const only = fieldChanges[0]!;
    if (only.key === "_recipients_added" && netAdded.length > 0) {
      return recipientBadgeText("added", netAdded);
    }
    if (only.key === "_recipients_removed" && netRemoved.length > 0) {
      return recipientBadgeText("removed", netRemoved);
    }
    if (only.from !== undefined && only.to !== undefined) {
      return `${only.label}: ${only.from} → ${only.to}`;
    }
    if (only.to !== undefined) {
      return `${only.label}: ${only.to}`;
    }
    if (only.from !== undefined) {
      return `${only.label}: ${only.from}`;
    }
    return only.label;
  }
  const labels = fieldChanges.slice(0, 3).map((fc) => fc.label);
  return fieldChanges.length > 3 ? `${labels.join(", ")} (+${fieldChanges.length - 3})` : labels.join(", ");
}

interface PendingGroup {
  actorKey: string;
  announcementId: string | null;
  anchorMs: number;
  entries: AdminActionEntry[];
  hasParent: boolean;
}

export function buildSimpleActionFeed(entries: AdminActionEntry[]): SimpleActionItem[] {
  const groups: PendingGroup[] = [];

  for (const entry of entries) {
    const announcementId = announcementIdOf(entry);
    const actorKey = actorKeyOf(entry);
    const entryMs = Date.parse(entry.created_at);
    const isParent = entry.target_table === "announcements";

    let matched: PendingGroup | undefined;
    if (announcementId) {
      for (let i = groups.length - 1; i >= 0; i--) {
        const g = groups[i]!;
        if (g.announcementId !== announcementId || g.actorKey !== actorKey) continue;
        if (isParent && g.hasParent) continue;
        const withinWindow =
          Number.isFinite(entryMs) && Number.isFinite(g.anchorMs)
            ? Math.abs(g.anchorMs - entryMs) <= BURST_WINDOW_MS
            : true;
        if (withinWindow) {
          matched = g;
          break;
        }
      }
    }

    if (matched) {
      matched.entries.push(entry);
      if (isParent) matched.hasParent = true;
    } else {
      groups.push({
        actorKey,
        announcementId,
        anchorMs: entryMs,
        entries: [entry],
        hasParent: isParent,
      });
    }
  }

  const items: SimpleActionItem[] = [];

  for (const group of groups) {
    if (!group.announcementId) {
      const entry = group.entries[0]!;
      const fieldChanges = buildFieldChangesForEntry(entry);
      items.push({
        key: `simple-${entry.id}`,
        primaryEntry: entry,
        entries: [entry],
        createdAt: entry.created_at,
        actorLabel: actorLabelOf(entry),
        actionText: describeAction(entry),
        subjectText: subjectForEntry(entry),
        inlineSummary: buildInlineSummary(fieldChanges, [], []),
        tone: actionTone(entry),
        targetUserId: entry.target_user_id,
        fieldChanges,
        canExpand: fieldChanges.length > 0,
      });
      continue;
    }

    const parentEntry = group.entries.find((e) => e.target_table === "announcements") ?? null;
    const recipientEntries = group.entries.filter((e) => e.target_table && RECIPIENT_TABLES.has(e.target_table));

    const added = new Map<string, string>();
    const removed = new Map<string, string>();

    for (const r of recipientEntries) {
      const email = recipientEmailOf(r);
      if (!email) continue;
      const norm = email.toLowerCase();
      if (r.action.endsWith(".insert")) {
        if (removed.has(norm)) removed.delete(norm);
        else added.set(norm, email);
      } else if (r.action.endsWith(".delete")) {
        if (added.has(norm)) added.delete(norm);
        else removed.set(norm, email);
      }
    }

    const netAdded = [...added.values()].sort((a, b) => a.localeCompare(b));
    const netRemoved = [...removed.values()].sort((a, b) => a.localeCompare(b));

    // Historical pure no-op bursts (N identical deletes + N identical inserts with no parent mutation)
    if (!parentEntry && netAdded.length === 0 && netRemoved.length === 0) {
      continue;
    }

    const primary = parentEntry ?? group.entries[0]!;
    const fieldChanges = parentEntry ? buildFieldChangesForEntry(parentEntry) : [];
    if (netAdded.length > 0) {
      fieldChanges.push({
        key: "_recipients_added",
        label: t("Recipients added"),
        to: formatRecipientList(netAdded),
        kind: "added",
      });
    }
    if (netRemoved.length > 0) {
      fieldChanges.push({
        key: "_recipients_removed",
        label: t("Recipients removed"),
        from: formatRecipientList(netRemoved),
        kind: "removed",
      });
    }

    const tone: ActionTone = parentEntry
      ? actionTone(parentEntry)
      : netAdded.length > 0 && netRemoved.length === 0
        ? "create"
        : netRemoved.length > 0 && netAdded.length === 0
          ? "delete"
          : "change";

    const actionText = parentEntry ? describeAction(parentEntry) : t("Updated announcement recipients");
    const targetUserId =
      parentEntry?.target_user_id ?? group.entries.find((e) => Boolean(e.target_user_id))?.target_user_id ?? null;

    items.push({
      key: `simple-${primary.id}`,
      primaryEntry: primary,
      entries: group.entries,
      createdAt: primary.created_at,
      actorLabel: actorLabelOf(primary),
      actionText,
      subjectText: parentEntry ? subjectForEntry(parentEntry) : null,
      inlineSummary: buildInlineSummary(fieldChanges, netAdded, netRemoved),
      tone,
      targetUserId,
      fieldChanges,
      canExpand: fieldChanges.length > 0,
    });
  }

  return items;
}
