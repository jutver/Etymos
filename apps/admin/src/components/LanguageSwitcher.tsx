import { cn } from "@etymos/shared";
import { LANGUAGES, setLanguage, t, useLanguage } from "../lib/i18n";

/**
 * VI | EN segmented toggle for the admin portal. `tone="dark"` is for the navy
 * sidebar, `tone="light"` for the login card surface. Same behaviour as the web
 * app's switcher; the choice is remembered separately (the two apps run on
 * different origins).
 */
export function LanguageSwitcher({ tone = "light", className }: { tone?: "light" | "dark"; className?: string }) {
  const current = useLanguage();
  const dark = tone === "dark";

  return (
    <div
      role="group"
      aria-label={t("Language")}
      className={cn(
        "inline-flex items-center rounded-full border p-0.5 text-[11px] font-bold",
        dark ? "border-white/15 bg-white/5" : "border-border bg-surface",
        className,
      )}
    >
      {LANGUAGES.map(({ code, label, short }) => {
        const active = code === current;
        return (
          <button
            key={code}
            type="button"
            lang={code}
            title={label}
            aria-pressed={active}
            onClick={() => setLanguage(code)}
            className={cn(
              "cursor-pointer rounded-full px-2.5 py-1 transition-colors",
              active
                ? dark
                  ? "bg-white text-navy-900"
                  : "bg-accent text-white"
                : dark
                  ? "text-white/60 hover:text-white"
                  : "text-fg-muted hover:text-fg",
            )}
          >
            {short}
          </button>
        );
      })}
    </div>
  );
}
