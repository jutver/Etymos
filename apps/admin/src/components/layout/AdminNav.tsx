import { NavLink } from "react-router-dom";
import {
  ChartLineUp,
  Users,
  ShieldWarning,
  SlidersHorizontal,
  SignOut,
} from "@phosphor-icons/react";
import { supabase } from "@etymos/shared";
import { cn } from "@etymos/shared";

const NAV_ITEMS = [
  { to: "/", label: "Dashboard", icon: ChartLineUp, end: true },
  { to: "/users", label: "Users", icon: Users },
  { to: "/moderation", label: "Moderation", icon: ShieldWarning },
  { to: "/config", label: "Config", icon: SlidersHorizontal },
];

export function AdminNav() {
  return (
    <nav className="flex h-dvh w-60 shrink-0 flex-col border-r border-border bg-surface">
      <div className="flex items-center gap-2 px-5 py-5">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-control bg-accent/15 font-mono text-sm font-semibold text-accent">
          E
        </div>
        <span className="font-mono text-sm font-semibold tracking-tight text-fg">
          Etymos Admin
        </span>
      </div>

      <div className="flex-1 space-y-1 px-3">
        {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2.5 rounded-control px-3 py-2 text-body font-medium transition-colors",
                isActive
                  ? "bg-accent-bg text-accent"
                  : "text-fg-muted hover:bg-surface-raised hover:text-fg",
              )
            }
          >
            <Icon size={18} weight="bold" />
            {label}
          </NavLink>
        ))}
      </div>

      <div className="border-t border-border p-3">
        <button
          type="button"
          onClick={() => supabase.auth.signOut()}
          className="flex w-full cursor-pointer items-center gap-2.5 rounded-control px-3 py-2 text-body font-medium text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg"
        >
          <SignOut size={18} weight="bold" />
          Log out
        </button>
      </div>
    </nav>
  );
}
