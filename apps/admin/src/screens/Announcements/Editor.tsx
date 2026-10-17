import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Image as ImageIcon, Megaphone, Prohibit, Rows, Trash, UploadSimple, WarningOctagon, Wrench } from "@phosphor-icons/react";
import {
  ANNOUNCEMENT_ICONS,
  announcementImageUrl,
  announcementState,
  announcementText,
  cn,
  type Announcement,
  type AnnouncementLanguage,
  type AnnouncementIcon,
  type AnnouncementKind,
  type AnnouncementSeverity,
} from "@etymos/shared";
import { useAdminAuth } from "../../lib/auth";
import {
  ANNOUNCEMENT_IMAGE_MAX_BYTES,
  ANNOUNCEMENT_IMAGE_TYPES,
  createAnnouncement,
  removeAnnouncementImage,
  updateAnnouncement,
  uploadAnnouncementImage,
  type AnnouncementInput,
} from "../../lib/configQueries";
import { friendlyError } from "../../lib/errors";
import { getLanguage, t, tr } from "../../lib/i18n";
import { ANNOUNCEMENT_ICON_COMPONENTS } from "./icons";
import { AnnouncementPreview } from "./Preview";
import { DEFAULT_MAINTENANCE_TEXT, KIND_LABELS, SEVERITY_BAR, SEVERITY_LABELS, fromLocalInput, toLocalInput } from "./shared";

const KINDS: { kind: AnnouncementKind; icon: typeof Rows; hint: string }[] = [
  { kind: "banner", icon: Rows, hint: tr("A bar across the top of every page") },
  { kind: "popup", icon: Megaphone, hint: tr("A dialog shown once to each visitor") },
  { kind: "maintenance", icon: Wrench, hint: tr("Locks the site until you end it") },
];

const SEVERITIES = Object.keys(SEVERITY_LABELS) as AnnouncementSeverity[];

/** One column of text boxes per site language. Labels are each language's own name. */
const TEXT_LANGUAGES: {
  lang: AnnouncementLanguage;
  label: string;
  short: string;
  title: "title" | "titleVi";
  message: "message" | "messageVi";
}[] = [
  { lang: "en", label: "English", short: "EN", title: "title", message: "message" },
  { lang: "vi", label: "Tiếng Việt", short: "VI", title: "titleVi", message: "messageVi" },
];

const MESSAGE_PLACEHOLDER: Record<AnnouncementLanguage, string> = {
  en: "Message shown to users…",
  vi: "Tin nhắn hiển thị cho người dùng…",
};

const inputBase =
  "rounded-control border border-border bg-surface-muted px-3 py-2 text-body text-fg outline-none focus-visible:border-accent";
// Separate widths: cn() doesn't merge Tailwind classes, so w-auto can't override w-full.
const inputClass = `w-full ${inputBase}`;

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-caption font-medium text-fg-muted">{label}</p>
      {children}
      {hint && <p className="mt-1 text-caption text-fg-subtle">{hint}</p>}
    </div>
  );
}

/** Two-option toggle (e.g. "Right away" / "At a set time"). */
function Choice<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex self-start rounded-control border border-border bg-surface-muted p-0.5">
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

interface Draft {
  kind: AnnouncementKind;
  title: string;
  message: string;
  titleVi: string;
  messageVi: string;
  severity: AnnouncementSeverity;
  icon: AnnouncementIcon | null;
  countdownOn: boolean;
  countdownTo: string; // datetime-local
  startMode: "now" | "at";
  startsAt: string;
  endOn: boolean;
  endsAt: string;
  imagePath: string | null;
}

function draftFrom(a: Announcement | null): Draft {
  return {
    kind: a?.kind ?? "banner",
    title: a?.title ?? "",
    message: a?.message ?? "",
    titleVi: a?.title_vi ?? "",
    messageVi: a?.message_vi ?? "",
    severity: a?.severity ?? "info",
    icon: a ? a.icon : "megaphone",
    countdownOn: Boolean(a?.countdown_to),
    countdownTo: toLocalInput(a?.countdown_to ?? null),
    startMode: a?.starts_at ? "at" : "now",
    startsAt: toLocalInput(a?.starts_at ?? null),
    endOn: Boolean(a?.ends_at),
    endsAt: toLocalInput(a?.ends_at ?? null),
    imagePath: a?.image_path ?? null,
  };
}

