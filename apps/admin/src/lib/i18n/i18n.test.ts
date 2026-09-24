// Runtime behaviour of the admin i18n module: language choice, English fallback,
// interpolation, plurals, persistence.
import { afterEach, beforeEach, describe, expect, it, vi as vitest } from "vitest";

const store = new Map<string, string>();

function stubBrowser(languages: string[], saved?: string) {
  store.clear();
  if (saved) store.set("etymos.admin.language", saved);
  const documentElement = { lang: "" };
  vitest.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
  });
  vitest.stubGlobal("navigator", { languages, language: languages[0] });
  vitest.stubGlobal("document", { documentElement });
  return documentElement;
}

async function load() {
  vitest.resetModules();
  return import("./index");
}

beforeEach(() => store.clear());
afterEach(() => vitest.unstubAllGlobals());

describe("admin i18n", () => {
  it("defaults to Vietnamese, follows a non-Vietnamese browser, and prefers a saved choice", async () => {
    const { detectLanguage } = await load();
    expect(detectLanguage(null, [])).toBe("vi");
    expect(detectLanguage(null, ["vi-VN"])).toBe("vi");
    expect(detectLanguage(null, ["en-US"])).toBe("en");
    expect(detectLanguage("en", ["vi-VN"])).toBe("en");
    expect(detectLanguage("klingon", ["en-US"])).toBe("en");
  });

  it("translates, falls back to English for unknown text and interpolates", async () => {
    stubBrowser(["vi-VN"]);
    const { t, setLanguage } = await load();
    expect(t("Users")).toBe("Người dùng");
    expect(t("Something the catalog has never seen.")).toBe("Something the catalog has never seen.");
    expect(t("Banned until {{n}}", { n: "5/10" })).toBe("Bị cấm đến 5/10");
    setLanguage("en");
    expect(t("Users")).toBe("Users");
    expect(t("Banned until {{n}}", { n: "5/10" })).toBe("Banned until 5/10");
  });

  it("passes null/undefined through", async () => {
    stubBrowser(["en-US"]);
    const { t } = await load();
    expect(t(undefined)).toBeUndefined();
    expect(t(null)).toBeNull();
  });

  it("picks singular/plural in English and one form in Vietnamese", async () => {
    stubBrowser(["en-US"]);
    const en = await load();
    expect(en.tn(1, "{{count}} thing", "{{count}} things")).toBe("1 thing");
    expect(en.tn(3, "{{count}} thing", "{{count}} things")).toBe("3 things");
    en.setLanguage("vi");
    expect(en.tn(3, "{{count}} words", "{{count}} words")).toBe("3 từ");
  });

  it("persists the choice separately from the web app, updates <html lang>, and restores it", async () => {
    const html = stubBrowser(["en-US"]);
    const mod = await load();
    mod.setLanguage("vi");
    expect(store.get("etymos.admin.language")).toBe("vi");
    expect(store.has("etymos.language")).toBe(false);
    expect(html.lang).toBe("vi");
    expect(mod.currentLocale()).toBe("vi-VN");

    stubBrowser(["en-US"], "vi");
    const again = await load();
    expect(again.getLanguage()).toBe("vi");
  });
});
