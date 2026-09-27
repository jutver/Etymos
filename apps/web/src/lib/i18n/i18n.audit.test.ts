// Catalog audit for the translated screens and functionality currently wired
// into this checkout. The incoming catalog also contains strings for screens
// that were intentionally kept in the original design and are translated in
// later UI work, so catalog entries are allowed to be temporarily unused.
import { describe, expect, it } from "vitest";
import { vi } from "./vi";

// Every source file (not tests, not the i18n module itself), read as raw text.
const SOURCES = import.meta.glob(["../../**/*.{ts,tsx}", "!../../**/*.test.*", "!../../**/*.d.ts", "!../../lib/i18n/**"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const NAMES = "(?:t|tl|tI18n|tr|trm|trI18n)";
const DQ = String.raw`"(?:[^"\\]|\\.)*"`;
const CALL = new RegExp(String.raw`\b${NAMES}\(\s*(${DQ})`, "g");
const PLURAL = new RegExp(String.raw`\btn\(\s*[^,]+,\s*(${DQ})\s*,\s*(${DQ})`, "g");

function usedKeys(): Map<string, string> {
  const keys = new Map<string, string>();
  for (const [file, text] of Object.entries(SOURCES)) {
    const rel = file.replace("../../", "");
    for (const m of text.matchAll(CALL)) keys.set(JSON.parse(m[1]!), rel);
    for (const m of text.matchAll(PLURAL)) {
      keys.set(JSON.parse(m[1]!), rel);
      keys.set(JSON.parse(m[2]!), rel);
    }
  }
  return keys;
}

const placeholders = (s: string) => (s.match(/\{\{\w+\}\}/g) ?? []).sort();

describe("Vietnamese catalog", () => {
  const keys = usedKeys();

  it("finds the strings the code translates (guards against the scan silently matching nothing)", () => {
    expect(keys.size).toBeGreaterThan(50);
  });

  it("has a translation for every string used in the code", () => {
    const missing = [...keys].filter(([key]) => !(key in vi)).map(([key, file]) => `${file}: ${key}`);
    expect(missing).toEqual([]);
  });

  it("keeps the {{placeholders}} of every source string", () => {
    const broken = Object.entries(vi)
      .filter(([key, value]) => placeholders(key).join() !== placeholders(value).join())
      .map(([key]) => key);
    expect(broken).toEqual([]);
  });

  it("retains translations for the new feature labels", () => {
    expect(vi["AI content"]).toBeTruthy();
    expect(vi["Save {{percent}}% vs. monthly"]).toContain("{{percent}}");
  });

  it("never leaves a translation empty", () => {
    expect(Object.entries(vi).filter(([, value]) => !value.trim())).toEqual([]);
  });
});
