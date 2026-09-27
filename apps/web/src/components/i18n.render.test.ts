// Renders real components in both languages (server-side, no DOM) to prove the
// language switch actually changes what a user sees — not just the catalog.
import { createElement, type ComponentType } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { setLanguage } from "../lib/i18n";
import { PublicNav } from "./layout/PublicNav";
import { Footer } from "./layout/Footer";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { PlanCard } from "./PlanCard";
import { PLANS } from "../lib/mockData";

const render = <P extends object>(component: ComponentType<P>, props?: P) =>
  renderToString(createElement(MemoryRouter, null, createElement(component, props as P)));

const planProps = { plan: PLANS[1]!, billingCycle: "monthly" as const };

afterEach(() => setLanguage("en"));

describe("UI language", () => {
  it("renders the navigation in English", () => {
    setLanguage("en");
    const html = render(PublicNav);
    expect(html).toContain("Log in");
    expect(html).toContain("Pricing");
    expect(html).not.toContain("Đăng nhập");
  });

  it("renders the same navigation in Vietnamese", () => {
    setLanguage("vi");
    const html = render(PublicNav);
    expect(html).toContain("Đăng nhập");
    expect(html).toContain("Bảng giá");
    expect(html).toContain("Tính năng");
    expect(html).not.toContain(">Log in<");
  });

  it("translates the footer, including the parameter-free tagline", () => {
    setLanguage("vi");
    const html = render(Footer);
    expect(html).toContain("ưu tiên tiếng Việt");
  });

  it("translates plan cards built from data (plan names and feature lists)", () => {
    setLanguage("vi");
    const html = render(PlanCard, planProps);
    expect(html).toContain("Phát hiện đạo văn theo ngữ nghĩa");
    expect(html).toContain("Hỗ trợ ưu tiên");
    setLanguage("en");
    expect(render(PlanCard, planProps)).toContain("Semantic plagiarism detection");
  });

  it("offers a VI/EN switch with the active language marked", () => {
    setLanguage("vi");
    const html = render(LanguageSwitcher);
    expect(html).toContain('aria-label="Ngôn ngữ"');
    expect(html).toMatch(/aria-pressed="true"[^>]*>VI</);
  });
});
