import { cn } from "@etymos/shared";
import { WifiHigh, WifiSlash } from "@phosphor-icons/react";
import { useConnectivity, type ServerConnectionStatus } from "../../lib/connectivity";
import { t, tr } from "../../lib/i18n";

interface ConnectivityIndicatorProps {
  className?: string;
}

function serverDotClass(status: ServerConnectionStatus, isOnline: boolean): string {
  if (!isOnline || status === "offline") return "bg-rose-500";
  if (status === "connected") return "bg-emerald-500";
  return "bg-amber-500 animate-pulse";
}

function serverLabelKey(status: ServerConnectionStatus, isOnline: boolean): string {
  if (!isOnline || status === "offline") return tr("Server offline");
  if (status === "connected") return tr("Server connected");
  if (status === "reconnecting") return tr("Reconnecting…");
  return tr("Connecting…");
}

export function ConnectivityIndicator({ className }: ConnectivityIndicatorProps) {
  const { isOnline, serverStatus } = useConnectivity();

  const networkLabel = t(isOnline ? tr("Online") : tr("Offline"));
  const serverLabel = t(serverLabelKey(serverStatus, isOnline));
  const fullLabel = `${networkLabel} · ${serverLabel}`;

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
        {isOnline ? (
          <WifiHigh size={14} weight="bold" className="text-emerald-600 dark:text-emerald-400 shrink-0" />
        ) : (
          <WifiSlash size={14} weight="bold" className="text-rose-600 dark:text-rose-400 shrink-0" />
        )}
        <span className="font-semibold">{networkLabel}</span>
      </span>
      <span aria-hidden="true" className="h-3.5 w-px bg-line" />
      <span className="inline-flex items-center gap-1.5 text-ink-600">
        <span
          aria-hidden="true"
          className={cn("size-2 rounded-full shrink-0", serverDotClass(serverStatus, isOnline))}
        />
        <span>{serverLabel}</span>
      </span>
    </div>
  );
}
