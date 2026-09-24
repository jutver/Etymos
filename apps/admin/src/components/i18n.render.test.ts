// Renders the real admin navigation in both languages (server-side, no DOM).
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { setLanguage } from "../lib/i18n";
import { AdminNav } from "./layout/AdminNav";
import { LanguageSwitcher } from "./LanguageSwitcher";

const render = (component: () => ReturnType<typeof AdminNav>) =>
  renderToString(createElement(MemoryRouter, null, createElement(component)));

afterEach(() => setLanguage("en"));

describe("admin UI language", () => {
  it("renders the sidebar in English", () => {
    setLanguage("en");
    const html = render(AdminNav);
    expect(html).toContain("Moderation");
    expect(html).toContain("Log out");
  });

  it("renders the same sidebar in Vietnamese, including the new Activity screen", () => {
    setLanguage("vi");
    const html = render(AdminNav);
    expect(html).toContain("Kiểm duyệt");
    expect(html).toContain("Hoạt động");
    expect(html).toContain("Đăng xuất");
    expect(html).not.toContain(">Log out<");
  });

  it("offers a VI/EN switch with the active language marked", () => {
    setLanguage("vi");
    const html = renderToString(createElement(LanguageSwitcher));
    expect(html).toContain('aria-label="Ngôn ngữ"');
    expect(html).toMatch(/aria-pressed="true"[^>]*>VI</);
  });
});
