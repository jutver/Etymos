import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { List, X } from "@phosphor-icons/react";
import { Logo } from "./Logo";
import { Button } from "../ui/Button";
import { t, tr } from "../../lib/i18n";
import { LanguageSwitcher } from "../LanguageSwitcher";

const links = [
  { label: tr("Features"), href: "/#features" },
  { label: tr("How it works"), href: "/#how-it-works" },
  { label: tr("Pricing"), href: "/pricing" },
];

export function PublicNav() {
  const [open, setOpen] = useState(false);
  const location = useLocation();

  return (
    <header className="sticky top-0 z-40 border-b border-line/70 bg-white/85 backdrop-blur-md">
      <div className="mx-auto flex h-[68px] max-w-7xl items-center justify-between px-5 sm:px-8">
        <Logo />

        <nav className="hidden items-center gap-8 lg:flex">
          {links.map((l) => (
            <Link
              key={l.label}
              to={l.href}
              className="text-sm font-medium text-ink-700 transition-colors hover:text-brand-600"
            >
              {t(l.label)}
            </Link>
          ))}
        </nav>

        <div className="hidden items-center gap-3 lg:flex">
          <LanguageSwitcher />
          <Button as="link" to="/login" variant="ghost" size="sm">
            {t("Log in")}</Button>
          <Button as="link" to="/signup" size="sm">
            {t("Get Started")}</Button>
        </div>

        <button
          className="flex size-10 items-center justify-center rounded-lg text-ink-700 lg:hidden"
          onClick={() => setOpen((v) => !v)}
          aria-label={t("Toggle menu")}
        >
          {open ? <X size={22} /> : <List size={22} />}
        </button>
      </div>

      {open && (
        <div className="border-t border-line bg-white px-5 py-4 lg:hidden">
          <nav className="flex flex-col gap-1">
            {links.map((l) => (
              <Link
                key={l.label}
                to={l.href}
                onClick={() => setOpen(false)}
                className="rounded-lg px-3 py-2.5 text-sm font-medium text-ink-700 hover:bg-surface-tint"
              >
                {t(l.label)}
              </Link>
            ))}
          </nav>
          <div className="mt-3 flex flex-col gap-2">
            <LanguageSwitcher className="self-start" />
            <Button as="link" to="/login" variant="outline" fullWidth onClick={() => setOpen(false)}>
              {t("Log in")}</Button>
            <Button as="link" to="/signup" fullWidth onClick={() => setOpen(false)}>
              {t("Get Started")}</Button>
          </div>
        </div>
      )}
      <span className="sr-only">{location.pathname}</span>
    </header>
  );
}
