import { describe, expect, it, vi, beforeEach } from "vitest";
import { THEME_STORAGE_KEY, applyTheme, getStoredTheme, subscribeThemeStorage } from "./theme";

describe("theme helpers", () => {
  const storage = new Map<string, string>();
  const classes = new Set<string>();
  const style: Record<string, string> = {};
  const listeners = new Map<string, Set<(e: StorageEvent) => void>>();
  let themeColor = "#1E4FC4";

  beforeEach(() => {
    storage.clear();
    classes.clear();
    delete style.colorScheme;
    listeners.clear();
    themeColor = "#1E4FC4";

    vi.stubGlobal("localStorage", {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => {
        storage.set(k, v);
      },
    });
    vi.stubGlobal("document", {
      documentElement: {
        classList: {
          toggle: (name: string, force?: boolean) => {
            if (force === true) classes.add(name);
            else if (force === false) classes.delete(name);
            else if (classes.has(name)) classes.delete(name);
            else classes.add(name);
          },
        },
        style,
      },
      querySelector: (selector: string) =>
        selector === 'meta[name="theme-color"]'
          ? { setAttribute: (_attr: string, value: string) => { themeColor = value; } }
          : null,
    });
    vi.stubGlobal("window", {
      addEventListener: (name: string, fn: (e: StorageEvent) => void) => {
        const set = listeners.get(name) ?? new Set();
        set.add(fn);
        listeners.set(name, set);
      },
      removeEventListener: (name: string, fn: (e: StorageEvent) => void) => {
        listeners.get(name)?.delete(fn);
      },
    });
  });

  it("defaults to light when unset or invalid", () => {
    expect(getStoredTheme()).toBe("light");
    storage.set(THEME_STORAGE_KEY, "sepia");
    expect(getStoredTheme()).toBe("light");
    storage.set(THEME_STORAGE_KEY, "dark");
    expect(getStoredTheme()).toBe("dark");
  });

  it("applies .dark class, color-scheme, meta theme-color, and persists choice", () => {
    applyTheme("dark");
    expect(classes.has("dark")).toBe(true);
    expect(style.colorScheme).toBe("dark");
    expect(themeColor).toBe("#0B1220");
    expect(storage.get(THEME_STORAGE_KEY)).toBe("dark");

    applyTheme("light");
    expect(classes.has("dark")).toBe(false);
    expect(style.colorScheme).toBe("light");
    expect(themeColor).toBe("#1E4FC4");
    expect(storage.get(THEME_STORAGE_KEY)).toBe("light");
  });

  it("syncs theme across tabs on storage events", () => {
    const onChange = vi.fn();
    const unsub = subscribeThemeStorage(onChange);
    for (const fn of listeners.get("storage") ?? []) {
      fn({ key: THEME_STORAGE_KEY, newValue: "dark" } as StorageEvent);
    }
    expect(classes.has("dark")).toBe(true);
    expect(onChange).toHaveBeenCalledWith("dark");
    unsub();
  });
});
