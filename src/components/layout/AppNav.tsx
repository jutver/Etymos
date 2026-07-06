import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { CaretDown, ClockCounterClockwise, List, SignOut, Tag, UploadSimple, X } from "@phosphor-icons/react";
import { Logo } from "./Logo";
import { UsageMeter } from "../UsageMeter";
import { cn } from "../../lib/cn";
import { planLabel, useAppStore } from "../../lib/store";

const navLinks = [
  { label: "Upload", href: "/upload", icon: UploadSimple },
  { label: "History", href: "/dashboard", icon: ClockCounterClockwise },
  { label: "Pricing", href: "/pricing", icon: Tag },
];

export function AppNav() {
  const location = useLocation();
  const navigate = useNavigate();
  const plan = useAppStore((s) => s.plan);
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
    <header className="sticky top-0 z-40 h-[68px] border-b border-navy-700/60 bg-navy-900">
      <div className="mx-auto flex h-full max-w-[1600px] items-center justify-between gap-6 px-5 sm:px-8">
        <div className="flex items-center gap-8">
          <Logo variant="light" />
          <nav className="hidden items-center gap-1 md:flex">
            {navLinks.map((l) => {
              const active = location.pathname === l.href;
              return (
                <Link
                  key={l.href}
                  to={l.href}
                  className={cn(
                    "flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors",
                    active ? "bg-white/10 text-white" : "text-white/65 hover:bg-white/5 hover:text-white",
                  )}
                >
                  <l.icon size={16} weight={active ? "fill" : "regular"} />
                  {l.label}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="flex items-center gap-3">
          <div className="hidden sm:block">
            <UsageMeter compact />
          </div>

          <button
            onClick={() => setMobileNavOpen((v) => !v)}
            aria-label="Toggle navigation"
            className="flex size-9 items-center justify-center rounded-lg text-white/80 hover:bg-white/10 md:hidden"
          >
            {mobileNavOpen ? <X size={20} /> : <List size={20} />}
          </button>

          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className="flex items-center gap-2 rounded-full border border-white/15 bg-white/5 py-1 pl-1 pr-2.5 text-white transition-colors hover:bg-white/10"
            >
              <span className="flex size-7 items-center justify-center rounded-full bg-brand-400 text-xs font-bold text-white">
                LA
              </span>
              <CaretDown size={13} className={cn("transition-transform", menuOpen && "rotate-180")} />
            </button>

            {menuOpen && (
              <div className="absolute right-0 top-[calc(100%+10px)] w-60 rounded-[var(--radius-card)] border border-line bg-white p-2 text-ink-900 shadow-[var(--shadow-pop)]">
                <div className="px-3 py-2.5">
                  <p className="text-sm font-semibold">Lan Anh Nguyễn</p>
                  <p className="text-xs text-ink-500">{planLabel(plan)} plan</p>
                </div>
                <div className="h-px bg-line" />
                <Link
                  to="/pricing"
                  onClick={() => setMenuOpen(false)}
                  className="block rounded-lg px-3 py-2 text-sm font-medium text-ink-700 hover:bg-surface-tint"
                >
                  Manage plan
                </Link>
                <Link
                  to="/dashboard"
                  onClick={() => setMenuOpen(false)}
                  className="block rounded-lg px-3 py-2 text-sm font-medium text-ink-700 hover:bg-surface-tint"
                >
                  My documents
                </Link>
                <div className="h-px bg-line" />
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    navigate("/");
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-ink-700 hover:bg-surface-tint"
                >
                  <SignOut size={16} />
                  Log out
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {mobileNavOpen && (
        <div className="border-t border-navy-700/60 bg-navy-900 px-5 py-4 md:hidden">
          <div className="mb-3 sm:hidden">
            <UsageMeter />
          </div>
          <nav className="flex flex-col gap-1">
            {navLinks.map((l) => {
              const active = location.pathname === l.href;
              return (
                <Link
                  key={l.href}
                  to={l.href}
                  onClick={() => setMobileNavOpen(false)}
                  className={cn(
                    "flex items-center gap-2.5 rounded-lg px-3.5 py-2.5 text-sm font-medium transition-colors",
                    active ? "bg-white/10 text-white" : "text-white/65 hover:bg-white/5 hover:text-white",
                  )}
                >
                  <l.icon size={16} weight={active ? "fill" : "regular"} />
                  {l.label}
                </Link>
              );
            })}
          </nav>
        </div>
      )}
    </header>
  );
}
