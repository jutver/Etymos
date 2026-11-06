// Sent personal messages, as a list: used on a user's Messages tab and on
// Announcements > Personal messages (where it also names the recipient).
import { useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle, Image as ImageIcon, PencilSimple, Trash } from "@phosphor-icons/react";
import { announcementText, cn } from "@etymos/shared";
import { StatusBadge } from "../../components/StatusBadge";
import { Switch } from "../../components/Switch";
import { deleteAnnouncement, setAnnouncementActive } from "../../lib/configQueries";
import { MESSAGE_STATUS_LABELS, personalMessageStatus, type PersonalMessage } from "../../lib/personalMessagesQueries";
import { friendlyError } from "../../lib/errors";
import { currentLocale, getLanguage, t } from "../../lib/i18n";
import { useAdminAuth } from "../../lib/auth";
import { useNow } from "./shared";


const STATUS_TONES = {
  off: "neutral",
  scheduled: "info",
  showing: "accent",
  seen: "success",
  ended: "neutral",
} as const;

function when(iso: string) {
  return new Date(iso).toLocaleString(currentLocale(), { dateStyle: "medium", timeStyle: "short" });
}

function personName(p: { email: string | null; display_name: string | null } | null): string | null {
  return p ? p.display_name?.trim() || p.email : null;
}

export function PersonalMessageList({
  messages,
  showRecipient = false,
  editingId = null,
  onEdit,
  onChanged,
}: {
  messages: PersonalMessage[];
  showRecipient?: boolean;
  editingId?: string | null;
  onEdit?: (message: PersonalMessage) => void;
  /** After a switch or delete went through, so the parent reloads. */
  onChanged: () => void;
}) {
  const { user } = useAdminAuth();
  const now = useNow(30_000);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(id: string, action: () => Promise<void>) {
    setBusyId(id);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusyId(null);
      setConfirmDeleteId(null);
    }
  }

  return (
    <div>
      {error && <p className="mb-3 text-caption text-destructive">{error}</p>}
      <ul className="divide-y divide-border rounded-card border border-border bg-surface shadow-card">
        {messages.map((m) => {
          const a = m.announcement;
          const status = personalMessageStatus(m, now);
          const { title, message } = announcementText(a, getLanguage());
          const sender = a.created_by === user?.id ? t("you") : personName(m.sender) ?? t("an admin");
          const recipient = personName(m.recipient) ?? m.email;
          return (
            <li key={a.id} className={cn("flex flex-wrap items-center gap-4 px-5 py-4", editingId === a.id && "bg-accent-bg/40")}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge label={MESSAGE_STATUS_LABELS[status]} tone={STATUS_TONES[status]} capitalize={false} />
                  {a.image_path && <ImageIcon size={15} className="text-fg-subtle" aria-label={t("Has an image")} />}
                  {showRecipient && recipient && (
                    m.recipient ? (
                      <Link
                        to={`/users/${m.recipient.id}/messages`}
                        className="truncate text-caption font-medium text-accent hover:underline"
                      >
                        {t("To {{name}}", { name: recipient })}
                      </Link>
                    ) : (
                      <span className="truncate text-caption text-fg-muted">{t("To {{name}}", { name: recipient })}</span>
                    )
                  )}
                </div>
                <p className="mt-1.5 truncate text-body font-medium text-fg">{title || t("Image only")}</p>
                {title && message && <p className="truncate text-caption text-fg-muted">{message}</p>}
                <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-caption text-fg-subtle">
                  <span>{t("Sent {{time}} by {{name}}", { time: when(a.created_at), name: sender })}</span>
                  {m.seenAt && (
                    <span className="inline-flex items-center gap-1 text-success">
                      <CheckCircle size={13} weight="fill" />
                      {t("seen {{time}}", { time: when(m.seenAt) })}
                    </span>
                  )}
                  {!m.seenAt && a.starts_at && Date.parse(a.starts_at) > now && (
                    <span>· {t("shows from {{time}}", { time: when(a.starts_at) })}</span>
                  )}
                  {!m.seenAt && a.ends_at && <span>· {t("hides {{time}}", { time: when(a.ends_at) })}</span>}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {!m.seenAt && (
                  <Switch
                    checked={a.is_active}
                    disabled={busyId === a.id}
                    onChange={(v) => run(a.id, () => setAnnouncementActive(a.id, v))}
                  />
                )}
                {onEdit && !m.seenAt && (
                  <button
                    type="button"
                    title={t("Edit")}
                    aria-label={t("Edit")}
                    onClick={() => onEdit(m)}
                    className="flex size-8 items-center justify-center rounded-control text-fg-muted transition hover:bg-surface-raised hover:text-fg"
                  >
                    <PencilSimple size={15} weight="bold" />
                  </button>
                )}
                {confirmDeleteId === a.id ? (
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={busyId === a.id}
                      onClick={() => run(a.id, () => deleteAnnouncement(a))}
                      className="rounded-control bg-destructive px-2.5 py-1 text-caption font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
                    >
                      {busyId === a.id ? t("Deleting…") : t("Confirm")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(null)}
                      className="rounded-control px-2.5 py-1 text-caption font-medium text-fg-muted transition hover:bg-surface-raised"
                    >
                      {t("Cancel")}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    title={t("Delete message")}
                    aria-label={t("Delete message")}
                    onClick={() => setConfirmDeleteId(a.id)}
                    className="flex size-8 items-center justify-center rounded-control text-fg-muted transition hover:bg-destructive-bg hover:text-destructive"
                  >
                    <Trash size={15} weight="bold" />
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
