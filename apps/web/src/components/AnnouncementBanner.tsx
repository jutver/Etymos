// Top-of-page bars: the latest live banner announcement, and a notice when
// maintenance is scheduled. Mounted above both PublicShell and AppShell in
// App.tsx; data comes from AnnouncementsProvider (lib/announcements.tsx).
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Wrench, X } from "@phosphor-icons/react";
import { announcementText, cn, type Announcement, type AnnouncementSeverity } from "@etymos/shared";
import { Countdown } from "./announcements/Countdown";
import { ANNOUNCEMENT_ICON_COMPONENTS } from "./announcements/icons";
import { dismissAnnouncement, dismissedAnnouncements, useAnnouncements } from "../lib/announcements";
import { t, useLanguage } from "../lib/i18n";

const severityStyles: Record<AnnouncementSeverity, string> = {
  info: "bg-brand-100 border-brand-300 text-brand-700",
  success: "bg-success-bg border-success/30 text-success",
  warning: "bg-severity-moderate-bg border-severity-moderate-line text-severity-moderate",
  error: "bg-severity-high-bg border-severity-high-line text-severity-high",
};

function Bar({
  severity,
  onDismiss,
  children,
}: {
  severity: AnnouncementSeverity;
  onDismiss: () => void;
  children: ReactNode;
}) {
  return (
    <div role="status" className={cn("relative border-b px-12 py-2.5 text-sm font-medium", severityStyles[severity])}>
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-center gap-x-3 gap-y-1.5 text-center">
        {children}
      </div>
      <button
        onClick={onDismiss}
        aria-label={t("Dismiss announcement")}
        className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 transition-colors hover:bg-black/5 sm:right-5"
      >
        <X size={15} />
      </button>
    </div>
  );
}

function BannerBar({ banner, onDismiss }: { banner: Announcement; onDismiss: () => void }) {
  const Icon = banner.icon ? ANNOUNCEMENT_ICON_COMPONENTS[banner.icon] : null;
  const { message } = announcementText(banner, useLanguage());
  return (
    <Bar severity={banner.severity} onDismiss={onDismiss}>
      <p>
        {/* Inside the text so it wraps with the first word, not on a line of its own. */}
        {Icon && <Icon size={17} weight="fill" className="mr-2 inline-block align-[-0.2em]" />}
        {/* t(): seeded announcements may have catalog translations; admin text passes through. */}
        {t(message)}
      </p>
      {banner.countdown_to && <Countdown to={banner.countdown_to} />}
    </Bar>
  );
}

/**
 * Pins the bars to the top of the viewport and publishes their height as
 * `--banner-h` on <html>, so the sticky navs (and anchor scroll offsets) sit
 * below them instead of underneath. The variable is removed once the bars go.
 */
function StickyBars({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const observer = new ResizeObserver(() => root.style.setProperty("--banner-h", `${el.offsetHeight}px`));
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--banner-h");
    };
  }, []);

  return (
    <div ref={ref} className="sticky top-0 z-50">
      {children}
    </div>
  );
}

export function AnnouncementBanner() {
  const { banner, upcomingMaintenance } = useAnnouncements();
  // Dismissals made this session; earlier ones are read from storage.
  const [dismissed, setDismissed] = useState(dismissedAnnouncements);

  function dismiss(id: string) {
    dismissAnnouncement(id);
    setDismissed((prev) => new Set(prev).add(id));
  }

  const showMaintenance = upcomingMaintenance && !dismissed.has(upcomingMaintenance.id);
  const showBanner = banner && !dismissed.has(banner.id);
  if (!showMaintenance && !showBanner) return null;

  return (
    <StickyBars>
      {showMaintenance && (
        <Bar
          severity="warning"
          onDismiss={() => dismiss(upcomingMaintenance.id)}
        >
          <p>
            <Wrench size={17} weight="fill" className="mr-2 inline-block align-[-0.2em]" />
            {t("Scheduled maintenance: Etymos will be unavailable for a while starting in")}
          </p>
          <Countdown to={upcomingMaintenance.starts_at!} />
        </Bar>
      )}
      {showBanner && <BannerBar banner={banner} onDismiss={() => dismiss(banner.id)} />}
    </StickyBars>
  );
}
