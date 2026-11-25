import { useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, MotionConfig, m } from "motion/react";
import { Cloud, CloudCheck, CloudSlash, WifiHigh, WifiSlash } from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import { useConnectivity, type ConnectivityState, type ServerConnectionStatus } from "../../lib/connectivity";
import { t, tr } from "../../lib/i18n";

export interface ConnectivityIndicatorProps {
  className?: string;
  /** "floating" (default) renders the fixed bottom-right full pill;
   *  "compact" renders a minimized icon-only pill button with a click-to-open detail popover. */
  variant?: "floating" | "compact";
  /** Optional override used in tests/SSR; defaults to useConnectivity(). */
  state?: Pick<ConnectivityState, "isOnline" | "serverStatus">;
  /** Initial open state for the compact detail popover (useful for tests). */
  defaultOpen?: boolean;
}

function serverLabelKey(status: ServerConnectionStatus, isOnline: boolean): string {
  if (!isOnline || status === "offline") return tr("Server offline");
  if (status === "connected") return tr("Server connected");
  if (status === "reconnecting") return tr("Reconnecting…");
  return tr("Connecting…");
}

function serverToneBg(status: ServerConnectionStatus, isOnline: boolean): string {
  if (!isOnline || status === "offline") return "bg-rose-500/10";
  if (status === "connected") return "bg-emerald-500/10";
  return "bg-amber-500/10";
}

function NetworkStatusIcon({ isOnline, size = 14 }: { isOnline: boolean; size?: number }) {
  return isOnline ? (
    <WifiHigh size={size} weight="bold" aria-hidden="true" className="text-emerald-600 dark:text-emerald-400 shrink-0" />
  ) : (
    <WifiSlash size={size} weight="bold" aria-hidden="true" className="text-rose-600 dark:text-rose-400 shrink-0" />
  );
}

function ServerStatusIcon({
  status,
  isOnline,
  size = 14,
}: {
  status: ServerConnectionStatus;
  isOnline: boolean;
  size?: number;
}) {
  if (!isOnline || status === "offline") {
    return (
      <CloudSlash size={size} weight="bold" aria-hidden="true" className="text-rose-600 dark:text-rose-400 shrink-0" />
    );
  }
  if (status === "connected") {
    return (
      <CloudCheck
        size={size}
        weight="bold"
        aria-hidden="true"
        className="text-emerald-600 dark:text-emerald-400 shrink-0"
      />
    );
  }
  return (
    <Cloud
      size={size}
      weight="bold"
      aria-hidden="true"
      className="text-amber-600 dark:text-amber-400 animate-pulse motion-reduce:animate-none shrink-0"
    />
  );
}

export function ConnectivityIndicator({
  className,
  variant = "floating",
  state,
  defaultOpen = false,
}: ConnectivityIndicatorProps) {
  const live = useConnectivity();
  const { isOnline, serverStatus } = state ?? live;

  const [open, setOpen] = useState(defaultOpen);
  const wrapRef = useRef<HTMLDivElement>(null);
  const popoverId = useId();

  useEffect(() => {
    if (variant !== "compact" || !open) return;
    const onPointer = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [variant, open]);

  const networkLabel = t(isOnline ? tr("Online") : tr("Offline"));
  const serverLabel = t(serverLabelKey(serverStatus, isOnline));
  const fullLabel = `${networkLabel} · ${serverLabel}`;

  if (variant === "compact") {
    return (
      <div ref={wrapRef} className={cn("relative inline-flex shrink-0", className)}>
        <span className="sr-only" role="status" aria-live="polite">
          {fullLabel}
        </span>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-controls={open ? popoverId : undefined}
          aria-label={fullLabel}
          title={fullLabel}
          className={cn(
            "inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-brand-500",
            open
              ? "border-brand-300 bg-brand-100"
              : "border-line bg-white hover:bg-surface-muted",
          )}
        >
          <NetworkStatusIcon isOnline={isOnline} size={14} />
          <span aria-hidden="true" className="h-3 w-px bg-line" />
          <ServerStatusIcon status={serverStatus} isOnline={isOnline} size={14} />
        </button>

        <MotionConfig reducedMotion="user">
          <div className="pointer-events-none absolute left-1/2 top-[calc(100%+8px)] z-30 -translate-x-1/2">
            <AnimatePresence>
              {open && (
                <m.div
                  id={popoverId}
                  role="dialog"
                  aria-label={t("Connection status")}
                  initial={{ opacity: 0, scale: 0.96, y: -6 }}
                  animate={{ opacity: 1, scale: 1, y: 0, transition: { duration: 0.18, ease: [0.22, 1, 0.36, 1] } }}
                  exit={{ opacity: 0, scale: 0.97, y: -4, transition: { duration: 0.12, ease: "easeIn" } }}
                  style={{ transformOrigin: "top center" }}
                  className="pointer-events-auto w-60 max-w-[calc(100vw-1.5rem)] rounded-[var(--radius-card)] border border-line bg-white p-3 text-left shadow-[var(--shadow-pop)]"
                >
                  <p className="text-micro font-bold uppercase tracking-wide text-ink-500">
                    {t("Connection status")}
                  </p>
                  <div className="mt-2.5 space-y-2">
                    <div className="flex items-center gap-2.5">
                      <span
                        className={cn(
                          "flex size-7 shrink-0 items-center justify-center rounded-full",
                          isOnline ? "bg-emerald-500/10" : "bg-rose-500/10",
                        )}
                      >
                        <NetworkStatusIcon isOnline={isOnline} size={15} />
                      </span>
                      <div className="min-w-0">
                        <span className="block text-micro text-ink-500">{t("Network")}</span>
                        <span className="block text-xs font-semibold text-ink-900">{networkLabel}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2.5">
                      <span
                        className={cn(
                          "flex size-7 shrink-0 items-center justify-center rounded-full",
                          serverToneBg(serverStatus, isOnline),
                        )}
                      >
                        <ServerStatusIcon status={serverStatus} isOnline={isOnline} size={15} />
                      </span>
                      <div className="min-w-0">
                        <span className="block text-micro text-ink-500">{t("Server")}</span>
                        <span className="block text-xs font-semibold text-ink-900">{serverLabel}</span>
                      </div>
                    </div>
                  </div>
                </m.div>
              )}
            </AnimatePresence>
          </div>
        </MotionConfig>
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={fullLabel}
      title={fullLabel}
      className={cn(
        "fixed bottom-4 right-4 z-40 inline-flex items-center gap-2 rounded-full border border-line bg-white/95 px-3 py-1.5 text-xs font-medium text-ink-900 shadow-[var(--shadow-card)] backdrop-blur-sm",
        className,
      )}
    >
      <span className="inline-flex items-center gap-1.5">
        <NetworkStatusIcon isOnline={isOnline} />
        <span className="font-semibold">{networkLabel}</span>
      </span>
      <span aria-hidden="true" className="h-3.5 w-px bg-line" />
      <span className="inline-flex items-center gap-1.5 text-ink-600">
        <ServerStatusIcon status={serverStatus} isOnline={isOnline} />
        <span>{serverLabel}</span>
      </span>
    </div>
  );
}
