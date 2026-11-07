// Logs: two groups. Server logs (what the backend is doing) and Admin
// actions (everything admins did, from the database and the backend).
import { NavLink, Outlet } from "react-router-dom";
import { Scroll, UserList } from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import { t, tr } from "../../lib/i18n";

const GROUPS = [
  { to: "/logs/server", label: tr("Server logs"), icon: Scroll },
  { to: "/logs/admin-actions", label: tr("Admin actions"), icon: UserList },
];

const SERVER_TABS = [
  { to: "/logs/server/live", label: tr("Live log") },
  { to: "/logs/server/files", label: tr("Log files") },
  { to: "/logs/server/status", label: tr("Server") },
];

export function LogsLayout() {
  return (
    <div>
      <h1 className="text-h1 font-semibold text-fg">{t("Logs")}</h1>
      <p className="mt-1 text-body text-fg-muted">
        {t("What the backend is doing, and everything admins have done.")}
      </p>

      <div className="mt-5 flex gap-1 border-b border-border">
        {GROUPS.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2 border-b-2 px-3 py-2 text-body font-medium transition-colors",
                isActive ? "border-accent text-accent" : "border-transparent text-fg-muted hover:text-fg",
              )
            }
          >
            <Icon size={16} weight="bold" />
            {t(label)}
          </NavLink>
        ))}
      </div>

      <div className="mt-5">
        <Outlet />
      </div>
    </div>
  );
}

export function ServerLogsLayout() {
  return (
    <div>
      <p className="text-caption text-fg-muted">
        {t("What the backend is doing right now: every request, every check step, and the server's state.")}
      </p>
      <div className="mt-3 inline-flex gap-0.5 rounded-card border border-border bg-surface p-1 shadow-card">
        {SERVER_TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) =>
              cn(
                "rounded-md px-3 py-1.5 text-caption font-medium transition-colors",
                isActive ? "bg-accent-bg text-accent" : "text-fg-muted hover:text-fg",
              )
            }
          >
            {t(tab.label)}
          </NavLink>
        ))}
      </div>
      <div className="mt-4">
        <Outlet />
      </div>
    </div>
  );
}
