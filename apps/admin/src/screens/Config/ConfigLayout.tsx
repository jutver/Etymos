import { NavLink, Outlet } from "react-router-dom";
import { cn } from "@etymos/shared";
import { t, tr } from "../../lib/i18n";

const TABS = [
  { to: "/config/feature-flags", label: tr("Feature flags") },
  { to: "/config/announcements", label: tr("Announcements") },
  { to: "/config/system-health", label: tr("System health") },
];

export function ConfigLayout() {
  return (
    <div>
      <h1 className="text-h1 font-semibold text-fg">{t("Config")}</h1>
      <p className="mt-1 text-body text-fg-muted">{t("Feature flags, announcements, and system health.")}</p>

      <div className="mt-5 flex gap-1 border-b border-border">
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) =>
              cn(
                "border-b-2 px-3 py-2 text-body font-medium transition-colors",
                isActive
                  ? "border-accent text-accent"
                  : "border-transparent text-fg-muted hover:text-fg",
              )
            }
          >
            {t(tab.label)}
          </NavLink>
        ))}
      </div>

      <div className="mt-5">
        <Outlet />
      </div>
    </div>
  );
}
