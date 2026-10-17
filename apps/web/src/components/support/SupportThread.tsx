import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { EnvelopeSimple, WarningCircle } from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import { Button } from "../ui/Button";
import { LogoMark } from "../layout/Logo";
import { Skeleton, SkeletonText } from "../ui/Skeleton";
import { AttachmentPicker } from "./AttachmentPicker";
import { Attachments } from "./Attachments";
import { CATEGORY_LABELS, STATUS_CLASSES, STATUS_LABELS, supportErrorText } from "./labels";
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
      {message.attachments.length > 0 && <Attachments attachments={message.attachments} alignEnd={!fromSupport} />}
    </li>
  );
}

/** One support request: header, the messages, and a reply box (or, once
 * closed, a pointer to open a new request). */
export function SupportThread({
  conversation,
  onReply,
  newRequestPath = "/contact",
}: {
  conversation: SupportConversation;
  onReply: (body: string, files: File[]) => Promise<void>;
  /** Where "Open a new request" goes once the request is closed. */
  newRequestPath?: string;
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
          <Link to={newRequestPath} className="font-semibold text-brand-600 underline underline-offset-2">
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

/** Skeleton bubbles: the request, a reply from support, a follow-up. */
const SKELETON_BUBBLES: { fromSupport: boolean; lines: number; width: string }[] = [
  { fromSupport: false, lines: 3, width: "w-[min(30rem,85%)]" },
  { fromSupport: true, lines: 4, width: "w-[min(34rem,90%)]" },
  { fromSupport: false, lines: 2, width: "w-[min(22rem,70%)]" },
];

/** Placeholder in the shape of SupportThread while the conversation loads,
 * so the page doesn't sit empty and the layout doesn't jump when it lands. */
export function SupportThreadSkeleton() {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">{t("Loading…")}</span>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="mt-2.5 h-7 w-[min(24rem,80%)]" rounded="md" />
        </div>
        <Skeleton className="h-6 w-20" rounded="full" />
      </div>

      <ol className="mt-8 flex flex-col gap-6" aria-hidden="true">
        {SKELETON_BUBBLES.map((b, i) => (
          <li key={i} className={cn("flex flex-col gap-1.5", b.fromSupport ? "items-start" : "items-end")}>
            <div className="flex items-center gap-2">
              {b.fromSupport && <Skeleton className="h-5 w-5" rounded="full" />}
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-3 w-28" />
            </div>
            <div
              className={cn(
                "rounded-2xl px-4 py-3.5",
                b.width,
                b.fromSupport ? "rounded-tl-md border border-line bg-white" : "rounded-tr-md bg-brand-100/50",
              )}
            >
              <SkeletonText lines={b.lines} />
            </div>
          </li>
        ))}
      </ol>

      <div className="studio-card mt-8 rounded-[var(--radius-card-lg)] border border-line bg-white p-4 sm:p-5" aria-hidden="true">
        <Skeleton className="h-[6.5rem] w-full" variant="flat" rounded="md" />
        <div className="mt-3 flex items-center justify-between gap-3">
          <Skeleton className="h-8 w-32" rounded="full" />
          <Skeleton className="h-8 w-24" rounded="md" />
        </div>
      </div>
    </div>
  );
}
