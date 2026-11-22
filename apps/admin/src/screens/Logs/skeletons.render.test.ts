// Server-side render tests for Logs tab shimmer loading skeletons (no DOM).
import { createElement, type ComponentType } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { setLanguage } from "../../lib/i18n";
import AdminActionsPage from "./AdminActions";
import LiveLogPage from "./LiveLog";
import LogFilesPage from "./LogFiles";
import ServerPage from "./Server";
import {
  AdminActionsMoreSkeleton,
  AdminActionsSkeleton,
  LiveLogMetaSkeleton,
  LiveLogRowsSkeleton,
  LogFileLinesSkeleton,
  LogFileListSkeleton,
  ServerStatusSkeleton,
} from "./Skeletons";

const renderPage = (Page: ComponentType) =>
  renderToString(createElement(MemoryRouter, null, createElement(Page)));

afterEach(() => setLanguage("en"));

describe("Logs loading skeletons", () => {
  it("renders initial loading skeletons instead of empty states across all Logs tabs", () => {
    setLanguage("en");

    const liveHtml = renderPage(LiveLogPage);
    expect(liveHtml).toContain('role="status"');
    expect(liveHtml).toContain('aria-busy="true"');
    expect(liveHtml).toContain("animate-shimmer");
    expect(liveHtml).toContain("shimmer-bg-dark");
    expect(liveHtml).toContain("Loading…");
    expect(liveHtml).not.toContain("Waiting for the API to log something…");

    const filesHtml = renderPage(LogFilesPage);
    expect(filesHtml).toContain('role="status"');
    expect(filesHtml).toContain('aria-busy="true"');
    expect(filesHtml).toContain("animate-shimmer");
    expect(filesHtml).toContain("shimmer-bg-dark");
    expect(filesHtml).toContain("shimmer-bg");
    expect(filesHtml).not.toContain("The file is empty.");

    const serverHtml = renderPage(ServerPage);
    expect(serverHtml).toContain('role="status"');
    expect(serverHtml).toContain('aria-busy="true"');
    expect(serverHtml).toContain("animate-shimmer");
    expect(serverHtml).toContain("shimmer-bg");

    const actionsHtml = renderPage(AdminActionsPage);
    expect(actionsHtml).toContain('role="status"');
    expect(actionsHtml).toContain('aria-busy="true"');
    expect(actionsHtml).toContain("animate-shimmer");
    expect(actionsHtml).toContain("shimmer-bg");
    expect(actionsHtml).not.toContain("No admin actions recorded yet.");
  });

  it("uses dark-surface shimmer on console skeletons and light-surface shimmer on card/list skeletons", () => {
    const darkRows = renderToString(createElement(LiveLogRowsSkeleton));
    expect(darkRows).toContain("shimmer-bg-dark");
    expect(darkRows).toContain("animate-shimmer");
    expect(darkRows).not.toMatch(/\bshimmer-bg(?!-dark)\b/);

    const darkLines = renderToString(createElement(LogFileLinesSkeleton));
    expect(darkLines).toContain("shimmer-bg-dark");
    expect(darkLines).toContain("animate-shimmer");
    expect(darkLines).not.toMatch(/\bshimmer-bg(?!-dark)\b/);

    for (const SkeletonComp of [
      LiveLogMetaSkeleton,
      LogFileListSkeleton,
      ServerStatusSkeleton,
      AdminActionsSkeleton,
      AdminActionsMoreSkeleton,
    ]) {
      const html = renderToString(createElement(SkeletonComp));
      expect(html).toContain("shimmer-bg");
      expect(html).toContain("animate-shimmer");
      expect(html).not.toContain("shimmer-bg-dark");
    }
  });

  it("localizes screen-reader loading text to Vietnamese", () => {
    setLanguage("vi");
    for (const Page of [LiveLogPage, LogFilesPage, ServerPage, AdminActionsPage]) {
      const html = renderPage(Page);
      expect(html).toContain("Đang tải…");
    }
  });
});
