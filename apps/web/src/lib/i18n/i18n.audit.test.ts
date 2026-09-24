// Catalog audit: every English string the code passes to t()/tr()/tn() must have a
// Vietnamese entry with the same {{placeholders}}, and no Vietnamese entry may be
// left behind once its string is gone from the code. This is what stops a new
// screen from quietly shipping half-translated.
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
    expect(keys.size).toBeGreaterThan(500);
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

  it("has no stale entries for strings that no longer exist in the code", () => {
    const stale = Object.keys(vi).filter((key) => !keys.has(key));
    expect(stale).toEqual([]);
  });

  it("never leaves a translation empty", () => {
    expect(Object.entries(vi).filter(([, value]) => !value.trim())).toEqual([]);
  });
});
