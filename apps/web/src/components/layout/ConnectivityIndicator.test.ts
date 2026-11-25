import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LazyMotion, domAnimation } from "motion/react";
import { describe, expect, it } from "vitest";
import { ConnectivityIndicator } from "./ConnectivityIndicator";

function renderIndicator(props: Parameters<typeof ConnectivityIndicator>[0]) {
  return renderToStaticMarkup(
    createElement(
      LazyMotion,
      { features: domAnimation, strict: true },
      createElement(ConnectivityIndicator, props),
    ),
  );
}

describe("ConnectivityIndicator", () => {
  it("renders floating pill with SVG network & server symbols instead of a status dot", () => {
    const connectedHtml = renderIndicator({
      state: { isOnline: true, serverStatus: "connected" },
    });
    expect(connectedHtml.match(/<svg\b/g)?.length).toBe(2);
    expect(connectedHtml).not.toContain("size-2 rounded-full");
    expect(connectedHtml).toContain("Online");
    expect(connectedHtml).toContain("Server connected");

    const offlineHtml = renderIndicator({
      state: { isOnline: false, serverStatus: "offline" },
    });
    expect(offlineHtml.match(/<svg\b/g)?.length).toBe(2);
    expect(offlineHtml).toContain("Offline");
    expect(offlineHtml).toContain("Server offline");

    const reconnectingHtml = renderIndicator({
      state: { isOnline: true, serverStatus: "reconnecting" },
    });
    expect(reconnectingHtml.match(/<svg\b/g)?.length).toBe(2);
    expect(reconnectingHtml).toContain("Reconnecting…");
    expect(reconnectingHtml).toContain("animate-pulse");
  });

  it("renders minimized compact pill with icons + divider only and no popover by default", () => {
    const html = renderIndicator({
      variant: "compact",
      state: { isOnline: true, serverStatus: "connected" },
    });

    expect(html).toContain('type="button"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="dialog"');
    expect(html).toContain("h-3 w-px bg-line");

    const buttonMatch = html.match(/<button\b[^>]*>([\s\S]*?)<\/button>/);
    expect(buttonMatch).not.toBeNull();
    const buttonInnerText = buttonMatch![1]!.replace(/<[^>]+>/g, "").trim();
    expect(buttonInnerText).toBe("");
    expect(buttonMatch![1]!.match(/<svg\b/g)?.length).toBe(2);
  });

  it("renders detailed connection status popover when compact pill is open", () => {
    const html = renderIndicator({
      variant: "compact",
      defaultOpen: true,
      state: { isOnline: true, serverStatus: "connected" },
    });

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain("Connection status");
    expect(html).toContain("Network");
    expect(html).toContain("Server");
    expect(html).toContain("Online");
    expect(html).toContain("Server connected");

    const offlineHtml = renderIndicator({
      variant: "compact",
      defaultOpen: true,
      state: { isOnline: false, serverStatus: "offline" },
    });
    expect(offlineHtml).toContain("Offline");
    expect(offlineHtml).toContain("Server offline");
  });
});
