import { useEffect, useState } from "react";
import { Image as ImageIcon, PencilSimple, Timer, Trash, WarningOctagon, Wrench } from "@phosphor-icons/react";
import { announcementState, announcementText, cn, type Announcement, type AnnouncementKind } from "@etymos/shared";
import { StatusBadge } from "../../components/StatusBadge";
import { Switch } from "../../components/Switch";
import { ListItemsSkeleton } from "../../components/Skeleton";
import { deleteAnnouncement, listAnnouncements, setAnnouncementActive } from "../../lib/configQueries";
import { friendlyError } from "../../lib/errors";
import { currentLocale, getLanguage, t, tr } from "../../lib/i18n";
import { AnnouncementEditor } from "./Editor";
import { ANNOUNCEMENT_ICON_COMPONENTS } from "./icons";
import { DEFAULT_MAINTENANCE_TEXT, KIND_LABELS, STATE_LABELS, STATE_TONES, useNow } from "./shared";

type Filter = "all" | AnnouncementKind;

const FILTERS: [Filter, string][] = [
  ["all", tr("All")],
  ["banner", KIND_LABELS.banner],
  ["popup", KIND_LABELS.popup],
  ["maintenance", KIND_LABELS.maintenance],
];

function when(iso: string) {
  return new Date(iso).toLocaleString(currentLocale(), { dateStyle: "medium", timeStyle: "short" });
}

/** One line on timing: start, end, countdown. */
function schedule(a: Announcement): string {
  const bits: string[] = [];
  bits.push(a.starts_at ? t("Starts {{time}}", { time: when(a.starts_at) }) : t("Starts when switched on"));
  if (a.kind === "maintenance") bits.push(t("until ended by an admin"));
  else if (a.ends_at) bits.push(t("ends {{time}}", { time: when(a.ends_at) }));
  if (a.kind === "banner" && a.countdown_to) bits.push(t("countdown to {{time}}", { time: when(a.countdown_to) }));
  return bits.join(" · ");
}

/** Headline in the admin's language, falling back to the other one. */
function summary(a: Announcement): string {
  const lang = getLanguage();
  const { title, message } = announcementText(a, lang);
  if (a.kind === "maintenance") return title || message || DEFAULT_MAINTENANCE_TEXT[lang].title;
  return title || message || t("Image only");
}

/** Live or scheduled maintenance, pinned above everything with a way out. */
function MaintenanceStatus({ item, onEnd, ending }: { item: Announcement; onEnd: () => void; ending: boolean }) {
  const live = announcementState(item) === "live";
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-3 rounded-card border px-5 py-4",
        live ? "border-destructive/40 bg-destructive-bg" : "border-warning/40 bg-warning-bg",
      )}
    >
      {live ? (
        <WarningOctagon size={22} weight="fill" className="shrink-0 text-destructive" />
      ) : (
        <Wrench size={22} weight="fill" className="shrink-0 text-warning" />
      )}
      <div className="min-w-0 flex-1">
        <p className={cn("text-body font-semibold", live ? "text-destructive" : "text-warning")}>
          {live ? t("Maintenance is on: the site is locked") : t("Maintenance scheduled")}
        </p>
        <p className="text-caption text-fg-muted">
          {live
            ? t("Visitors see the maintenance page. Admins can still use the site.")
            : t("The site locks at {{time}}. Visitors see a countdown bar until then.", { time: when(item.starts_at!) })}
        </p>
      </div>
      <button
        type="button"
        disabled={ending}
        onClick={onEnd}
        className="rounded-control border border-border bg-surface px-3.5 py-2 text-caption font-semibold text-fg transition hover:bg-surface-raised disabled:opacity-60"
      >
        {ending ? t("Saving…") : live ? t("End maintenance") : t("Cancel maintenance")}
      </button>
    </div>
  );
}

