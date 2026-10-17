import { useEffect, useState } from "react";
import { cn } from "@etymos/shared";
import { t } from "../../lib/i18n";

function parts(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return { d: Math.floor(s / 86400), h: Math.floor((s % 86400) / 3600), m: Math.floor((s % 3600) / 60), s: s % 60 };
}

/** Ticking "2d 04h 12m 33s" until `to`. The days unit is left out under a day. */
export function Countdown({ to, className }: { to: string; className?: string }) {
  const target = Date.parse(to);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const { d, h, m, s } = parts(target - now);
  const units: [number, string][] = [
    ...(d > 0 ? ([[d, t("d")]] as [number, string][]) : []),
    [h, t("h")],
    [m, t("m")],
    [s, t("s")],
  ];

  return (
    <span className={cn("inline-flex items-center gap-1", className)} role="timer" aria-live="off">
      {units.map(([value, unit]) => (
        <span key={unit} className="inline-flex items-baseline gap-0.5 rounded-md bg-white/70 px-1.5 py-0.5 tabular-nums">
          <span className="font-bold">{String(value).padStart(2, "0")}</span>
          <span className="text-[0.7em] font-semibold opacity-70">{unit}</span>
        </span>
      ))}
    </span>
  );
}
