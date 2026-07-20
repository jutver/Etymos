import { NavLink, Outlet } from "react-router-dom";
import { cn } from "@etymos/shared";

const TABS = [
  { to: "/pricing/plans", label: "Plans & packs" },
  { to: "/pricing/discounts", label: "Discounts" },
];

export function PricingLayout() {
  return (
    <div>
      <h1 className="text-h1 font-semibold text-fg">Pricing</h1>
      <p className="mt-1 text-body text-fg-muted">Plans, credit packs, and discounts.</p>

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
            {tab.label}
          </NavLink>
        ))}
      </div>

      <div className="mt-5">
        <Outlet />
      </div>
    </div>
  );
}
