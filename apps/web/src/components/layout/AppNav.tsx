import { useEffect, useRef, useState, type ComponentProps } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  CaretDown,
  ClockCounterClockwise,
  FolderOpen,
  Lifebuoy,
  List,
  SignOut,
  Trash,
  UploadSimple,
  X,
} from "@phosphor-icons/react";
import { Logo } from "./Logo";
import { UsageMeter } from "../UsageMeter";
import { cn } from "@etymos/shared";
import { planLabel, useAppStore } from "../../lib/store";
import { useAuth, displayNameFor } from "../../lib/auth";
import { UserAvatar } from "../ui/UserAvatar";
import { supabase } from "@etymos/shared";
import { t, tr } from "../../lib/i18n";
import { LanguageSwitcher } from "../LanguageSwitcher";
import { AnimatePresence, MotionConfig, motion, type Variants } from "motion/react";
import { PillIndicator, usePill } from "../ui/PillIndicator";

const navLinks = [
  { label: tr("Upload"), href: "/upload", icon: UploadSimple },
  { label: tr("Documents"), href: "/documents", icon: FolderOpen },
  { label: tr("History"), href: "/history", icon: ClockCounterClockwise },
  { label: tr("My Trash"), href: "/trash", icon: Trash },
  { label: tr("Support"), href: "/account/support", icon: Lifebuoy },
];

/** Account menu motion: the panel scales from the avatar, its rows settle in
 * just after. Closing is quicker and all at once. */
const MENU: Variants = {
  closed: { opacity: 0, scale: 0.94, transition: { duration: 0.12, ease: "easeIn" } },
  open: {
    opacity: 1,
    scale: 1,
    transition: { type: "spring", stiffness: 520, damping: 34, staggerChildren: 0.03, delayChildren: 0.03 },
  },
};

const MENU_ITEM: Variants = {
  closed: { opacity: 0, y: 4 },
  open: { opacity: 1, y: 0, transition: { duration: 0.18, ease: "easeOut" } },
};

function MenuLink(props: ComponentProps<typeof Link>) {
  return (
    <motion.div variants={MENU_ITEM}>
      <Link {...props} />
    </motion.div>
  );
}

