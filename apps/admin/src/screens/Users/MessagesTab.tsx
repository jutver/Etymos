// Messages tab of a user's page: write a pop-up for this one account, and
// see the ones already sent (and whether they were seen). Stored as personal
// announcements; see lib/personalMessagesQueries.ts.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ImageSquare, PaperPlaneTilt, X } from "@phosphor-icons/react";
import {
  announcementImageUrl,
  announcementText,
  cn,
  isAnnouncementLinkValid,
  type AnnouncementLanguage,
} from "@etymos/shared";
import { ListItemsSkeleton } from "../../components/Skeleton";
import {
  ANNOUNCEMENT_IMAGE_MAX_BYTES,
  ANNOUNCEMENT_IMAGE_TYPES,
  removeAnnouncementImage,
  uploadAnnouncementImage,
} from "../../lib/configQueries";
import {
  listPersonalMessages,
  sendPersonalMessage,
  updatePersonalMessage,
  type PersonalMessage,
  type PersonalMessageInput,
} from "../../lib/personalMessagesQueries";
import { friendlyError } from "../../lib/errors";
import { useAdminAuth } from "../../lib/auth";
import { getLanguage, t } from "../../lib/i18n";
import { AnnouncementPreview } from "../Announcements/Preview";
import { PersonalMessageList } from "../Announcements/PersonalMessageList";
import { fromLocalInput, toLocalInput } from "../Announcements/shared";
import { useUserDetail } from "./userDetailContext";

const inputClass =
  "w-full rounded-control border border-border bg-surface-muted px-3 py-2 text-body text-fg outline-none focus-visible:border-accent";

const LANGUAGES: { lang: AnnouncementLanguage; label: string }[] = [
  { lang: "vi", label: "Tiếng Việt" },
  { lang: "en", label: "English" },
];

const DEFAULT_BUTTON_LABEL: Record<AnnouncementLanguage, string> = { en: "Got it", vi: "Đã hiểu" };

interface Draft {
  title: Record<AnnouncementLanguage, string>;
  message: Record<AnnouncementLanguage, string>;
  button: Record<AnnouncementLanguage, string>;
  buttonUrl: string;
  imagePath: string | null;
  startMode: "now" | "at";
  startsAt: string;
  endOn: boolean;
  endsAt: string;
}

function emptyDraft(): Draft {
  return {
    title: { en: "", vi: "" },
    message: { en: "", vi: "" },
    button: { en: "", vi: "" },
    buttonUrl: "",
    imagePath: null,
    startMode: "now",
    startsAt: "",
    endOn: false,
    endsAt: "",
  };
}

function draftFrom(m: PersonalMessage): Draft {
  const a = m.announcement;
  return {
    title: { en: a.title ?? "", vi: a.title_vi ?? "" },
    message: { en: a.message, vi: a.message_vi },
    button: { en: a.button_label ?? "", vi: a.button_label_vi ?? "" },
    buttonUrl: a.button_url ?? "",
    imagePath: a.image_path,
    startMode: a.starts_at ? "at" : "now",
    startsAt: toLocalInput(a.starts_at),
    endOn: Boolean(a.ends_at),
    endsAt: toLocalInput(a.ends_at),
  };
}

function toInput(d: Draft, imagePath: string | null): PersonalMessageInput {
  const blank = (s: string) => s.trim() || null;
  return {
    title: blank(d.title.en),
    title_vi: blank(d.title.vi),
    message: d.message.en.trim(),
    message_vi: d.message.vi.trim(),
    button_label: blank(d.button.en),
    button_label_vi: blank(d.button.vi),
    button_url: blank(d.buttonUrl),
    image_path: imagePath,
    starts_at: d.startMode === "at" ? fromLocalInput(d.startsAt) : null,
    ends_at: d.endOn ? fromLocalInput(d.endsAt) : null,
  };
}

