import { Link, NavLink } from "react-router-dom";
import { cn } from "@etymos/shared";
import { PolicyBody } from "../../components/legal/PolicyBody";
import { OWNER_ADDRESS, OWNER_NAME, POLICIES, type PolicySlug } from "../../components/legal/policies";
import { SUPPORT_EMAIL } from "../../components/support/labels";
import { t } from "../../lib/i18n";
import { termsDate } from "../../lib/terms";

/** One policy page (/terms, /privacy-policy, ...), with the whole policy set
 * listed alongside so each document stays short and easy to find. */
export default function LegalPage({ slug }: { slug: PolicySlug }) {
  const policy = POLICIES.find((p) => p.slug === slug) ?? POLICIES[0]!;

  return (
    <div className="mx-auto grid max-w-6xl gap-10 px-5 py-14 sm:px-8 sm:py-20 lg:grid-cols-[15rem_1fr] lg:gap-14">
      <nav aria-label={t("Policies & terms")} className="lg:sticky lg:top-24 lg:self-start">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">{t("Policies & terms")}</p>
        <ul className="-mx-5 mt-3 flex gap-2 overflow-x-auto px-5 pb-1 scrollbar-thin lg:mx-0 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:px-0">
          {POLICIES.map((p) => (
            <li key={p.slug} className="shrink-0">
              <NavLink
                to={p.path}
                className={({ isActive }) =>
                  cn(
                    "block whitespace-nowrap rounded-[var(--radius-control)] border px-3 py-2 text-sm transition-colors lg:whitespace-normal lg:border-transparent",
                    isActive
                      ? "border-brand-600 bg-brand-100 font-semibold text-brand-700"
                      : "border-line text-ink-600 hover:bg-surface-muted hover:text-ink-900",
                  )
                }
              >
                {t(p.title)}</NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <article className="min-w-0 max-w-3xl">
        <p className="text-xs font-semibold uppercase tracking-wide text-brand-600">{t("Legal")}</p>
        <h1 className="mt-2 text-h1 font-bold tracking-tight text-navy-900">{t(policy.title)}</h1>
        <p className="mt-3 text-sm text-ink-500">{t("Last updated: {{date}}", { date: termsDate() })}</p>

        <PolicyBody policy={policy} className="mt-10" />

        <dl className="mt-12 grid gap-4 rounded-[var(--radius-card)] border border-line bg-surface-tint p-5 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-ink-400">{t("Operated by")}</dt>
            <dd className="mt-1 font-medium text-navy-900">{OWNER_NAME}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-ink-400">{t("Address")}</dt>
            <dd className="mt-1 text-ink-700">{OWNER_ADDRESS}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-ink-400">{t("Email")}</dt>
            <dd className="mt-1">
              <a href={`mailto:${SUPPORT_EMAIL}`} className="font-medium text-brand-600 hover:underline">
                {SUPPORT_EMAIL}</a>
            </dd>
          </div>
        </dl>

        <p className="mt-6 text-sm text-ink-500">
          {t("Questions about these policies?")}{" "}
          <Link to="/contact" className="font-semibold text-brand-600 hover:underline">
            {t("Contact support")}</Link>
        </p>
      </article>
    </div>
  );
}
