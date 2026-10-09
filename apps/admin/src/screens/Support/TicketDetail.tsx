import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  CircleNotch,
  EnvelopeSimple,
  FilePdf,
  Image as ImageIcon,
  Paperclip,
  ShieldCheck,
  ShieldWarning,
  Warning,
  X,
} from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import { StatusBadge } from "../../components/StatusBadge";
import {
  getSupportTicket,
  listSupportAgents,
  postSupportMessage,
  updateSupportTicket,
  type SupportAdminMessage,
  type SupportCategory,
  type SupportPerson,
  type SupportStatus,
  type SupportTicketDetail,
} from "../../lib/supportApi";
import { ApiError } from "../../lib/api";
import { friendlyError } from "../../lib/errors";
import { currentLocale, t, tr } from "../../lib/i18n";
import { CATEGORY_LABELS, STATUS_LABELS, statusTone } from "./labels";

const FILE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp,application/pdf";
const MAX_FILES = 5;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

const AFTER_REPLY: { key: SupportStatus; label: string }[] = [
  { key: "pending", label: tr("Send, wait on user") },
  { key: "resolved", label: tr("Send and resolve") },
  { key: "open", label: tr("Send, keep open") },
];

function when(iso: string | null) {
  return iso ? new Date(iso).toLocaleString(currentLocale(), { dateStyle: "medium", timeStyle: "short" }) : "—";
}

function size(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function replyError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.message === "send_failed") return t("The email couldn't be sent, so the reply wasn't saved. Try again in a moment.");
    if (err.message === "file_type") return t("Only images (PNG, JPG, GIF, WebP) and PDFs can be attached.");
    if (err.message === "file_too_large") return t("Each file must be 5 MB or smaller.");
    if (err.message === "too_many_files") return t("Attach up to 5 files.");
  }
  return friendlyError(err);
}

