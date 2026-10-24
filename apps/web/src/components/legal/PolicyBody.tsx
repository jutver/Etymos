import { Info } from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import { t } from "../../lib/i18n";
import { POLICY_PARAMS, type Policy, type PolicyBlock } from "./policies";

function Block({ block }: { block: PolicyBlock }) {
  switch (block.kind) {
    case "p":
      return <p className="text-sm leading-relaxed text-ink-600">{t(block.text, POLICY_PARAMS)}</p>;
    case "h3":
      return <h3 className="pt-1 text-sm font-bold text-navy-900">{t(block.text, POLICY_PARAMS)}</h3>;
    case "note":
      return (
        <div className="flex items-start gap-2.5 rounded-[var(--radius-control)] border border-line bg-surface-muted px-4 py-3 text-sm leading-relaxed text-ink-700">
          <Info size={18} weight="fill" className="mt-0.5 shrink-0 text-brand-600" />
          <span>{t(block.text, POLICY_PARAMS)}</span>
        </div>
      );
    case "list":
      return (
        <ul className="list-disc space-y-2 pl-5 text-sm leading-relaxed text-ink-600 marker:text-ink-300">
          {block.items.map((item) => (
            <li key={item}>{t(item, POLICY_PARAMS)}</li>
          ))}
        </ul>
      );
    case "steps":
      return (
        <ol className="space-y-3">
          {block.items.map((step, i) => (
            <li key={step.title} className="flex gap-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-700">
                {i + 1}</span>
              <div className="text-sm leading-relaxed">
                <p className="font-semibold text-navy-900">{t(step.title, POLICY_PARAMS)}</p>
                <p className="text-ink-600">{t(step.text, POLICY_PARAMS)}</p>
              </div>
            </li>
          ))}
        </ol>
      );
  }
}

/** A policy's intro and sections, shared by the legal pages and the Terms gate. */
export function PolicyBody({ policy, className }: { policy: Policy; className?: string }) {
  return (
    <div className={cn("space-y-8", className)}>
      {policy.intro.length > 0 && (
        <div className="space-y-3">
          {policy.intro.map((p) => (
            <p key={p} className="text-sm leading-relaxed text-ink-600">
              {t(p, POLICY_PARAMS)}</p>
          ))}
        </div>
      )}
      {policy.sections.map((section) => (
        <section key={section.title} className="space-y-3">
          <h2 className="text-lg font-bold tracking-tight text-navy-900">{t(section.title)}</h2>
          {section.blocks.map((block, i) => (
            <Block key={i} block={block} />
          ))}
        </section>
      ))}
    </div>
  );
}
