import { Link } from "react-router-dom";
import { EnvelopeSimple } from "@phosphor-icons/react";
import { Logo } from "./Logo";
import { t } from "../../lib/i18n";
import { SUPPORT_EMAIL } from "../support/labels";
import { POLICIES } from "../legal/policies";
import { SOCIAL_LINKS } from "../../lib/social";

export function Footer() {
  return (
    <footer className="editorial-footer border-t border-navy-700/60 bg-navy-900 text-white/70">
      <div className="mx-auto grid max-w-7xl gap-12 px-5 py-16 sm:px-8 md:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1.2fr]">
        <div>
          <Logo variant="light" /><p className="footer-statement">Thoughtful writing.<br /><em>Original by you.</em></p>
          <p className="mt-4 max-w-xs text-sm leading-relaxed text-white/55">
            {t("Vietnamese-first plagiarism detection, built to be affordable for every student and researcher.")}</p>
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            aria-label={t("Email Etymos support")}
            className="mt-5 inline-flex items-center gap-2 text-sm font-medium text-white/70 hover:text-white"
          >
            <EnvelopeSimple size={16} />
            {SUPPORT_EMAIL}</a>
          <ul className="mt-5 flex items-center gap-3">
            {SOCIAL_LINKS.map(({ label, href, Icon }) => (
              <li key={href}>
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={label()}
                  title={label()}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/15 text-white/70 transition-colors hover:border-white/40 hover:text-white"
                >
                  <Icon size={18} weight="fill" />
                </a>
              </li>
            ))}
          </ul>
        </div>

        <FooterColumn
          title={t("Product")}
          links={[
            { to: "/", label: t("Home") },
            { to: "/features", label: t("Features") },
            { to: "/pricing", label: t("Pricing") },
            { to: "/#how-it-works", label: t("How it works") },
          ]}
        />

        <FooterColumn
          title={t("Company")}
          links={[
            { to: "/about", label: t("About") },
            { to: "/contact", label: t("Contact") },
            { to: "/upload", label: t("Check a document") },
            { to: "/history", label: t("My history") },
          ]}
        />

        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-white/40">{t("Policies & terms")}</p>
          <ul className="mt-4 space-y-3 text-sm">
            {POLICIES.map((p) => (
              <li key={p.slug}>
                <Link to={p.path} className="hover:text-white">
                  {t(p.title)}</Link>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="border-t border-white/10">
        <div className="mx-auto flex max-w-7xl flex-col-reverse items-center gap-3 px-5 py-6 text-xs text-white/40 sm:flex-row sm:justify-between sm:px-8">
          <p>{t("© 2026 Etymos. Made for Vietnamese students and researchers.")}</p>
          <p>{t("Prices shown in VND")}</p>
        </div>
      </div>
    </footer>
  );
}

function FooterColumn({ title, links }: { title: string; links: { to: string; label: string }[] }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-white/40">{title}</p>
      <ul className="mt-4 space-y-3 text-sm">
        {links.map((link) => (
          <li key={link.to}>
            <Link to={link.to} className="hover:text-white">
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
