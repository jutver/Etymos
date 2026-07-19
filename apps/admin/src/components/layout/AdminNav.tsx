import { useState } from "react";
import { NavLink } from "react-router-dom";
import {
  ChartLineUp,
  Users,
  ShieldWarning,
  SealCheck,
  SlidersHorizontal,
  SignOut,
  List,
  X,
} from "@phosphor-icons/react";
import { supabase } from "@etymos/shared";
import { cn } from "@etymos/shared";

const NAV_ITEMS = [
  { to: "/", label: "Dashboard", icon: ChartLineUp, end: true },
  { to: "/users", label: "Users", icon: Users },
  { to: "/moderation", label: "Moderation", icon: ShieldWarning },
  { to: "/verification", label: "Verification", icon: SealCheck },
  { to: "/config", label: "Config", icon: SlidersHorizontal },
];

/** Etymos brand mark on the dark sidebar — mirrors apps/web/src/components/layout/Logo.tsx's
 * LogoMark(onDark) so the two apps read as the same product family. */
function BrandMark({ size = 38 }: { size?: number }) {
  return (
    <img
      src="/assets/logo/etymos-mark-white.svg"
      alt=""
      width={size}
      height={size}
      className="shrink-0 object-contain"
    />
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <BrandMark />
      <div className="leading-tight">
        <p className="text-sm font-bold tracking-tight text-white">Etymos</p>
        <p className="text-micro font-medium uppercase tracking-wider text-white/50">Admin</p>
      </div>
    </div>
  );
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="flex-1 space-y-1 px-3">
      {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              "flex items-center gap-2.5 rounded-control px-3 py-2 text-body font-medium transition-colors",
              isActive ? "bg-white/10 text-white" : "text-white/60 hover:bg-white/5 hover:text-white",
            )
          }
        >
          <Icon size={18} weight="bold" />
          {label}
        </NavLink>
      ))}
    </div>
  );
}

function LogoutButton() {
  return (
    <div className="border-t border-white/10 p-3">
      <button
        type="button"
        onClick={() => supabase.auth.signOut()}
        className="flex w-full cursor-pointer items-center gap-2.5 rounded-control px-3 py-2 text-body font-medium text-white/60 transition-colors hover:bg-white/5 hover:text-white"
      >
        <SignOut size={18} weight="bold" />
        Log out
      </button>
    </div>
  );
}

export function AdminNav() {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* Mobile/tablet top bar */}
      <header className="sticky top-0 z-40 flex h-14 shrink-0 items-center justify-between border-b border-navy-700/60 bg-navy-900 px-4 md:hidden">
        <Brand />
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label="Toggle navigation"
          aria-expanded={open}
          className="flex size-9 cursor-pointer items-center justify-center rounded-control text-white/80 transition hover:bg-white/10"
        >
          {open ? <X size={20} /> : <List size={20} />}
        </button>
      </header>

      {/* Mobile/tablet drawer */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-navy-900/60 md:hidden"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}
      <nav
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex h-dvh w-64 max-w-[80vw] flex-col bg-navy-900 shadow-pop transition-transform duration-200 ease-out md:hidden",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex items-center justify-between px-5 py-5">
          <Brand />
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close navigation"
            className="flex size-8 cursor-pointer items-center justify-center rounded-control text-white/70 hover:bg-white/10"
          >
            <X size={18} />
          </button>
        </div>
        <NavLinks onNavigate={() => setOpen(false)} />
        <LogoutButton />
      </nav>

      {/* Desktop sidebar */}
      <nav className="sticky top-0 z-30 hidden h-dvh w-60 shrink-0 flex-col bg-navy-900 md:flex">
        <div className="flex items-center gap-2 px-5 py-5">
          <Brand />
        </div>
        <NavLinks />
        <LogoutButton />
      </nav>
    </>
  );
}
