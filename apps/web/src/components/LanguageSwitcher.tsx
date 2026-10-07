import { cn } from "@etymos/shared";
import { LANGUAGES, setLanguage, t, useLanguage } from "../lib/i18n";

/**
 * VI | EN segmented toggle. `tone="dark"` is for the navy app header,
 * `tone="light"` for white/tinted surfaces. Selecting a language re-renders the
 * whole app (see useLanguage in App.tsx) and is remembered in localStorage.
 */
export function LanguageSwitcher({ tone = "light", className }: { tone?: "light" | "dark"; className?: string }) {
  const current = useLanguage();
  const dark = tone === "dark";

  return (
    <div
      role="group"
      aria-label={t("Language")}
      className={cn(
        "inline-flex w-fit shrink-0 items-center rounded-full border font-bold",
        // Dark (app nav) matches the height of the avatar button beside it.
        dark ? "border-white/15 bg-white/5 p-1 text-xs" : "border-line bg-white p-0.5 text-[11px]",
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
              "rounded-full transition-colors",
              dark ? "px-3 py-1" : "px-2.5 py-1",
              active
                ? dark
                  ? "bg-white text-navy-900"
                  : "bg-brand-600 text-white"
                : dark
                  ? "text-white/65 hover:text-white"
                  : "text-ink-500 hover:text-ink-900",
            )}
          >
            {short}
          </button>
        );
      })}
    </div>
  );
}