export default function SupportTicketDetailPage() {
  const number = Number(useParams().number);
  const navigate = useNavigate();
  const [ticket, setTicket] = useState<SupportTicketDetail | null>(null);
  const [agents, setAgents] = useState<SupportPerson[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setTicket(null);
    setError(null);
    getSupportTicket(number)
      .then((d) => !cancelled && setTicket(d))
      .catch((err: unknown) => !cancelled && setError(friendlyError(err)));
    listSupportAgents()
      .then((r) => !cancelled && setAgents(r.items))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [number]);

  async function update(patch: Parameters<typeof updateSupportTicket>[1]) {
    setUpdating(true);
    setError(null);
    try {
      setTicket(await updateSupportTicket(number, patch));
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setUpdating(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => navigate("/support")}
        className="inline-flex cursor-pointer items-center gap-1.5 text-caption font-medium text-fg-muted hover:text-fg"
      >
        <ArrowLeft size={14} weight="bold" />
        {t("Support")}
      </button>

      {error && <p className="mt-4 text-caption text-destructive">{error}</p>}
      {!ticket && !error && (
        <div className="mt-16 flex justify-center text-fg-muted">
          <CircleNotch size={22} className="animate-spin" />
        </div>
      )}

      {ticket && (
        <div className="mt-3 grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-caption text-fg-muted">
                  #{ticket.number} · {t(CATEGORY_LABELS[ticket.category])} ·{" "}
                  {ticket.source === "email" ? t("by email") : t("contact form")} · {when(ticket.created_at)}
                </p>
                <h1 className="mt-1 break-words text-h1 font-semibold text-fg">{ticket.subject}</h1>
              </div>
              <StatusBadge label={STATUS_LABELS[ticket.status]} tone={statusTone(ticket.status)} capitalize={false} />
            </div>

            {!ticket.identity_verified && (
              <div className="mt-4 flex items-start gap-2.5 rounded-card border border-warning/40 bg-warning-bg px-4 py-3 text-caption text-warning">
                <ShieldWarning size={18} weight="fill" className="mt-0.5 shrink-0" />
                <p>
                  <span className="font-semibold">{t("Identity not verified.")}</span>{" "}
                  {t("This request came from a guest form or an email, which anyone can send in someone else's name. Don't change an account (email, password, plan, refunds) on the strength of it; ask the person to sign in and write from their account, or to use account recovery.")}
                </p>
              </div>
            )}

            <ol className="mt-6 flex flex-col gap-4">
              {ticket.messages.map((m) => (
                <MessageItem key={m.id} message={m} requester={ticket.requester_email} />
              ))}
            </ol>

            <Composer ticket={ticket} onPosted={setTicket} />
          </div>

          <aside className="flex flex-col gap-4">
            <Panel title={t("Ticket")}>
              <Field label={t("Status")}>
                <select
                  value={ticket.status}
                  disabled={updating}
                  onChange={(e) => update({ status: e.target.value as SupportStatus })}
                  className={selectClass}
                >
                  {(Object.keys(STATUS_LABELS) as SupportStatus[]).map((s) => (
                    <option key={s} value={s}>
                      {t(STATUS_LABELS[s])}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t("Assignee")}>
                <select
                  value={ticket.assignee?.id ?? ""}
                  disabled={updating}
                  onChange={(e) => update({ assigned_to: e.target.value })}
                  className={selectClass}
                >
                  <option value="">{t("Unassigned")}</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name || a.email}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t("Topic")}>
                <select
                  value={ticket.category}
                  disabled={updating}
                  onChange={(e) => update({ category: e.target.value as SupportCategory })}
                  className={selectClass}
                >
                  {(Object.keys(CATEGORY_LABELS) as SupportCategory[]).map((c) => (
                    <option key={c} value={c}>
                      {t(CATEGORY_LABELS[c])}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t("Priority")}>
                <select
                  value={ticket.priority}
                  disabled={updating}
                  onChange={(e) => update({ priority: e.target.value as "normal" | "high" })}
                  className={selectClass}
                >
                  <option value="normal">{t("Normal")}</option>
                  <option value="high">{t("High")}</option>
                </select>
              </Field>
              {ticket.previous_ticket_number && (
                <p className="text-caption text-fg-muted">
                  {t("Follows closed request")}{" "}
                  <Link to={`/support/${ticket.previous_ticket_number}`} className="font-medium text-accent hover:underline">
                    #{ticket.previous_ticket_number}
                  </Link>
                </p>
              )}
            </Panel>

            <Panel title={t("Requester")}>
              <p className="break-all text-body font-medium text-fg">{ticket.requester_email}</p>
              {ticket.requester_name && <p className="text-caption text-fg-muted">{ticket.requester_name}</p>}
              <p
                className={cn(
                  "mt-2 inline-flex items-center gap-1.5 text-caption font-medium",
                  ticket.identity_verified ? "text-success" : "text-warning",
                )}
              >
                {ticket.identity_verified ? <ShieldCheck size={14} weight="fill" /> : <ShieldWarning size={14} weight="fill" />}
                {ticket.identity_verified ? t("Signed in when they wrote") : t("Not verified")}
              </p>
            </Panel>

            <Panel title={ticket.user_id ? t("Account") : t("Account with this email")}>
              {ticket.account ? (
                <div className="flex flex-col gap-2 text-caption">
                  <Link to={`/users/${ticket.account.id}`} className="break-all text-body font-medium text-accent hover:underline">
                    {ticket.account.display_name || ticket.account.email}
                  </Link>
                  <Row label={t("Plan")}>
                    <span className="capitalize">{ticket.account.plan_tier}</span>
                    {ticket.account.billing_cycle && ticket.account.plan_tier !== "free" && ` · ${ticket.account.billing_cycle}`}
                  </Row>
                  {ticket.account.plan_expires_at && <Row label={t("Plan ends")}>{when(ticket.account.plan_expires_at)}</Row>}
                  <Row label={t("Credits")}>
                    {t("{{standard}} standard · {{premium}} premium", {
                      standard: ticket.account.standard_credits ?? 0,
                      premium: ticket.account.premium_credits ?? 0,
                    })}
                  </Row>
                  <Row label={t("Joined")}>{when(ticket.account.created_at)}</Row>
                  {(ticket.account.banned_permanent || ticket.account.banned_until) && (
                    <p className="font-medium text-destructive">
                      {ticket.account.banned_permanent
                        ? t("Banned permanently")
                        : t("Banned until {{date}}", { date: when(ticket.account.banned_until) })}
                    </p>
                  )}
                  {ticket.account.deletion_requested_at && <p className="font-medium text-destructive">{t("Deletion requested")}</p>}
                  {!ticket.user_id && (
                    <p className="text-fg-subtle">{t("Matched by email address only; it may not be the same person.")}</p>
                  )}
                </div>
              ) : (
                <p className="text-caption text-fg-muted">{t("No account uses this email address.")}</p>
              )}
            </Panel>
          </aside>
        </div>
      )}
    </div>
  );
}

const selectClass =
  "w-full rounded-control border border-border bg-surface-muted px-2.5 py-1.5 text-body text-fg outline-none focus-visible:border-accent disabled:opacity-60";

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-card border border-border bg-surface p-4 shadow-card">
      <h2 className="mb-3 text-micro font-semibold uppercase tracking-wider text-fg-subtle">{title}</h2>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-caption font-medium text-fg-muted">{label}</span>
      {children}
    </label>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-fg-muted">{label}</span>
      <span className="text-right text-fg">{children}</span>
    </div>
  );
}

function MessageItem({ message: m, requester }: { message: SupportAdminMessage; requester: string }) {
  if (m.author_type === "system") {
    return (
      <li className="text-center text-caption text-fg-subtle">
        {m.body} · {when(m.created_at)}
      </li>
    );
  }
  const fromAgent = m.author_type === "agent";
  const who = fromAgent ? m.author?.name || m.author?.email || t("Support") : m.sender_email || requester;
  return (
    <li
      className={cn(
        "rounded-card border p-4",
        m.internal
          ? "border-warning/40 bg-warning-bg/60"
          : fromAgent
            ? "border-accent/30 bg-accent-bg/40"
            : "border-border bg-surface",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption">
        <span className="font-semibold text-fg">{who}</span>
        {m.internal && <StatusBadge label={tr("Internal note")} tone="warning" capitalize={false} />}
        {fromAgent && !m.internal && <span className="text-fg-subtle">{t("replied by email")}</span>}
        {m.channel === "email" && !fromAgent && (
          <span className="inline-flex items-center gap-1 text-fg-subtle">
            <EnvelopeSimple size={12} /> {t("email")}
          </span>
        )}
        <span className="text-fg-subtle">{when(m.created_at)}</span>
        {m.raw_email_url && (
          <a href={m.raw_email_url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
            {t("Original email")}
          </a>
        )}
      </div>
      {(m.sender_mismatch || m.sender_auth === "fail") && (
        <p className="mt-2 flex items-start gap-1.5 text-caption font-medium text-destructive">
          <Warning size={14} weight="fill" className="mt-0.5 shrink-0" />
          {m.sender_mismatch
            ? t("Sent from {{email}}, which isn't the requester's address. It didn't change the ticket's status.", { email: m.sender_email ?? "?" })
            : t("The sender's mail server failed authentication (SPF/DKIM); the From address may be forged.")}
        </p>
      )}
      <p className="mt-2 whitespace-pre-wrap break-words text-body text-fg">{m.body}</p>
      {m.attachments.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2">
          {m.attachments.map((a) => (
            <li key={a.id}>
              <a
                href={a.url ?? undefined}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-caption text-fg-muted hover:text-fg"
              >
                {a.content_type === "application/pdf" ? <FilePdf size={13} /> : <ImageIcon size={13} />}
                <span className="max-w-[14rem] truncate">{a.filename}</span>
                <span className="text-fg-subtle">{size(a.size_bytes)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function Composer({ ticket, onPosted }: { ticket: SupportTicketDetail; onPosted: (detail: SupportTicketDetail) => void }) {
  const [mode, setMode] = useState<"reply" | "note">("reply");
  const [body, setBody] = useState("");
  const [after, setAfter] = useState<SupportStatus>("pending");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const internal = mode === "note";

  function addFiles(list: FileList | null) {
    if (!list) return;
    const next = [...files];
    for (const f of Array.from(list)) {
      if (!FILE_ACCEPT.split(",").includes(f.type)) {
        setError(t("Only images (PNG, JPG, GIF, WebP) and PDFs can be attached."));
      } else if (f.size > MAX_FILE_BYTES) {
        setError(t("Each file must be 5 MB or smaller."));
      } else if (next.length < MAX_FILES) {
        next.push(f);
      }
    }
    setFiles(next);
    if (input.current) input.current.value = "";
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!body.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      onPosted(
        await postSupportMessage(ticket.number, {
          body: body.trim(),
          internal,
          setStatus: internal ? undefined : after,
          files,
        }),
      );
      setBody("");
      setFiles([]);
    } catch (err) {
      setError(replyError(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className={cn(
        "mt-6 rounded-card border p-4 shadow-card",
        internal ? "border-warning/40 bg-warning-bg/40" : "border-border bg-surface",
      )}
    >
      <div className="mb-3 flex gap-1.5">
        {(["reply", "note"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={cn(
              "rounded-control px-3 py-1.5 text-caption font-medium transition-colors",
              mode === m ? "bg-accent-bg text-accent" : "text-fg-muted hover:bg-surface-raised hover:text-fg",
            )}
          >
            {m === "reply" ? t("Reply to requester") : t("Internal note")}
          </button>
        ))}
      </div>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={6}
        maxLength={10000}
        placeholder={
          internal
            ? t("Only the team sees this.")
            : t("Emailed to {{email}} from the support address.", { email: ticket.requester_email })
        }
        className="w-full resize-y rounded-control border border-border bg-surface px-3 py-2 text-body text-fg outline-none focus-visible:border-accent"
      />
      {files.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-caption text-fg-muted">
              <span className="max-w-[12rem] truncate">{f.name}</span>
              <button
                type="button"
                aria-label={t("Remove")}
                onClick={() => setFiles(files.filter((_, j) => j !== i))}
                className="cursor-pointer text-fg-subtle hover:text-fg"
              >
                <X size={11} weight="bold" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-2 text-caption text-destructive">{error}</p>}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => input.current?.click()}
          disabled={files.length >= MAX_FILES}
          className="inline-flex cursor-pointer items-center gap-1.5 text-caption font-medium text-accent disabled:opacity-50"
        >
          <Paperclip size={14} /> {t("Attach")}
        </button>
        <input ref={input} type="file" multiple accept={FILE_ACCEPT} className="hidden" onChange={(e) => addFiles(e.target.files)} />
        <div className="flex items-center gap-2">
          {!internal && (
            <select
              value={after}
              onChange={(e) => setAfter(e.target.value as SupportStatus)}
              aria-label={t("Status after sending")}
              className="rounded-control border border-border bg-surface-muted px-2.5 py-2 text-body text-fg outline-none"
            >
              {AFTER_REPLY.map((o) => (
                <option key={o.key} value={o.key}>
                  {t(o.label)}
                </option>
              ))}
            </select>
          )}
          <button
            type="submit"
            disabled={!body.trim() || sending}
            className="inline-flex cursor-pointer items-center gap-2 rounded-control bg-accent px-4 py-2 text-body font-medium text-white transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {sending && <CircleNotch size={14} className="animate-spin" />}
            {internal ? t("Save note") : t("Send reply")}
          </button>
        </div>
      </div>
    </form>
  );
}