export function AppNav() {
  const location = useLocation();
  const activeHref = navLinks.find((l) => location.pathname === l.href || location.pathname.startsWith(`${l.href}/`))?.href ?? null;
  const navPill = usePill<HTMLElement>(activeHref);
  const navigate = useNavigate();
  const plan = useAppStore((s) => s.plan);
  const { user } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [menuOpen]);

  return (
    <header className="studio-nav workspace-navigation sticky top-[var(--banner-h,0px)] z-40 h-[68px] border-b border-navy-700/60 bg-navy-900 lg:fixed lg:bottom-0 lg:left-0 lg:h-auto lg:w-60">
      <div className="mx-auto flex h-full max-w-[1600px] items-center justify-between gap-6 px-5 sm:px-8 lg:flex-col lg:items-stretch lg:justify-start lg:px-5 lg:py-8">
        <div className="flex items-center gap-8 lg:flex-col lg:items-start lg:gap-12">
          <Logo variant="light" to="/upload" />
          <nav ref={navPill.ref} aria-label="Workspace navigation" className="relative hidden items-center gap-1 lg:flex lg:w-full lg:flex-col lg:items-stretch">
            {/* The active link's background, sliding to the page you open. */}
            <PillIndicator box={navPill.box} rounded="rounded-lg" className="bg-white/10" />
            {navLinks.map((l) => {
              const active = location.pathname === l.href || location.pathname.startsWith(`${l.href}/`);
              return (
                <Link
                  key={l.href}
                  to={l.href}
                  aria-current={active ? "page" : undefined}
                  data-pill-active={active}
                  className={cn(
                    "relative flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors",
                    active ? "text-white" : "text-white/65 hover:bg-white/5 hover:text-white",
                  )}
                >
                  <l.icon size={16} weight={active ? "fill" : "regular"} />
                  {t(l.label)}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="flex items-center gap-3 lg:mt-auto lg:flex-col lg:items-stretch lg:gap-4">
          <div className="hidden sm:block lg:hidden">
            <UsageMeter compact interactive={false} />
          </div>
          <div className="hidden lg:block">
            <UsageMeter variant="sidebar" />
          </div>

          {/* Language and account share one row: language left of the avatar in
              the top bar, avatar left / language right at the sidebar's foot. */}
          <div className="flex items-center gap-3 lg:flex-row-reverse lg:justify-between">
            <LanguageSwitcher tone="dark" />

            <button
              onClick={() => setMobileNavOpen((v) => !v)}
              aria-label={t("Toggle navigation")}
              aria-expanded={mobileNavOpen} aria-controls="workspace-mobile-navigation" className="flex size-11 items-center justify-center rounded-[var(--radius-input)] text-white/80 hover:bg-white/10 lg:hidden"
            >
              {mobileNavOpen ? <X size={20} /> : <List size={20} />}
            </button>

            <div className="relative" ref={menuRef}>
              <button
                onClick={() => setMenuOpen((v) => !v)}
                aria-label="Account menu"
                aria-expanded={menuOpen}
                className="flex items-center gap-2 rounded-full border border-white/15 bg-white/5 py-1 pl-1 pr-2.5 text-white transition-colors hover:bg-white/10"
              >
                <UserAvatar user={user} className="size-7 text-xs" />
                <CaretDown size={13} className={cn("transition-transform", menuOpen && "rotate-180")} />
              </button>

              <MotionConfig reducedMotion="user">
              <AnimatePresence>
              {menuOpen && (
                // Grows out of the avatar: down-right in the top bar, up-left at the sidebar's foot.
                <motion.div
                  variants={MENU}
                  initial="closed"
                  animate="open"
                  exit="closed"
                  className="studio-card absolute right-0 top-[calc(100%+10px)] z-50 w-60 origin-top-right rounded-[var(--radius-card)] border border-line bg-white p-2 text-ink-900 shadow-[var(--shadow-pop)] lg:bottom-[calc(100%+10px)] lg:left-0 lg:right-auto lg:top-auto lg:w-50 lg:origin-bottom-left"
                >
                  <motion.div variants={MENU_ITEM} className="px-3 py-2.5">
                    <p className="truncate text-sm font-semibold">{displayNameFor(user)}</p>
                    <p className="truncate text-xs text-ink-500">{user?.email ?? t("{{plan}} plan", { plan: planLabel(plan) })}</p>
                  </motion.div>
                  <div className="h-px bg-line" />
                  <MenuLink
                    to="/account/profile"
                    onClick={() => setMenuOpen(false)}
                    className="block rounded-lg px-3 py-2 text-sm font-medium text-ink-700 hover:bg-surface-tint"
                  >
                    {t("My Profile")}</MenuLink>
                  <MenuLink
                    to="/account/plan"
                    onClick={() => setMenuOpen(false)}
                    className="block rounded-lg px-3 py-2 text-sm font-medium text-ink-700 hover:bg-surface-tint"
                  >
                    {t("My Plan")}</MenuLink>
                  <MenuLink
                    to="/account/support"
                    onClick={() => setMenuOpen(false)}
                    className="block rounded-lg px-3 py-2 text-sm font-medium text-ink-700 hover:bg-surface-tint"
                  >
                    {t("Help & support")}</MenuLink>
                  <div className="h-px bg-line" />
                  <motion.button
                    variants={MENU_ITEM}
                    onClick={async () => {
                      setMenuOpen(false);
                      await supabase.auth.signOut();
                      navigate("/");
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-ink-700 hover:bg-surface-tint"
                  >
                    <SignOut size={16} />
                    {t("Log out")}</motion.button>
                </motion.div>
              )}
              </AnimatePresence>
              </MotionConfig>
            </div>
          </div>
        </div>
      </div>

      {mobileNavOpen && (
        <div id="workspace-mobile-navigation" className="max-h-[calc(100dvh-68px-var(--banner-h,0px))] overflow-y-auto border-t border-navy-700/60 bg-navy-900 px-5 py-4 lg:hidden">
          <div className="mb-3 sm:hidden">
            <UsageMeter interactive={false} />
          </div>
          <nav aria-label="Workspace navigation" className="flex flex-col gap-1">
            {navLinks.map((l) => {
              const active = location.pathname === l.href || location.pathname.startsWith(`${l.href}/`);
              return (
                <Link
                  key={l.href}
                  to={l.href}
                  onClick={() => setMobileNavOpen(false)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-2.5 rounded-lg px-3.5 py-2.5 text-sm font-medium transition-colors",
                    active ? "bg-white/10 text-white" : "text-white/65 hover:bg-white/5 hover:text-white",
                  )}
                >
                  <l.icon size={16} weight={active ? "fill" : "regular"} />
                  {t(l.label)}
                </Link>
              );
            })}
          </nav>
        </div>
      )}
    </header>
  );
}
