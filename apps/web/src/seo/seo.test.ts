import { describe, expect, it } from "vitest";
import indexHtml from "../../index.html?raw";
import vercelJson from "../../vercel.json";
import { POLICIES } from "../components/legal/policies";
import { PRIVATE_PREFIXES, PUBLIC_PAGES, SITE_URL, canonicalUrl, findPublicPage } from "./pages";
import { headTags, pageFile, robotsTxt, sitemapXml, withPageHead } from "./build";

const appSource = Object.values(
  import.meta.glob("../App.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>,
)[0];

describe("public page list", () => {
  it("includes every legal page", () => {
    for (const policy of POLICIES) expect(findPublicPage(policy.path), policy.path).toBeDefined();
  });

  it("only lists paths App routes to", () => {
    for (const page of PUBLIC_PAGES) {
      if (POLICIES.some((p) => p.path === page.path)) continue;
      expect(appSource, page.path).toContain(`path="${page.path}"`);
    }
  });

  it("never lists a private screen", () => {
    for (const page of PUBLIC_PAGES) {
      expect(PRIVATE_PREFIXES.some((p) => page.path === p || page.path.startsWith(`${p}/`)), page.path).toBe(false);
    }
  });

  it("keeps titles and descriptions short enough for a search result", () => {
    for (const page of PUBLIC_PAGES) {
      for (const lang of ["vi", "en"] as const) {
        expect(page[lang].title.length, `${page.path} ${lang} title`).toBeLessThanOrEqual(70);
        expect(page[lang].description.length, `${page.path} ${lang} description`).toBeLessThanOrEqual(200);
      }
    }
  });

  it("matches a path with or without a trailing slash", () => {
    expect(findPublicPage("/pricing/")?.path).toBe("/pricing");
    expect(findPublicPage("/")?.path).toBe("/");
    expect(findPublicPage("/upload")).toBeUndefined();
  });
});

describe("vercel.json", () => {
  const rewrites = vercelJson.rewrites as { source: string; destination: string }[];

  it("sends each public page to its own HTML file, before the app fallback", () => {
    const fallback = rewrites.findIndex((r) => r.source === "/(.*)");
    expect(fallback).toBe(rewrites.length - 1);
    for (const page of PUBLIC_PAGES) {
      if (page.path === "/") continue;
      const rule = rewrites.find((r) => r.source === page.path);
      expect(rule?.destination, page.path).toBe(`/${pageFile(page)}`);
    }
  });
});

describe("built head", () => {
  it("replaces index.html's SEO block with the page's tags", () => {
    const pricing = findPublicPage("/pricing")!;
    const html = withPageHead(indexHtml, pricing);
    expect(html).toContain(`<title>${pricing.vi.title}</title>`);
    expect(html).toContain(`<link rel="canonical" href="${SITE_URL}/pricing" />`);
    expect(html.match(/<title>/g)).toHaveLength(1);
    // Swapping again (home → pricing on the built file) leaves one block.
    const twice = withPageHead(withPageHead(indexHtml, PUBLIC_PAGES[0]), pricing);
    expect(twice).toBe(html);
  });

  it("puts structured data on the home page only", () => {
    expect(headTags(PUBLIC_PAGES[0])).toContain("application/ld+json");
    expect(headTags(findPublicPage("/pricing")!)).not.toContain("application/ld+json");
  });

  it("escapes quotes in attribute values", () => {
    const page = { ...PUBLIC_PAGES[1], vi: { title: 'A "quoted" <b>', description: "x & y" } };
    const tags = headTags(page);
    expect(tags).toContain("<title>A &quot;quoted&quot; &lt;b&gt;</title>");
    expect(tags).toContain('content="x &amp; y"');
  });
});

describe("sitemap and robots", () => {
  it("lists every public page with its canonical URL", () => {
    const xml = sitemapXml("2026-11-07");
    for (const page of PUBLIC_PAGES) expect(xml).toContain(`<loc>${canonicalUrl(page.path)}</loc>`);
    expect(xml).toContain("<lastmod>2026-11-07</lastmod>");
  });

  it("blocks the private screens and points at the sitemap", () => {
    const robots = robotsTxt();
    expect(robots).toContain("Disallow: /upload");
    expect(robots).toContain("Disallow: /account");
    expect(robots).not.toContain("Disallow: /pricing");
    expect(robots).toContain(`Sitemap: ${SITE_URL}/sitemap.xml`);
  });
});