/** First problem with the draft, or null when it can be saved. */
function problem(d: Draft, file: File | null, editing: boolean): string | null {
  const now = Date.now();
  const starts = d.startMode === "at" ? fromLocalInput(d.startsAt) : null;
  if (d.startMode === "at" && !starts) return tr("Pick a start time.");
  // A past start is fine when editing something already running.
  if (starts && !editing && Date.parse(starts) < now - 60_000) return tr("The start time is in the past.");
  const hasMessage = Boolean(d.message.trim() || d.messageVi.trim());
  const hasTitle = Boolean(d.title.trim() || d.titleVi.trim());
  if (d.kind === "banner" && !hasMessage) return tr("Write the message for the top bar.");
  if (d.kind === "popup" && !hasTitle && !hasMessage && !d.imagePath && !file) {
    return tr("Add a title, text or an image.");
  }
  if (d.kind === "banner" && d.countdownOn) {
    const to = fromLocalInput(d.countdownTo);
    if (!to) return tr("Pick when the countdown ends.");
    if (Date.parse(to) <= now) return tr("The countdown has to end in the future.");
  }
  if (d.kind !== "maintenance" && d.endOn) {
    const ends = fromLocalInput(d.endsAt);
    if (!ends) return tr("Pick an end time.");
    if (Date.parse(ends) <= Math.max(now, starts ? Date.parse(starts) : 0)) return tr("The end time has to be after the start.");
  }
  return null;
}

/** Text written in one language but not the other: a nudge, not a blocker. */
function missingLanguage(d: Draft): string | null {
  const fields: [string, string][] = d.kind === "banner" ? [[d.message, d.messageVi]] : [[d.title, d.titleVi], [d.message, d.messageVi]];
  const enOnly = fields.some(([en, vi]) => en.trim() && !vi.trim());
  const viOnly = fields.some(([en, vi]) => vi.trim() && !en.trim());
  if (enOnly && !viOnly) return tr("Some boxes have no Vietnamese: visitors using Vietnamese see the English there.");
  if (viOnly && !enOnly) return tr("Some boxes have no English: visitors using English see the Vietnamese there.");
  if (enOnly && viOnly) return tr("Some boxes are filled in one language only: visitors see the other language there.");
  return null;
}

function toInput(d: Draft, imagePath: string | null, isActive: boolean): AnnouncementInput {
  const banner = d.kind === "banner";
  const popup = d.kind === "popup";
  return {
    kind: d.kind,
    title: banner ? null : d.title.trim() || null,
    message: d.message.trim(),
    title_vi: banner ? null : d.titleVi.trim() || null,
    message_vi: d.messageVi.trim(),
    severity: banner ? d.severity : "info",
    icon: banner ? d.icon : null,
    countdown_to: banner && d.countdownOn ? fromLocalInput(d.countdownTo) : null,
    image_path: popup ? imagePath : null,
    starts_at: d.startMode === "at" ? fromLocalInput(d.startsAt) : null,
    ends_at: d.kind !== "maintenance" && d.endOn ? fromLocalInput(d.endsAt) : null,
    is_active: isActive,
  };
}

/**
 * Create or edit one announcement, with a live preview. New announcements go
 * live on save (or at their start time). Starting maintenance right away asks
 * for confirmation first, since it locks the site.
 */
