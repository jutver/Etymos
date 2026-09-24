import type { ReactNode } from "react";
import { LockSimple } from "@phosphor-icons/react";
import { Button } from "./ui/Button";
import { useNavigate } from "react-router-dom";
import { t } from "../lib/i18n";

interface LockedOverlayProps {
  children: ReactNode;
  title: string;
  description: string;
  compact?: boolean;
}

export function LockedOverlay({ children, title, description, compact = false }: LockedOverlayProps) {
  const navigate = useNavigate();
  return (
    <div
      className={`relative overflow-hidden rounded-[var(--radius-card)] ${compact ? "min-h-[9rem]" : "min-h-[11rem]"}`}
    >
      <div aria-hidden className="pointer-events-none select-none opacity-60 blur-[5px]">
        {children}
      </div>
      <div className="absolute inset-0 flex items-center justify-center bg-white/90 p-4">
        <div className={`flex flex-col items-center text-center ${compact ? "gap-2" : "gap-3"}`}>
          <div className="flex size-11 items-center justify-center rounded-full border border-brand-300/60 bg-brand-100 text-brand-600">
            <LockSimple size={20} weight="fill" />
          </div>
          <div>
            <p className="text-sm font-semibold text-ink-900">{t(title)}</p>
            <p className="mx-auto mt-1 max-w-xs text-xs text-ink-500">{t(description)}</p>
          </div>
          <Button size="sm" onClick={() => navigate("/paywall")}>
            {t("Upgrade to unlock")}</Button>
        </div>
      </div>
    </div>
  );
}

export function LockedInlineBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-brand-300/60 bg-brand-100 px-2 py-0.5 text-[0.6875rem] font-semibold text-brand-600">
      <LockSimple size={11} weight="fill" />
      {t("Premium")}</span>
  );
}
