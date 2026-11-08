// Building blocks shared by the public pages (Home, Features, Pricing, About,
// Contact): the section label chip, centred section headings with a
// highlighted phrase, the soft-glow page hero, a browser-window frame for
// product mock-ups, and the closing call-to-action band.
import type { ReactNode } from "react";
import { ArrowRight, Sparkle } from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import { Link } from "react-router-dom";
import { t } from "../../lib/i18n";
import "./marketing.css";

/** Small uppercase label above a heading: "• HOW IT WORKS". */
export function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("mk-chip", className)}>
      <span aria-hidden="true" className="mk-chip-dot" />
      {children}
    </span>
  );
}

/** A heading's emphasised phrase, in the brand gradient. */
export function Highlight({ children }: { children: ReactNode }) {
  return <span className="mk-highlight">{children}</span>;
}

export function SectionHeader({
  chip,
  title,
  lead,
  align = "center",
  className,
}: {
  chip: string;
  title: ReactNode;
  lead?: ReactNode;
  align?: "center" | "left";
  className?: string;
}) {
  return (
    <div className={cn("mk-reveal", align === "center" ? "mx-auto max-w-2xl text-center" : "max-w-xl", className)}>
      <Chip>{chip}</Chip>
      <h2 className="mk-h2 mt-4">{title}</h2>
      {lead && <p className={cn("mt-4 text-body-lg text-ink-600", align === "center" && "mx-auto max-w-xl")}>{lead}</p>}
    </div>
  );
}

/** The top of Features, Pricing, About and Contact. */
export function PageHero({
  chip,
  title,
  lead,
  children,
}: {
  chip: string;
  title: ReactNode;
  lead?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="mk-hero mk-page-hero">
      <div className="mk-hero-intro relative mx-auto max-w-3xl px-5 pb-16 pt-16 text-center sm:px-8 sm:pb-20 sm:pt-20">
        <Chip>{chip}</Chip>
        <h1 className="mk-h1 mt-5">{title}</h1>
        {lead && <p className="mx-auto mt-5 max-w-2xl text-body-lg text-ink-600">{lead}</p>}
        {children}
      </div>
    </section>
  );
}

/** A browser window around a product mock-up. */
export function WindowFrame({
  title,
  badge,
  children,
  className,
}: {
  title: string;
  badge?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mk-window", className)}>
      <div className="flex items-center gap-3 border-b border-line bg-surface-tint px-4 py-2.5">
        <span aria-hidden="true" className="flex gap-1.5">
          <span className="size-2.5 rounded-full bg-[#f87171]" />
          <span className="size-2.5 rounded-full bg-[#fbbf24]" />
          <span className="size-2.5 rounded-full bg-[#34d399]" />
        </span>
        <p className="min-w-0 flex-1 truncate text-xs font-medium text-ink-500">{title}</p>
        {badge && (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-success-bg px-2 py-0.5 text-[0.6875rem] font-semibold text-success">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
            {badge}
          </span>
        )}
      </div>
      <div className="@container p-4 sm:p-5">{children}</div>
    </div>
  );
}

/** The last section of every public page. */
export function CtaBand({ title, lead }: { title: ReactNode; lead: ReactNode }) {
  return (
    <section className="mx-auto max-w-6xl px-5 pb-24 sm:px-8">
      <div className="mk-reveal mk-cta">
        <Sparkle size={30} weight="fill" aria-hidden="true" className="mx-auto text-white/80" />
        <h2 className="mt-4 text-[clamp(1.75rem,3.2vw,2.5rem)] font-bold leading-tight tracking-tight text-white">{title}</h2>
        <p className="mx-auto mt-3 max-w-xl text-body-lg text-white/80">{lead}</p>
        <div className="mt-7 flex flex-wrap justify-center gap-3">
          <Link to="/signup" className="mk-cta-primary">
            {t("Start for free")}
            <ArrowRight size={18} aria-hidden="true" />
          </Link>
          <Link to="/pricing" className="mk-cta-secondary">
            {t("See pricing")}
          </Link>
        </div>
      </div>
    </section>
  );
}
