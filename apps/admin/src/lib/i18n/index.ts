// Lightweight i18n for the admin app (no dependency). Same design as apps/web/src/lib/i18n.
//
// Convention: the ENGLISH TEXT IS THE KEY — `t("Upload a document")`. English
// therefore needs no catalog at all, code stays readable, and a string that has
// no Vietnamese translation yet simply renders in English instead of showing a
// raw key. Vietnamese lives in ./vi.ts as { "English text": "Tiếng Việt" }.
//
// Parameters use `{{name}}`:  t("You have {{count}} checks left", { count: 3 }).
//
// `tr()` is an identity marker for strings that live in module-level data
// (plan lists, FAQ arrays, step labels...) and are translated where they are
// rendered: the data holds English, the leaf that displays it calls `t(value)`.
// It exists so the catalog audit (i18n.audit.test.ts) still sees those strings.
//
// Reactivity: `t` reads the current language when it is called, so every screen
// must re-render on a language change. App subscribes with `useLanguage()`, which
// re-renders the whole route tree.
import { useSyncExternalStore } from "react";
import { vi } from "./vi";

export type Language = "en" | "vi";

export const LANGUAGES: readonly { code: Language; label: string; short: string }[] = [
  { code: "vi", label: "Tiếng Việt", short: "VI" },
  { code: "en", label: "English", short: "EN" },
];

const STORAGE_KEY = "etymos.admin.language";

const CATALOGS: Record<Language, Record<string, string>> = { en: {}, vi };

function isLanguage(value: unknown): value is Language {
  return value === "en" || value === "vi";
}

/** Saved choice wins; otherwise follow the browser; Vietnamese is the product default. */
export function detectLanguage(saved: string | null, browserLanguages: readonly string[]): Language {
  if (isLanguage(saved)) return saved;
  const first = browserLanguages.find(Boolean)?.toLowerCase();
  if (first && !first.startsWith("vi")) return "en";
  return "vi";
}

function readSaved(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function initialLanguage(): Language {
  if (typeof window === "undefined") return "en";
  const nav = typeof navigator !== "undefined" ? (navigator.languages?.length ? navigator.languages : [navigator.language]) : [];
  return detectLanguage(readSaved(), nav);
}

let current: Language = initialLanguage();
const listeners = new Set<() => void>();

function applyToDocument(lang: Language) {
  if (typeof document !== "undefined") document.documentElement.lang = lang;
}
applyToDocument(current);

export function getLanguage(): Language {
  return current;
}

export function setLanguage(lang: Language): void {
  if (lang === current) return;
  current = lang;
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // Private mode / blocked storage: the choice just won't survive a reload.
  }
  applyToDocument(lang);
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Subscribe a component to language changes (returns the current language). */
export function useLanguage(): Language {
  return useSyncExternalStore(subscribe, getLanguage, getLanguage);
}

export type TParams = Record<string, string | number>;

export function interpolate(template: string, params?: TParams): string {
  if (!params) return template;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

/** Translate an English source string into the current language. null/undefined pass through so
 * an optional value can be rendered directly (`{t(maybeMessage)}`). */
export function t(text: string, params?: TParams): string;
export function t(text: string | null | undefined, params?: TParams): string | null | undefined;
export function t(text: string | null | undefined, params?: TParams): string | null | undefined {
  if (text == null) return text;
  const translated = CATALOGS[current][text] ?? text;
  return interpolate(translated, params);
}

/** Choose by count (English one/other); Vietnamese has no plural so both map to one string. */
export function tn(count: number, one: string, other: string, params?: TParams): string {
  return t(count === 1 ? one : other, { count, ...params });
}

/** Marks a module-level string for the catalog; translated at the leaf that renders it. */
export function tr(text: string): string {
  return text;
}

/** Locale for Intl/Date formatting that matches the UI language. */
export function currentLocale(): string {
  return current === "vi" ? "vi-VN" : "en-US";
}
