import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { AnimatePresence, MotionConfig, m, type Variants } from "motion/react";
import { Logo } from "./Logo";
import { Button } from "../ui/Button";
import { MenuIcon } from "../ui/MenuIcon";
import { t, tr } from "../../lib/i18n";
import { cn } from "@etymos/shared";
import { LanguageSwitcher } from "../LanguageSwitcher";
import { prefetchPricingData } from "../../lib/pricingData";

// Pricing's cards come from the database; start fetching them (and the page's
// code) when the visitor points at the link, so they're there on arrival.
function warmPricing() {
  prefetchPricingData();
  void import("../../screens/Pricing");
}

const links: { label: string; href: string; warm?: () => void }[] = [
  { label: tr("Home"), href: "/" },
  { label: tr("Features"), href: "/features" },
  { label: tr("Pricing"), href: "/pricing", warm: warmPricing },
  { label: tr("About"), href: "/about" },
  { label: tr("Contact"), href: "/contact" },
];

/** Mobile menu: unrolls down from under the top bar, its rows following one
 * after another. Closing rolls it back up, all at once. Same motion as the
 * signed-in app's menu. */
const MOBILE_NAV: Variants = {
  closed: { height: 0, opacity: 0, transition: { duration: 0.22, ease: [0.4, 0, 0.2, 1] } },
  open: {
    height: "auto",
    opacity: 1,
    transition: { duration: 0.32, ease: [0.22, 1, 0.36, 1], staggerChildren: 0.04, delayChildren: 0.06 },
  },
};

const MOBILE_NAV_ITEM: Variants = {
  closed: { opacity: 0, y: -8 },
  open: { opacity: 1, y: 0, transition: { duration: 0.24, ease: "easeOut" } },
};

export function PublicNav() {
  const [open, setOpen] = useState(false);
  const location = useLocation();

  return (
    <header className="public-nav sticky top-[var(--banner-h,0px)] z-40 border-b border-line/70 bg-white/95">
      <div className="mx-auto flex h-[80px] max-w-[1480px] items-center justify-between px-5 sm:px-8">
        <Logo />

        <nav aria-label="Primary navigation" className="hidden items-center gap-1 lg:flex">
          {links.map((l) => (
            <Link
              key={l.label}
              to={l.href}
              onPointerEnter={l.warm}
              onFocus={l.warm}
              aria-current={location.pathname === l.href ? "page" : undefined}
              className={cn(
                "relative rounded-[var(--radius-input)] px-4 py-2 text-sm font-medium transition-colors hover:text-brand-600",
                "after:absolute after:inset-x-4 after:-bottom-[20px] after:h-0.5 after:rounded-full after:bg-brand-500 after:transition-transform after:duration-300",
                location.pathname === l.href
                  ? "text-brand-600 after:scale-x-100"
                  : "text-ink-700 after:scale-x-0 hover:bg-surface-muted",
              )}
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
          className="flex size-11 items-center justify-center rounded-[var(--radius-input)] text-ink-700 hover:bg-surface-muted lg:hidden"
          onClick={() => setOpen((v) => !v)}
          aria-label={t("Toggle menu")}
          aria-expanded={open}
          aria-controls="public-mobile-navigation"
        >
          <MenuIcon open={open} />
        </button>
      </div>

      <MotionConfig reducedMotion="user">
      <AnimatePresence initial={false}>
      {open && (
        <m.div
          id="public-mobile-navigation"
          variants={MOBILE_NAV}
          initial="closed"
          animate="open"
          exit="closed"
          className="overflow-hidden border-t border-line bg-white lg:hidden"
        >
          <div className="max-h-[calc(100dvh-80px-var(--banner-h,0px))] overflow-y-auto px-5 py-4">
            <nav aria-label="Primary navigation" className="flex flex-col gap-1">
              {links.map((l) => (
                <m.div key={l.label} variants={MOBILE_NAV_ITEM}>
                  <Link
                    to={l.href}
                    onTouchStart={l.warm}
                    onClick={() => setOpen(false)}
                    aria-current={location.pathname === l.href ? "page" : undefined}
                    className={cn(
                      "block rounded-[var(--radius-input)] px-3 py-2.5 text-sm font-medium hover:bg-surface-tint",
                      location.pathname === l.href ? "bg-brand-100/60 text-brand-600" : "text-ink-700",
                    )}
                  >
                    {t(l.label)}
                  </Link>
                </m.div>
              ))}
            </nav>
            <div className="mt-3 flex flex-col gap-2">
              <m.div variants={MOBILE_NAV_ITEM} className="self-start">
                <LanguageSwitcher />
              </m.div>
              <m.div variants={MOBILE_NAV_ITEM}>
                <Button as="link" to="/login" variant="outline" fullWidth onClick={() => setOpen(false)}>
                  {t("Log in")}</Button>
              </m.div>
              <m.div variants={MOBILE_NAV_ITEM}>
                <Button as="link" to="/signup" fullWidth onClick={() => setOpen(false)}>
                  {t("Get Started")}</Button>
              </m.div>
            </div>
          </div>
        </m.div>
      )}
      </AnimatePresence>
      </MotionConfig>
      <span className="sr-only">{location.pathname}</span>
    </header>
  );
}
