// Personal messages: pop-ups sent to one account from that user's page.
// Stored as announcements with personal = true, kind popup, audience emails and
// one address (supabase/migrations/20261107000000_personal_messages.sql).
import { announcementState, supabase, type Announcement } from "@etymos/shared";
import { tr } from "./i18n";
import { createAnnouncement, setAnnouncementEmails, updateAnnouncement, type AnnouncementInput } from "./configQueries";

export interface PersonalMessage {
  announcement: Announcement;
  /** The recipient's address (the announcement's only email). */
  email: string | null;
  /** When the recipient closed it; null = not yet. */
  seenAt: string | null;
  sender: { id: string; email: string | null; display_name: string | null } | null;
  recipient: { id: string; email: string | null; display_name: string | null } | null;
}

export type PersonalMessageStatus = "off" | "scheduled" | "showing" | "seen" | "ended";

export const MESSAGE_STATUS_LABELS: Record<PersonalMessageStatus, string> = {
  off: tr("Off"),
  scheduled: tr("Scheduled"),
  showing: tr("Waiting to be seen"),
  seen: tr("Seen"),
  ended: tr("Ended"),
};

export function personalMessageStatus(m: PersonalMessage, now: number = Date.now()): PersonalMessageStatus {
  if (m.seenAt) return "seen";
  const state = announcementState(m.announcement, now);
  return state === "live" ? "showing" : state;
}

/** What the compose form sets; the rest is fixed for a personal message. */
export type PersonalMessageInput = Pick<
  AnnouncementInput,
  "title" | "message" | "title_vi" | "message_vi" | "image_path" | "button_label" | "button_label_vi" | "button_url" | "starts_at" | "ends_at"
>;

function fullInput(input: PersonalMessageInput): AnnouncementInput {
  return {
    ...input,
    kind: "popup",
    severity: "info",
    icon: null,
    countdown_to: null,
    is_active: true,
    audience: "emails",
    audience_plans: null,
    // The recipient is signed in, so it opens on their home page.
    popup_placement: "home",
  };
}

/** Newest first. With `email`, only the messages sent to that address. */
export async function listPersonalMessages(email?: string | null): Promise<PersonalMessage[]> {
  const address = email?.trim().toLowerCase() ?? null;
  let ids: string[] | null = null;
  if (address) {
    const { data, error } = await supabase.from("announcement_emails").select("announcement_id").eq("email", address);
    if (error) throw error;
    ids = (data ?? []).map((r: { announcement_id: string }) => r.announcement_id);
    if (ids.length === 0) return [];
  }

  let query = supabase.from("announcements").select("*").eq("personal", true).order("created_at", { ascending: false });
  if (ids) query = query.in("id", ids);
  const { data: rows, error } = await query;
  if (error) throw error;
  const announcements = (rows ?? []) as Announcement[];
  if (announcements.length === 0) return [];
  const announcementIds = announcements.map((a) => a.id);

  const [emailsRes, viewsRes] = await Promise.all([
    supabase.from("announcement_emails").select("announcement_id, email").in("announcement_id", announcementIds),
    supabase.from("announcement_views").select("announcement_id, user_id, seen_at").in("announcement_id", announcementIds),
  ]);
  if (emailsRes.error) throw emailsRes.error;
  if (viewsRes.error) throw viewsRes.error;
  const emailById = new Map((emailsRes.data ?? []).map((r: { announcement_id: string; email: string }) => [r.announcement_id, r.email]));
  const seenById = new Map(
    (viewsRes.data ?? []).map((r: { announcement_id: string; seen_at: string }) => [r.announcement_id, r.seen_at]),
  );

  // Senders by id, recipients by address.
  const senderIds = [...new Set(announcements.map((a) => a.created_by).filter((id): id is string => !!id))];
  const addresses = [...new Set([...emailById.values()])];
  const [sendersRes, recipientsRes] = await Promise.all([
    senderIds.length
      ? supabase.from("profiles").select("id, email, display_name").in("id", senderIds)
      : Promise.resolve({ data: [], error: null }),
    addresses.length
      ? supabase.from("profiles").select("id, email, display_name").in("email", addresses)
      : Promise.resolve({ data: [], error: null }),
  ]);
  type Person = { id: string; email: string | null; display_name: string | null };
  const senders = new Map(((sendersRes.data ?? []) as Person[]).map((p) => [p.id, p]));
  const recipients = new Map(((recipientsRes.data ?? []) as Person[]).map((p) => [p.email?.toLowerCase() ?? "", p]));

  return announcements.map((a) => {
    const to = emailById.get(a.id) ?? null;
    return {
      announcement: a,
      email: to,
      seenAt: seenById.get(a.id) ?? null,
      sender: a.created_by ? (senders.get(a.created_by) ?? null) : null,
      recipient: to ? (recipients.get(to) ?? null) : null,
    };
  });
}

/** Creates the pop-up for `email` and returns its id. */
export async function sendPersonalMessage(input: PersonalMessageInput, email: string, adminId: string): Promise<string> {
  const id = await createAnnouncement({ ...fullInput(input), personal: true }, adminId);
  await setAnnouncementEmails(id, [email]);
  return id;
}

export async function updatePersonalMessage(id: string, input: PersonalMessageInput): Promise<void> {
  await updateAnnouncement(id, input);
}
