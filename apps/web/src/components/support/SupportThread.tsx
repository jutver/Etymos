import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { EnvelopeSimple, FilePdf, Image as ImageIcon, WarningCircle } from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import { Button } from "../ui/Button";
import { LogoMark } from "../layout/Logo";
import { AttachmentPicker } from "./AttachmentPicker";
import { CATEGORY_LABELS, STATUS_CLASSES, STATUS_LABELS, formatBytes, supportErrorText } from "./labels";
import type { SupportConversation, SupportMessage } from "../../lib/api";
import { currentLocale, t } from "../../lib/i18n";

function when(iso: string) {
  return new Date(iso).toLocaleString(currentLocale(), { dateStyle: "medium", timeStyle: "short" });
}

export function StatusChip({ status }: { status: SupportConversation["status"] }) {
  return (
    <span className={cn("whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-bold", STATUS_CLASSES[status])}>
      {t(STATUS_LABELS[status])}
    </span>
  );
}

function MessageBubble({ message }: { message: SupportMessage }) {
  const fromSupport = message.from === "support";
  return (
    <li className={cn("flex flex-col gap-1.5", fromSupport ? "items-start" : "items-end")}>
      <div className="flex items-center gap-2 text-xs text-ink-500">
        {fromSupport && <LogoMark size={20} />}
        <span className="font-semibold text-ink-700">{fromSupport ? t("Etymos Support") : t("You")}</span>
        <span>{when(message.created_at)}</span>
        {message.channel === "email" && (
          <span className="inline-flex items-center gap-1" title={t("Sent by email")}>
            <EnvelopeSimple size={12} />
          </span>
        )}
      </div>
      <div
        className={cn(
          "max-w-[min(36rem,100%)] whitespace-pre-wrap break-words rounded-2xl px-4 py-3 text-sm leading-relaxed",
          fromSupport ? "rounded-tl-md border border-line bg-white text-ink-900" : "rounded-tr-md bg-brand-100/70 text-ink-900",
        )}
      >
        {message.body}
      </div>
      {message.attachments.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {message.attachments.map((a) => (
            <li key={a.id}>
              <a
                href={a.url ?? undefined}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-full border border-line bg-white px-2.5 py-1 text-xs text-ink-700 hover:border-brand-300"
              >
                {a.content_type === "application/pdf" ? <FilePdf size={14} /> : <ImageIcon size={14} />}
                <span className="max-w-[12rem] truncate">{a.filename}</span>
                <span className="text-ink-400">{formatBytes(a.size_bytes)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** One support request: header, the messages, and a reply box (or, once
 * closed, a pointer to open a new request). */
export function SupportThread({
  conversation,
  onReply,
}: {
  conversation: SupportConversation;
  onReply: (body: string, files: File[]) => Promise<void>;
}) {
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const closed = conversation.status === "closed";

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (sending || !body.trim()) return;
    setSending(true);
    setError(null);
    try {
      await onReply(body.trim(), files);
      setBody("");
      setFiles([]);
    } catch (err) {
      setError(supportErrorText(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">
            {t("Request #{{number}}", { number: conversation.number })} · {t(CATEGORY_LABELS[conversation.category])}
          </p>
          <h1 className="mt-1 break-words text-h2 font-bold tracking-tight text-navy-900">{conversation.subject}</h1>
        </div>
        <StatusChip status={conversation.status} />
      </div>

      <ol className="mt-8 flex flex-col gap-6">
        {conversation.messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
      </ol>

      {closed ? (
        <div className="mt-8 rounded-[var(--radius-card)] border border-line bg-surface-tint px-5 py-4 text-sm text-ink-600">
          {t("This request is closed.")}{" "}
          <Link to="/contact" className="font-semibold text-brand-600 underline underline-offset-2">
            {t("Open a new request")}
          </Link>{" "}
          {t("if you still need help.")}
        </div>
      ) : (
        <form onSubmit={submit} className="studio-card mt-8 rounded-[var(--radius-card-lg)] border border-line bg-white p-4 sm:p-5">
          <label className="sr-only" htmlFor="support-reply">
            {t("Your reply")}
          </label>
          <textarea
            id="support-reply"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
            maxLength={10000}
            placeholder={t("Write a reply…")}
            className="w-full resize-y rounded-[var(--radius-control)] border border-line bg-white px-3.5 py-2.5 text-sm placeholder:text-ink-300 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-200"
          />
          {error && (
            <p className="mt-2 flex items-start gap-1.5 text-sm text-severity-high">
              <WarningCircle size={16} weight="fill" className="mt-0.5 shrink-0" />
              {error}
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <AttachmentPicker files={files} onChange={setFiles} onError={setError} />
            <Button type="submit" size="sm" loading={sending} disabled={!body.trim()}>
              {t("Send reply")}
            </Button>
          </div>
          <p className="mt-3 text-xs text-ink-400">{t("You can also reply to any of our emails about this request.")}</p>
        </form>
      )}
    </div>
  );
}