export default function AnnouncementsPage() {
  const [items, setItems] = useState<Announcement[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [editing, setEditing] = useState<Announcement | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const now = useNow(30_000);

  function refresh() {
    return listAnnouncements()
      .then(setItems)
      .catch((err: unknown) => setError(friendlyError(err)));
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function toggle(a: Announcement, isActive: boolean) {
    setItems((prev) => prev?.map((x) => (x.id === a.id ? { ...x, is_active: isActive } : x)) ?? prev);
    setBusyId(a.id);
    try {
      await setAnnouncementActive(a.id, isActive);
    } catch (err) {
      setError(friendlyError(err));
      setItems((prev) => prev?.map((x) => (x.id === a.id ? { ...x, is_active: !isActive } : x)) ?? prev);
    } finally {
      setBusyId(null);
    }
  }

  async function remove(a: Announcement) {
    setBusyId(a.id);
    setError(null);
    try {
      await deleteAnnouncement(a);
      setItems((prev) => prev?.filter((x) => x.id !== a.id) ?? prev);
      if (editing?.id === a.id) closeEditor();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusyId(null);
      setConfirmDeleteId(null);
    }
  }

  function closeEditor() {
    setEditing(null);
    setEditorKey((k) => k + 1); // fresh, empty form
  }

  async function saved() {
    closeEditor();
    await refresh();
  }

  const maintenance = items?.find(
    (a) => a.kind === "maintenance" && ["live", "scheduled"].includes(announcementState(a, now)),
  );
  const shown = items?.filter((a) => filter === "all" || a.kind === filter) ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-h1 font-semibold text-fg">{t("Announcements")}</h1>
        <p className="mt-1 text-body text-fg-muted">
          {t("Top bars, pop-ups and maintenance mode for the Etymos site.")}
        </p>
      </div>

      {maintenance && (
        <MaintenanceStatus item={maintenance} ending={busyId === maintenance.id} onEnd={() => toggle(maintenance, false)} />
      )}

      <div id="announcement-editor">
        <AnnouncementEditor key={editing?.id ?? `new-${editorKey}`} editing={editing} onDone={saved} />
      </div>

      {error && <p className="text-caption text-destructive">{error}</p>}

      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-h2 font-semibold text-fg">{t("All announcements")}</h2>
          <div className="flex gap-1">
            {FILTERS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
                className={cn(
                  "rounded-control px-3 py-1.5 text-caption font-medium transition-colors",
                  filter === value ? "bg-accent-bg text-accent" : "text-fg-muted hover:bg-surface-raised hover:text-fg",
                )}
              >
                {t(label)}
              </button>
            ))}
          </div>
        </div>

        {!items ? (
          <div className="rounded-card border border-border bg-surface p-4 shadow-card">
            <ListItemsSkeleton count={4} />
          </div>
        ) : shown.length === 0 ? (
          <div className="rounded-card border border-border bg-surface p-6 text-body text-fg-subtle">
            {t("No announcements yet.")}
          </div>
        ) : (
          <ul className="divide-y divide-border rounded-card border border-border bg-surface shadow-card">
            {shown.map((a) => {
              const state = announcementState(a, now);
              const Icon = a.kind === "banner" && a.icon ? ANNOUNCEMENT_ICON_COMPONENTS[a.icon] : null;
              return (
                <li key={a.id} className={cn("flex flex-wrap items-center gap-4 px-5 py-4", editing?.id === a.id && "bg-accent-bg/40")}>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge label={KIND_LABELS[a.kind]} tone={a.kind === "maintenance" ? "warning" : "accent"} capitalize={false} />
                      <StatusBadge label={STATE_LABELS[state]} tone={STATE_TONES[state]} capitalize={false} />
                      {a.kind === "banner" && a.countdown_to && <Timer size={15} className="text-fg-subtle" aria-label={t("Has a countdown")} />}
                      {a.kind === "popup" && a.image_path && <ImageIcon size={15} className="text-fg-subtle" aria-label={t("Has an image")} />}
                    </div>
                    <p className="mt-1.5 flex items-center gap-1.5 text-body text-fg">
                      {Icon && <Icon size={15} weight="fill" className="shrink-0 text-fg-muted" />}
                      <span className="truncate">{summary(a)}</span>
                    </p>
                    <p className="mt-0.5 text-caption text-fg-subtle">{schedule(a)}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Switch checked={a.is_active} disabled={busyId === a.id} onChange={(v) => toggle(a, v)} />
                    <button
                      type="button"
                      title={t("Edit")}
                      aria-label={t("Edit")}
                      onClick={() => {
                        setEditing(a);
                        document.getElementById("announcement-editor")?.scrollIntoView({ behavior: "smooth", block: "start" });
                      }}
                      className="flex size-8 items-center justify-center rounded-control text-fg-muted transition hover:bg-surface-raised hover:text-fg"
                    >
                      <PencilSimple size={15} weight="bold" />
                    </button>
                    {confirmDeleteId === a.id ? (
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          disabled={busyId === a.id}
                          onClick={() => remove(a)}
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
                        title={t("Delete announcement")}
                        aria-label={t("Delete announcement")}
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
        )}
      </div>
    </div>
  );
}
