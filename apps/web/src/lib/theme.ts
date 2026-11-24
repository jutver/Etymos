export const THEME_STORAGE_KEY = "etymos_theme";

export type ThemePreference = "light" | "dark";

const LIGHT_THEME_COLOR = "#1E4FC4";
const DARK_THEME_COLOR = "#0B1220";

/** Reads the cached theme preference (`"light"` default if missing or invalid). */
export function getStoredTheme(): ThemePreference {
  if (typeof globalThis.localStorage === "undefined") return "light";
  try {
    return globalThis.localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

/**
 * Applies the selected theme to `<html>` and optionally persists it to `localStorage`
 * so subsequent page loads match before React hydrates.
 */
export function applyTheme(theme: ThemePreference, persist = true): void {
  const normalized: ThemePreference = theme === "dark" ? "dark" : "light";

  if (typeof document !== "undefined") {
    const root = document.documentElement;
    root.classList.toggle("dark", normalized === "dark");
    root.style.colorScheme = normalized;
    const themeColorMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (themeColorMeta) {
      themeColorMeta.setAttribute("content", normalized === "dark" ? DARK_THEME_COLOR : LIGHT_THEME_COLOR);
    }
  }

  if (persist && typeof globalThis.localStorage !== "undefined") {
    try {
      globalThis.localStorage.setItem(THEME_STORAGE_KEY, normalized);
    } catch {
      // ignore storage quota / privacy mode errors
    }
  }
}

/** Subscribes to cross-tab `localStorage` theme updates cleanly. */
export function subscribeThemeStorage(onChange: (theme: ThemePreference) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handler = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY) return;
    const next: ThemePreference = event.newValue === "dark" ? "dark" : "light";
    applyTheme(next, false);
    onChange(next);
  };
  window.addEventListener("storage", handler);
  return () => window.removeEventListener("storage", handler);
}
