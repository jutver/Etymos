import type { ReactNode } from "react";
import { CheckCircle, EnvelopeSimple, WarningCircle } from "@phosphor-icons/react";

type Tone = "success" | "error" | "info";

const TONE_STYLES: Record<Tone, string> = {
  success: "bg-green-100 text-green-600",
  error: "bg-severity-high-bg text-severity-high",
  info: "bg-brand-100 text-brand-600",
};

const TONE_ICONS: Record<Tone, ReactNode> = {
  success: <CheckCircle size={30} weight="fill" />,
  error: <WarningCircle size={30} weight="fill" />,
  info: <EnvelopeSimple size={28} weight="fill" />,
};

/** The centred icon + heading + message card the auth status screens share
 * (email verified, reset link sent/expired, recovery email confirmed...). */
export function AuthResultCard({
  tone,
  title,
  children,
  actions,
}: {
  tone: Tone;
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="rounded-[var(--radius-card-lg)] border border-line bg-white p-7 text-center shadow-[var(--shadow-card)] sm:p-8">
      <div className={`mx-auto flex size-14 items-center justify-center rounded-full ${TONE_STYLES[tone]}`}>
        {TONE_ICONS[tone]}
      </div>
      <h1 className="mt-5 text-h3 font-bold tracking-tight text-navy-900">{title}</h1>
      <div className="mt-2.5 text-sm leading-relaxed text-ink-600">{children}</div>
      {actions && <div className="mt-6 flex flex-col gap-3">{actions}</div>}
    </div>
  );
}
