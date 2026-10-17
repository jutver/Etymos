import { Wrench, X } from "@phosphor-icons/react";
import { cn, type AnnouncementIcon, type AnnouncementKind, type AnnouncementSeverity } from "@etymos/shared";
import { ANNOUNCEMENT_ICON_COMPONENTS } from "./icons";
import { Countdown, DEFAULT_MAINTENANCE_MESSAGE, DEFAULT_MAINTENANCE_TITLE, SEVERITY_BAR } from "./shared";
import { t } from "../../lib/i18n";

export interface PreviewProps {
  kind: AnnouncementKind;
  title: string;
  message: string;
  severity: AnnouncementSeverity;
  icon: AnnouncementIcon | null;
  countdownTo: string | null;
  imageUrl: string | null;
}

/** Fake page chrome so the preview reads as "this is the site". */
function PageSkeleton() {
  return (
    <div className="space-y-2 p-4" aria-hidden="true">
      <div className="h-2.5 w-1/3 rounded bg-border" />
      <div className="h-2 w-2/3 rounded bg-surface-muted" />
      <div className="h-2 w-1/2 rounded bg-surface-muted" />
      <div className="mt-4 h-16 rounded-control bg-surface-muted" />
    </div>
  );
}

function BannerPreview({ message, severity, icon, countdownTo }: PreviewProps) {
  const Icon = icon ? ANNOUNCEMENT_ICON_COMPONENTS[icon] : null;
  return (
    <>
      <div className={cn("relative border-b px-9 py-2 text-caption font-medium", SEVERITY_BAR[severity])}>
        <div className="flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 text-center">
          <span>
            {/* Inside the text so it wraps with the first word, not on a line of its own. */}
            {Icon && <Icon size={15} weight="fill" className="mr-1.5 inline-block align-[-0.15em]" />}
            {message.trim() || t("Your message")}
          </span>
          {countdownTo && Date.parse(countdownTo) > Date.now() && <Countdown to={countdownTo} className="text-micro" />}
        </div>
        <X size={13} className="absolute right-3 top-1/2 -translate-y-1/2 opacity-70" />
      </div>
      <div className="flex h-8 items-center justify-between border-b border-border bg-surface px-4">
        <div className="h-2.5 w-16 rounded bg-border" />
        <div className="h-2.5 w-24 rounded bg-surface-muted" />
      </div>
      <PageSkeleton />
    </>
  );
}

function PopupPreview({ title, message, imageUrl }: PreviewProps) {
  const hasText = Boolean(title.trim() || message.trim());
  return (
    <div className="relative">
      <div className="opacity-40">
        <PageSkeleton />
        <PageSkeleton />
      </div>
      <div className="absolute inset-0 flex items-center justify-center bg-navy-900/40 p-4">
        <div className="relative w-full max-w-[260px] overflow-hidden rounded-card bg-surface shadow-pop">
          <span className="absolute right-2 top-2 z-10 flex size-6 items-center justify-center rounded-full bg-white/90 text-fg-muted">
            <X size={12} />
          </span>
          {imageUrl && <img src={imageUrl} alt="" className="block max-h-40 w-full object-cover" />}
          <div className={hasText ? "p-4" : "p-3"}>
            {title.trim() && <p className="pr-5 text-body font-bold text-fg">{title}</p>}
            {message.trim() && <p className="mt-1 line-clamp-4 whitespace-pre-line text-caption text-fg-muted">{message}</p>}
            {!hasText && !imageUrl && <p className="text-caption text-fg-subtle">{t("Add a title, text or an image.")}</p>}
            <div className={cn("rounded-control bg-accent py-1.5 text-center text-caption font-semibold text-white", hasText && "mt-3")}>
              {t("Got it")}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function MaintenancePreview({ title, message }: PreviewProps) {
  return (
    <div className="flex min-h-64 items-center justify-center bg-bg p-5">
      <div className="w-full max-w-[280px] rounded-card border border-border bg-surface p-5 text-center shadow-card">
        <span className="mx-auto flex size-9 items-center justify-center rounded-full bg-warning-bg text-warning">
          <Wrench size={17} weight="fill" />
        </span>
        <p className="mt-3 text-body font-bold text-fg">{title.trim() || t(DEFAULT_MAINTENANCE_TITLE)}</p>
        <p className="mt-1.5 line-clamp-5 whitespace-pre-line text-caption text-fg-muted">
          {message.trim() || t(DEFAULT_MAINTENANCE_MESSAGE)}
        </p>
      </div>
    </div>
  );
}

/** What visitors will see, in a mock browser window. */
export function AnnouncementPreview(props: PreviewProps) {
  return (
    <div className="overflow-hidden rounded-card border border-border bg-surface shadow-card">
      <div className="flex items-center gap-1.5 border-b border-border bg-surface-muted px-3 py-2">
        <span className="size-2 rounded-full bg-border-strong" />
        <span className="size-2 rounded-full bg-border-strong" />
        <span className="size-2 rounded-full bg-border-strong" />
        <span className="ml-2 truncate rounded bg-surface px-2 py-0.5 text-micro text-fg-subtle">etymos.site</span>
      </div>
      {props.kind === "banner" && <BannerPreview {...props} />}
      {props.kind === "popup" && <PopupPreview {...props} />}
      {props.kind === "maintenance" && <MaintenancePreview {...props} />}
    </div>
  );
}
