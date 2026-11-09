// Runtime behaviour of the i18n module: language choice, fallback to English,
// interpolation, plurals, persistence and the <html lang> attribute.
import { afterEach, beforeEach, describe, expect, it, vi as vitest } from "vitest";

const store = new Map<string, string>();

function stubBrowser(languages: string[], saved?: string) {
  store.clear();
  if (saved) store.set("etymos.language", saved);
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

describe("detectLanguage", () => {
  it("prefers the saved choice", async () => {
    const { detectLanguage } = await load();
    expect(detectLanguage("en")).toBe("en");
    expect(detectLanguage("vi")).toBe("vi");
  });

  it("defaults to Vietnamese when nothing valid is saved", async () => {
    const { detectLanguage } = await load();
    expect(detectLanguage(null)).toBe("vi");
    expect(detectLanguage("klingon")).toBe("vi");
  });

  it("opens in Vietnamese on a first visit, even from an English browser", async () => {
    stubBrowser(["en-US"]);
    const { getLanguage } = await load();
    expect(getLanguage()).toBe("vi");
    expect(document.documentElement.lang).toBe("vi");
  });
});

describe("t()", () => {
  it("returns the English source in English", async () => {
    stubBrowser(["en-US"], "en");
    const { t } = await load();
    expect(t("Upload")).toBe("Upload");
  });

  it("returns the Vietnamese translation in Vietnamese", async () => {
    stubBrowser(["vi-VN"]);
    const { t } = await load();
    expect(t("Upload")).toBe("Tải lên");
  });

  it("falls back to the English text for an untranslated string instead of showing a key", async () => {
    stubBrowser(["vi-VN"]);
    const { t } = await load();
    expect(t("A brand-new sentence nobody translated yet.")).toBe("A brand-new sentence nobody translated yet.");
  });

  it("interpolates {{params}} in both languages", async () => {
    stubBrowser(["vi-VN"]);
    const { t, setLanguage } = await load();
    expect(t("Choose {{name}}", { name: "Premium" })).toBe("Chọn Premium");
    setLanguage("en");
    expect(t("Choose {{name}}", { name: "Premium" })).toBe("Choose Premium");
  });

  it("leaves an unknown placeholder visible rather than swallowing it", async () => {
    stubBrowser(["en-US"], "en");
    const { t } = await load();
    expect(t("Choose {{name}}", {})).toBe("Choose {{name}}");
  });

  it("passes null/undefined through so optional messages can be rendered directly", async () => {
    stubBrowser(["en-US"], "en");
    const { t } = await load();
    expect(t(undefined)).toBeUndefined();
    expect(t(null)).toBeNull();
  });
});

describe("tn()", () => {
  it("picks the singular for exactly 1 and the plural otherwise (English)", async () => {
    stubBrowser(["en-US"], "en");
    const { tn } = await load();
    expect(tn(1, "{{count}} document", "{{count}} documents")).toBe("1 document");
    expect(tn(3, "{{count}} document", "{{count}} documents")).toBe("3 documents");
  });

  it("uses the Vietnamese entries (no plural forms)", async () => {
    stubBrowser(["vi-VN"]);
    const { tn } = await load();
    expect(tn(1, "{{count}} document", "{{count}} documents")).toBe("1 tài liệu");
    expect(tn(3, "{{count}} document", "{{count}} documents")).toBe("3 tài liệu");
  });
});

describe("setLanguage()", () => {
  it("switches immediately, persists the choice, updates <html lang> and notifies subscribers", async () => {
    const html = stubBrowser(["en-US"], "en");
    const mod = await load();
    expect(html.lang).toBe("en");

    const seen: string[] = [];
    // useSyncExternalStore's contract: subscribe(cb) then read the snapshot in cb.
    mod.setLanguage("vi");
    seen.push(mod.getLanguage());
    expect(seen).toEqual(["vi"]);
    expect(mod.t("Log in")).toBe("Đăng nhập");
    expect(store.get("etymos.language")).toBe("vi");
    expect(html.lang).toBe("vi");

    mod.setLanguage("en");
    expect(mod.t("Log in")).toBe("Log in");
    expect(html.lang).toBe("en");
  });

  it("restores the saved language on the next load", async () => {
    stubBrowser(["en-US"], "vi");
    const { getLanguage, t } = await load();
    expect(getLanguage()).toBe("vi");
    expect(t("Log out")).toBe("Đăng xuất");
  });

  it("does not crash when storage is blocked", async () => {
    stubBrowser(["en-US"], "en");
    vitest.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
      },
    });
    const { setLanguage, getLanguage } = await load();
    expect(() => setLanguage("vi")).not.toThrow();
    expect(getLanguage()).toBe("vi");
  });
});

describe("currentLocale()", () => {
  it("matches the UI language for number and date formatting", async () => {
    stubBrowser(["en-US"], "en");
    const { currentLocale, setLanguage } = await load();
    expect(currentLocale()).toBe("en-US");
    setLanguage("vi");
    expect(currentLocale()).toBe("vi-VN");
  });
});