/** What stops the message from being sent, if anything. */
function problem(d: Draft, hasImage: boolean): string | null {
  const hasText = [d.title.en, d.title.vi, d.message.en, d.message.vi].some((s) => s.trim());
  if (!hasText && !hasImage) return t("Write a title or message, or add an image.");
  if (d.buttonUrl.trim() && !isAnnouncementLinkValid(d.buttonUrl.trim()))
    return t("The button link must be a site path like /pricing or an http(s) address.");
  if (d.startMode === "at" && !fromLocalInput(d.startsAt)) return t("Pick when it starts showing.");
  if (d.endOn && !fromLocalInput(d.endsAt)) return t("Pick when it stops showing.");
  const start = d.startMode === "at" ? fromLocalInput(d.startsAt) : new Date().toISOString();
  const end = d.endOn ? fromLocalInput(d.endsAt) : null;
  if (start && end && Date.parse(end) <= Date.parse(start)) return t("It has to stop after it starts.");
  return null;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-caption font-medium text-fg-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-caption text-fg-subtle">{hint}</span>}
    </label>
  );
}

function Choice<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex flex-wrap self-start rounded-control border border-border bg-surface-muted p-0.5">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={cn(
            "rounded-[calc(var(--radius-control)-2px)] px-3 py-1.5 text-caption font-medium transition-colors",
            value === v ? "bg-surface text-fg shadow-card" : "text-fg-muted hover:text-fg",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export default function MessagesTab() {
  const { profile } = useUserDetail();
  const { user } = useAdminAuth();
  const [messages, setMessages] = useState<PersonalMessage[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [editing, setEditing] = useState<PersonalMessage | null>(null);
  const [d, setD] = useState<Draft>(emptyDraft);
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentNote, setSentNote] = useState(false);
  const [previewLang, setPreviewLang] = useState<AnnouncementLanguage>(getLanguage);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    if (!profile.email) {
      setMessages([]);
      return;
    }
    listPersonalMessages(profile.email)
      .then(setMessages)
      .catch((err: unknown) => setListError(friendlyError(err)));
  }, [profile.email]);

  useEffect(() => refresh(), [refresh]);

  const fileUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => void (fileUrl && URL.revokeObjectURL(fileUrl)), [fileUrl]);
  const imageUrl = fileUrl ?? announcementImageUrl(d.imagePath);

  const issue = problem(d, Boolean(imageUrl));
  const preview = announcementText(
    { title: d.title.en, message: d.message.en, title_vi: d.title.vi, message_vi: d.message.vi },
    previewLang,
  );
  const other: AnnouncementLanguage = previewLang === "vi" ? "en" : "vi";
  const previewButton = d.button[previewLang].trim() || d.button[other].trim() || DEFAULT_BUTTON_LABEL[previewLang];

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setD((prev) => ({ ...prev, [key]: value }));
    setSentNote(false);
  }

  function setText(field: "title" | "message" | "button", lang: AnnouncementLanguage, value: string) {
    setD((prev) => ({ ...prev, [field]: { ...prev[field], [lang]: value } }));
    setSentNote(false);
  }

  function pickFile(list: FileList | null) {
    const f = list?.[0];
    if (!f) return;
    if (!ANNOUNCEMENT_IMAGE_TYPES.includes(f.type)) return setError(t("Use a PNG, JPG, WebP or GIF image."));
    if (f.size > ANNOUNCEMENT_IMAGE_MAX_BYTES) return setError(t("Images can be up to 5 MB."));
    setError(null);
    setFile(f);
  }

  function reset() {
    setEditing(null);
    setD(emptyDraft());
    setFile(null);
    setError(null);
  }

  function edit(m: PersonalMessage) {
    setEditing(m);
    setD(draftFrom(m));
    setFile(null);
    setError(null);
    setSentNote(false);
    document.getElementById("message-composer")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function submit() {
    if (!user || !profile.email || issue || saving) return;
    setSaving(true);
    setError(null);
    let uploaded: string | null = null;
    try {
      if (file) uploaded = await uploadAnnouncementImage(file);
      const imagePath = uploaded ?? d.imagePath;
      const input = toInput(d, imagePath);
      if (editing) {
        await updatePersonalMessage(editing.announcement.id, input);
        const old = editing.announcement.image_path;
        if (old && old !== imagePath) await removeAnnouncementImage(old);
      } else {
        await sendPersonalMessage(input, profile.email, user.id);
        setSentNote(true);
      }
      reset();
      refresh();
    } catch (err) {
      if (uploaded) await removeAnnouncementImage(uploaded);
      setError(friendlyError(err));
    } finally {
      setSaving(false);
    }
  }

  if (!profile.email) {
    return (
      <div className="rounded-card border border-border bg-surface p-6 text-body text-fg-muted shadow-card">
        {t("This account has no email address, so it can't be sent a message.")}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div id="message-composer" className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="rounded-card border border-border bg-surface p-5 shadow-card sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-h2 font-semibold text-fg">{editing ? t("Edit message") : t("New message")}</h2>
              <p className="mt-1 text-caption text-fg-muted">
                {t("Opens as a pop-up for {{email}} on their home page, once. Only they see it.", { email: profile.email })}
              </p>
            </div>
            {editing && (
              <button
                type="button"
                onClick={reset}
                className="inline-flex items-center gap-1 rounded-control border border-border px-3 py-1.5 text-caption font-medium text-fg-muted transition hover:bg-surface-raised"
              >
                <X size={12} weight="bold" />
                {t("Cancel editing")}
              </button>
            )}
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            {LANGUAGES.map(({ lang, label }) => (
              <fieldset key={lang} className="space-y-3 rounded-control border border-border p-3.5" onFocus={() => setPreviewLang(lang)}>
                <legend className="px-1 text-caption font-semibold text-fg">{label}</legend>
                <Field label={t("Title")}>
                  <input lang={lang} value={d.title[lang]} maxLength={120} onChange={(e) => setText("title", lang, e.target.value)} className={inputClass} />
                </Field>
                <Field label={t("Message")}>
                  <textarea
                    lang={lang}
                    rows={4}
                    value={d.message[lang]}
                    maxLength={2000}
                    onChange={(e) => setText("message", lang, e.target.value)}
                    className={cn(inputClass, "resize-y")}
                  />
                </Field>
                <Field label={t("Button text")}>
                  <input
                    lang={lang}
                    value={d.button[lang]}
                    maxLength={40}
                    placeholder={DEFAULT_BUTTON_LABEL[lang]}
                    onChange={(e) => setText("button", lang, e.target.value)}
                    className={inputClass}
                  />
                </Field>
              </fieldset>
            ))}
          </div>
          <p className="mt-2 text-caption text-fg-subtle">
            {t("Fill in one language or both. A blank one shows the other language's text.")}
          </p>

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <Field label={t("Button link (optional)")} hint={t("A site path like /pricing, or an http(s) address. Blank = the button just closes it.")}>
              <input value={d.buttonUrl} onChange={(e) => set("buttonUrl", e.target.value)} placeholder="/pricing" className={inputClass} />
            </Field>

            <div>
              <p className="mb-1.5 text-caption font-medium text-fg-muted">{t("Image (optional)")}</p>
              <input
                ref={fileInput}
                type="file"
                accept={ANNOUNCEMENT_IMAGE_TYPES.join(",")}
                className="hidden"
                onChange={(e) => {
                  pickFile(e.target.files);
                  e.target.value = "";
                }}
              />
              {imageUrl ? (
                <div className="flex items-center gap-3">
                  <img src={imageUrl} alt="" className="h-14 w-24 rounded-control border border-border object-cover" />
                  <button
                    type="button"
                    onClick={() => fileInput.current?.click()}
                    className="rounded-control border border-border px-3 py-1.5 text-caption font-medium text-fg-muted transition hover:bg-surface-raised"
                  >
                    {t("Replace")}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setFile(null);
                      set("imagePath", null);
                    }}
                    className="rounded-control px-3 py-1.5 text-caption font-medium text-fg-muted transition hover:bg-destructive-bg hover:text-destructive"
                  >
                    {t("Remove")}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => fileInput.current?.click()}
                  className="inline-flex items-center gap-1.5 rounded-control border border-dashed border-border px-3 py-2 text-caption font-medium text-fg-muted transition hover:border-accent hover:text-accent"
                >
                  <ImageSquare size={16} />
                  {t("Add an image")}
                </button>
              )}
            </div>

            <div className="space-y-2">
              <p className="text-caption font-medium text-fg-muted">{t("Show from")}</p>
              <Choice
                value={d.startMode}
                options={[
                  ["now", t("Right away")],
                  ["at", t("At a set time")],
                ]}
                onChange={(v) => set("startMode", v)}
              />
              {d.startMode === "at" && (
                <input type="datetime-local" value={d.startsAt} onChange={(e) => set("startsAt", e.target.value)} className={inputClass} />
              )}
            </div>

            <div className="space-y-2">
              <p className="text-caption font-medium text-fg-muted">{t("Hide after")}</p>
              <Choice
                value={d.endOn ? "at" : "never"}
                options={[
                  ["never", t("Until seen")],
                  ["at", t("At a set time")],
                ]}
                onChange={(v) => set("endOn", v === "at")}
              />
              {d.endOn && (
                <input type="datetime-local" value={d.endsAt} onChange={(e) => set("endsAt", e.target.value)} className={inputClass} />
              )}
            </div>
          </div>

          {(error || issue) && <p className={cn("mt-4 text-caption", error ? "text-destructive" : "text-fg-subtle")}>{error ?? issue}</p>}
          {sentNote && <p className="mt-4 text-caption font-medium text-success">{t("Sent. It opens the next time they visit their home page.")}</p>}

          <button
            type="button"
            onClick={submit}
            disabled={Boolean(issue) || saving}
            className="mt-5 inline-flex cursor-pointer items-center gap-2 rounded-control bg-accent px-4 py-2 text-body font-semibold text-bg transition hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
          >
            <PaperPlaneTilt size={16} weight="bold" />
            {saving ? t("Saving…") : editing ? t("Save changes") : d.startMode === "at" ? t("Schedule message") : t("Send message")}
          </button>
        </div>

        <div className="space-y-2 xl:sticky xl:top-6">
          <div className="flex items-center justify-between">
            <p className="text-caption font-medium text-fg-muted">{t("Preview")}</p>
            <Choice
              value={previewLang}
              options={[
                ["vi", "VI"],
                ["en", "EN"],
              ]}
              onChange={setPreviewLang}
            />
          </div>
          <AnnouncementPreview
            kind="popup"
            lang={previewLang}
            title={preview.title}
            message={preview.message}
            severity="info"
            icon={null}
            countdownTo={null}
            imageUrl={imageUrl}
            buttonLabel={previewButton}
          />
        </div>
      </div>

      <div>
        <h2 className="mb-3 text-h2 font-semibold text-fg">{t("Sent messages")}</h2>
        {listError && <p className="mb-3 text-caption text-destructive">{listError}</p>}
        {!messages ? (
          <div className="rounded-card border border-border bg-surface p-4 shadow-card">
            <ListItemsSkeleton count={3} />
          </div>
        ) : messages.length === 0 ? (
          <div className="rounded-card border border-border bg-surface p-6 text-body text-fg-subtle shadow-card">
            {t("No messages sent to this user yet.")}
          </div>
        ) : (
          <PersonalMessageList messages={messages} editingId={editing?.announcement.id ?? null} onEdit={edit} onChanged={refresh} />
        )}
      </div>
    </div>
  );
}
