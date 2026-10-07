import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  CaretDown,
  ClockCounterClockwise,
  FolderOpen,
  List,
  SignOut,
  Trash,
  UploadSimple,
  User,
  X,
} from "@phosphor-icons/react";
import { Logo } from "./Logo";
import { UsageMeter } from "../UsageMeter";
import { cn } from "@etymos/shared";
import { planLabel, useAppStore } from "../../lib/store";
import { useAuth, displayNameFor, initialsFor } from "../../lib/auth";
import { supabase } from "@etymos/shared";
import { t, tr } from "../../lib/i18n";
import { LanguageSwitcher } from "../LanguageSwitcher";

const navLinks = [
  { label: tr("Upload"), href: "/upload", icon: UploadSimple },
  { label: tr("Documents"), href: "/documents", icon: FolderOpen },
  { label: tr("History"), href: "/history", icon: ClockCounterClockwise },
  { label: tr("My Trash"), href: "/trash", icon: Trash },
];

export function AppNav() {
  const location = useLocation();
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
    <header className="studio-nav workspace-navigation sticky top-0 z-40 h-[68px] border-b border-navy-700/60 bg-navy-900 lg:fixed lg:inset-y-0 lg:left-0 lg:h-dvh lg:w-60">
      <div className="mx-auto flex h-full max-w-[1600px] items-center justify-between gap-6 px-5 sm:px-8 lg:flex-col lg:items-stretch lg:justify-start lg:px-5 lg:py-8">
        <div className="flex items-center gap-8 lg:flex-col lg:items-start lg:gap-12">
          <Logo variant="light" to="/upload" />
          <nav aria-label="Workspace navigation" className="hidden items-center gap-1 lg:flex lg:w-full lg:flex-col lg:items-stretch">
            {navLinks.map((l) => {
              const active = location.pathname === l.href;
              return (
                <Link
                  key={l.href}
                  to={l.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors",
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
                <span className="flex size-7 items-center justify-center rounded-full bg-brand-400 text-xs font-bold text-white">
                  {initialsFor(user) || <User size={14} weight="fill" />}
                </span>
                <CaretDown size={13} className={cn("transition-transform", menuOpen && "rotate-180")} />
              </button>

              {menuOpen && (
                <div className="studio-card absolute right-0 top-[calc(100%+10px)] z-50 w-60 rounded-[var(--radius-card)] border border-line bg-white p-2 text-ink-900 shadow-[var(--shadow-pop)] lg:bottom-[calc(100%+10px)] lg:left-0 lg:right-auto lg:top-auto lg:w-50">
                  <div className="px-3 py-2.5">
                    <p className="truncate text-sm font-semibold">{displayNameFor(user)}</p>
                    <p className="truncate text-xs text-ink-500">{user?.email ?? t("{{plan}} plan", { plan: planLabel(plan) })}</p>
                  </div>
                  <div className="h-px bg-line" />
                  <Link
                    to="/account/profile"
                    onClick={() => setMenuOpen(false)}
                    className="block rounded-lg px-3 py-2 text-sm font-medium text-ink-700 hover:bg-surface-tint"
                  >
                    {t("My Profile")}</Link>
                  <Link
                    to="/account/plan"
                    onClick={() => setMenuOpen(false)}
                    className="block rounded-lg px-3 py-2 text-sm font-medium text-ink-700 hover:bg-surface-tint"
                  >
                    {t("My Plan")}</Link>
                  <Link
                    to="/account/payments"
                    onClick={() => setMenuOpen(false)}
                    className="block rounded-lg px-3 py-2 text-sm font-medium text-ink-700 hover:bg-surface-tint"
                  >
                    {t("Payment history")}</Link>
                  <div className="h-px bg-line" />
                  <button
                    onClick={async () => {
                      setMenuOpen(false);
                      await supabase.auth.signOut();
                      navigate("/");
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-ink-700 hover:bg-surface-tint"
                  >
                    <SignOut size={16} />
                    {t("Log out")}</button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {mobileNavOpen && (
        <div id="workspace-mobile-navigation" className="max-h-[calc(100dvh-68px)] overflow-y-auto border-t border-navy-700/60 bg-navy-900 px-5 py-4 lg:hidden">
          <div className="mb-3 sm:hidden">
            <UsageMeter interactive={false} />
          </div>
          <nav aria-label="Workspace navigation" className="flex flex-col gap-1">
            {navLinks.map((l) => {
              const active = location.pathname === l.href;
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