export function AnnouncementEditor({ editing, onDone }: { editing: Announcement | null; onDone: () => void }) {
  const { user } = useAdminAuth();
  const [d, setD] = useState<Draft>(() => draftFrom(editing));
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmLock, setConfirmLock] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [previewLang, setPreviewLang] = useState<AnnouncementLanguage>(getLanguage);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setD((prev) => ({ ...prev, [key]: value }));
    setConfirmLock(false);
  };

  const fileUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => void (fileUrl && URL.revokeObjectURL(fileUrl)), [fileUrl]);
  const imageUrl = fileUrl ?? announcementImageUrl(d.imagePath);

  const issue = problem(d, file, editing !== null);
  const languageGap = missingLanguage(d);
  const previewText = announcementText(
    { title: d.title, message: d.message, title_vi: d.titleVi, message_vi: d.messageVi },
    previewLang,
  );
  // Saving this locks the site right away (and it isn't locked already): confirm first.
  const locksNow =
    d.kind === "maintenance" &&
    d.startMode === "now" &&
    (editing ? editing.is_active && announcementState(editing) !== "live" : true);

  function pickFile(list: FileList | null) {
    const f = list?.[0];
    if (!f) return;
    if (!ANNOUNCEMENT_IMAGE_TYPES.includes(f.type)) return setError(t("Use a PNG, JPG, WebP or GIF image."));
    if (f.size > ANNOUNCEMENT_IMAGE_MAX_BYTES) return setError(t("Images can be up to 5 MB."));
    setError(null);
    setFile(f);
  }

  function clearImage() {
    setFile(null);
    set("imagePath", null);
  }

  async function save() {
    if (!user || issue || saving) return;
    if (locksNow && !confirmLock) {
      setConfirmLock(true);
      return;
    }
    setSaving(true);
    setError(null);
    let uploaded: string | null = null;
    try {
      if (d.kind === "popup" && file) uploaded = await uploadAnnouncementImage(file);
      const imagePath = d.kind === "popup" ? uploaded ?? d.imagePath : null;
      const input = toInput(d, imagePath, editing ? editing.is_active : true);
      if (editing) await updateAnnouncement(editing.id, input);
      else await createAnnouncement(input, user.id);
      // The old image is no longer used once the save went through.
      if (editing?.image_path && editing.image_path !== imagePath) await removeAnnouncementImage(editing.image_path);
      onDone();
    } catch (err) {
      if (uploaded) await removeAnnouncementImage(uploaded);
      setError(friendlyError(err));
      setSaving(false);
    }
  }

  const saveLabel = saving
    ? t("Saving…")
    : editing
      ? t("Save changes")
      : d.kind === "maintenance"
        ? d.startMode === "now"
          ? t("Start maintenance")
          : t("Schedule maintenance")
        : d.startMode === "now"
          ? t("Publish")
          : t("Schedule");

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="rounded-card border border-border bg-surface p-5 shadow-card sm:p-6">
        <h2 className="text-h2 font-semibold text-fg">{editing ? t("Edit announcement") : t("New announcement")}</h2>

        <div className="mt-4 grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label={t("Type")}>
          {KINDS.map(({ kind, icon: Icon, hint }) => (
            <button
              key={kind}
              type="button"
              role="radio"
              aria-checked={d.kind === kind}
              disabled={editing !== null && editing.kind !== kind}
              onClick={() => set("kind", kind)}
              className={cn(
                "flex items-start gap-2.5 rounded-control border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                d.kind === kind
                  ? kind === "maintenance"
                    ? "border-warning bg-warning-bg/60"
                    : "border-accent bg-accent-bg/60"
                  : "border-border hover:border-border-strong",
              )}
            >
              <Icon size={18} weight={d.kind === kind ? "fill" : "regular"} className={cn("mt-0.5 shrink-0", d.kind === kind ? (kind === "maintenance" ? "text-warning" : "text-accent") : "text-fg-muted")} />
              <span>
                <span className="block text-body font-medium text-fg">{t(KIND_LABELS[kind])}</span>
                <span className="block text-caption text-fg-muted">{t(hint)}</span>
              </span>
            </button>
          ))}
        </div>

        <div className="mt-5 space-y-4">
          <div>
            <div className="grid gap-4 md:grid-cols-2">
              {TEXT_LANGUAGES.map(({ lang, label, title, message }) => (
                <fieldset key={lang} className="space-y-3 rounded-control border border-border p-3.5" onFocus={() => setPreviewLang(lang)}>
                  <legend className="px-1 text-caption font-semibold text-fg">{label}</legend>
                  {d.kind !== "banner" && (
                    <Field label={t("Title")}>
                      <input
                        lang={lang}
                        value={d[title]}
                        maxLength={120}
                        onChange={(e) => set(title, e.target.value)}
                        placeholder={d.kind === "maintenance" ? DEFAULT_MAINTENANCE_TEXT[lang].title : undefined}
                        className={inputClass}
                      />
                    </Field>
                  )}
                  <Field label={t("Message")}>
                    <textarea
                      lang={lang}
                      value={d[message]}
                      rows={d.kind === "banner" ? 2 : 4}
                      maxLength={d.kind === "banner" ? 240 : 2000}
                      onChange={(e) => set(message, e.target.value)}
                      placeholder={d.kind === "maintenance" ? DEFAULT_MAINTENANCE_TEXT[lang].message : MESSAGE_PLACEHOLDER[lang]}
                      className={inputClass}
                    />
                  </Field>
                </fieldset>
              ))}
            </div>
            <p className="mt-1.5 text-caption text-fg-subtle">
              {d.kind === "maintenance"
                ? t("Visitors see the text in their language. Leave both blank for the standard “come back later” text.")
                : t("Visitors see the text in their language. A blank box falls back to the other language.")}
            </p>
            {languageGap && <p className="mt-1 text-caption text-warning">{t(languageGap)}</p>}
          </div>

          {d.kind === "banner" && (
            <>
              <Field label={t("Colour")}>
                <div className="flex flex-wrap gap-2">
                  {SEVERITIES.map((s) => (
                    <button
                      key={s}
                      type="button"
                      aria-pressed={d.severity === s}
                      onClick={() => set("severity", s)}
                      className={cn(
                        "rounded-full border px-3 py-1 text-caption font-medium",
                        SEVERITY_BAR[s],
                        d.severity === s ? "ring-2 ring-current ring-offset-1" : "opacity-80 hover:opacity-100",
                      )}
                    >
                      {t(SEVERITY_LABELS[s])}
                    </button>
                  ))}
                </div>
              </Field>

              <Field label={t("Icon")}>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    aria-pressed={d.icon === null}
                    title={t("No icon")}
                    onClick={() => set("icon", null)}
                    className={cn(
                      "flex size-9 items-center justify-center rounded-control border text-fg-muted",
                      d.icon === null ? "border-accent bg-accent-bg text-accent" : "border-border hover:border-border-strong",
                    )}
                  >
                    <Prohibit size={16} />
                  </button>
                  {ANNOUNCEMENT_ICONS.map((key) => {
                    const Icon = ANNOUNCEMENT_ICON_COMPONENTS[key];
                    return (
                      <button
                        key={key}
                        type="button"
                        aria-pressed={d.icon === key}
                        aria-label={key}
                        title={key}
                        onClick={() => set("icon", key)}
                        className={cn(
                          "flex size-9 items-center justify-center rounded-control border",
                          d.icon === key ? "border-accent bg-accent-bg text-accent" : "border-border text-fg-muted hover:border-border-strong hover:text-fg",
                        )}
                      >
                        <Icon size={17} weight={d.icon === key ? "fill" : "regular"} />
                      </button>
                    );
                  })}
                </div>
              </Field>

              <Field label={t("Countdown")} hint={d.countdownOn ? t("Shown next to the message. The bar disappears when it reaches zero.") : undefined}>
                <div className="flex flex-wrap items-center gap-3">
                  <Choice
                    value={d.countdownOn ? "on" : "off"}
                    options={[
                      ["off", t("None")],
                      ["on", t("Count down to")],
                    ]}
                    onChange={(v) => set("countdownOn", v === "on")}
                  />
                  {d.countdownOn && (
                    <input type="datetime-local" value={d.countdownTo} onChange={(e) => set("countdownTo", e.target.value)} className={inputBase} />
                  )}
                </div>
              </Field>
            </>
          )}

          {d.kind === "popup" && (
            <Field label={t("Image")} hint={t("PNG, JPG, WebP or GIF, up to 5 MB. Shown above the text, full width.")}>
              {imageUrl ? (
                <div className="flex items-center gap-3">
                  <img src={imageUrl} alt="" className="h-20 w-32 rounded-control border border-border object-cover" />
                  <div className="flex flex-col gap-1.5">
                    <button type="button" onClick={() => fileInput.current?.click()} className="inline-flex items-center gap-1.5 text-caption font-medium text-accent hover:underline">
                      <UploadSimple size={14} /> {t("Replace")}
                    </button>
                    <button type="button" onClick={clearImage} className="inline-flex items-center gap-1.5 text-caption font-medium text-destructive hover:underline">
                      <Trash size={14} /> {t("Remove")}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => fileInput.current?.click()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    pickFile(e.dataTransfer.files);
                  }}
                  className="flex w-full flex-col items-center gap-1.5 rounded-control border border-dashed border-border-strong bg-surface-muted/50 px-4 py-6 text-caption text-fg-muted hover:border-accent hover:text-accent"
                >
                  <ImageIcon size={22} />
                  {t("Choose an image or drop it here")}
                </button>
              )}
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
            </Field>
          )}

          <div className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
            <Field label={d.kind === "maintenance" ? t("Takes effect") : t("Starts")}>
              <div className="flex flex-col gap-2">
                <Choice
                  value={d.startMode}
                  options={[
                    ["now", d.kind === "maintenance" ? t("Immediately") : t("Right away")],
                    ["at", t("At a set time")],
                  ]}
                  onChange={(v) => set("startMode", v)}
                />
                {d.startMode === "at" && (
                  <input type="datetime-local" value={d.startsAt} onChange={(e) => set("startsAt", e.target.value)} className={inputClass} />
                )}
              </div>
            </Field>
            {d.kind === "maintenance" ? (
              <Field label={t("Ends")}>
                <p className="rounded-control bg-surface-muted px-3 py-2 text-caption text-fg-muted">
                  {t("When you end it. Visitors see the maintenance page until then; admins can still use the site.")}
                </p>
              </Field>
            ) : (
              <Field label={t("Ends")}>
                <div className="flex flex-col gap-2">
                  <Choice
                    value={d.endOn ? "at" : "never"}
                    options={[
                      ["never", t("When switched off")],
                      ["at", t("At a set time")],
                    ]}
                    onChange={(v) => set("endOn", v === "at")}
                  />
                  {d.endOn && (
                    <input type="datetime-local" value={d.endsAt} onChange={(e) => set("endsAt", e.target.value)} className={inputClass} />
                  )}
                </div>
              </Field>
            )}
          </div>
        </div>

        {error && <p className="mt-4 text-caption text-destructive">{error}</p>}

        {confirmLock ? (
          <div className="mt-5 flex flex-wrap items-center gap-3 rounded-control border border-destructive/40 bg-destructive-bg px-4 py-3">
            <WarningOctagon size={20} weight="fill" className="shrink-0 text-destructive" />
            <p className="flex-1 text-caption font-medium text-destructive">
              {t("This locks the site for everyone except admins as soon as you confirm. Visitors in the middle of something lose their place.")}
            </p>
            <button
              type="button"
              disabled={saving}
              onClick={save}
              className="rounded-control bg-destructive px-3.5 py-1.5 text-caption font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
            >
              {saving ? t("Saving…") : t("Lock the site now")}
            </button>
            <button type="button" onClick={() => setConfirmLock(false)} className="rounded-control px-3 py-1.5 text-caption font-medium text-fg-muted hover:bg-surface-raised">
              {t("Cancel")}
            </button>
          </div>
        ) : (
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={Boolean(issue) || saving}
              onClick={save}
              className={cn(
                "cursor-pointer rounded-control px-4 py-2 text-body font-semibold text-white transition hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50",
                d.kind === "maintenance" ? "bg-warning" : "bg-accent",
              )}
            >
              {saveLabel}
            </button>
            {editing && (
              <button type="button" onClick={onDone} className="rounded-control px-3 py-2 text-body font-medium text-fg-muted hover:bg-surface-raised">
                {t("Cancel")}
              </button>
            )}
            {issue && <p className="text-caption text-fg-subtle">{t(issue)}</p>}
          </div>
        )}
      </div>

      <div className="xl:sticky xl:top-6 xl:self-start">
        <div className="mb-2 flex items-center justify-between gap-3">
          <p className="text-micro font-semibold uppercase tracking-wider text-fg-subtle">{t("Preview")}</p>
          <Choice
            value={previewLang}
            options={TEXT_LANGUAGES.map(({ lang, short }) => [lang, short])}
            onChange={setPreviewLang}
          />
        </div>
        <AnnouncementPreview
          kind={d.kind}
          lang={previewLang}
          title={previewText.title}
          message={previewText.message}
          severity={d.severity}
          icon={d.icon}
          countdownTo={d.kind === "banner" && d.countdownOn ? fromLocalInput(d.countdownTo) : null}
          imageUrl={d.kind === "popup" ? imageUrl : null}
        />
      </div>
    </div>
  );
}
