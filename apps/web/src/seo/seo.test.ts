import { describe, expect, it } from "vitest";
import indexHtml from "../../index.html?raw";
import vercelJson from "../../vercel.json";
import { POLICIES } from "../components/legal/policies";
import { PRIVATE_PREFIXES, PUBLIC_PAGES, SITE_URL, canonicalUrl, findPublicPage } from "./pages";
import { APP_SHELL, headTags, pageFile, robotsTxt, sitemapXml, withPageHead } from "./build";
import { pageBody, withRootContent } from "./prerender";
import { POSTS } from "../blog/posts";
import { ARTICLES } from "../blog/articles";

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
      if (page.path.startsWith("/blog/")) {
        expect(appSource).toContain('path="/blog/:slug"');
        continue;
      }
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

  it("sends each public page to its own HTML file", () => {
    for (const page of PUBLIC_PAGES) {
      if (page.path === "/") continue;
      const rule = rewrites.find((r) => r.source === page.path);
      expect(rule?.destination, page.path).toBe(`/${pageFile(page)}`);
    }
  });

  it("has no catch-all, so unknown paths get a real 404", () => {
    expect(rewrites.some((r) => r.source.includes("(.*)") || r.source === "/:path*")).toBe(false);
  });

  it("sends every other route App knows to the app shell (else a reload there would 404)", () => {
    const paths = [...appSource.matchAll(/<Route path="([^"]+)"/g)].map((m) => m[1]);
    for (const path of paths) {
      if (path === "*" || path === "/" || path === "/blog/:slug") continue;
      if (findPublicPage(path)) continue;
      expect(rewrites.find((r) => r.source === path)?.destination, path).toBe(`/${APP_SHELL}`);
    }
  });
});

describe("page text in the HTML", () => {
  it("puts a blog post's full text, in Vietnamese, inside #root", () => {
    const post = POSTS[0];
    const html = withRootContent(indexHtml, pageBody(findPublicPage(`/blog/${post.slug}`)!));
    expect(html).toContain(`<h1 class="mt-2 text-3xl font-bold text-navy-900">${post.vi.title}</h1>`);
    const firstParagraph = ARTICLES[post.slug].vi.find((b) => b.kind === "p")!;
    expect(html).toContain(firstParagraph.kind === "p" ? firstParagraph.text.slice(0, 40) : "");
  });

  it("links every page to every public page", () => {
    const body = pageBody(findPublicPage("/pricing")!);
    for (const page of PUBLIC_PAGES) if (!page.article) expect(body, page.path).toContain(`href="${page.path}"`);
  });

  it("lists every post on the blog index", () => {
    const body = pageBody(findPublicPage("/blog")!);
    for (const post of POSTS) expect(body).toContain(`href="/blog/${post.slug}"`);
  });

  it("escapes text", () => {
    const page = { ...findPublicPage("/pricing")!, vi: { title: "A <b> & c — Etymos", description: "x" } };
    expect(pageBody(page)).toContain("A &lt;b&gt; &amp; c");
  });
});

describe("blog posts", () => {
  it("are articles with their real date", () => {
    const post = POSTS[0];
    const page = findPublicPage(`/blog/${post.slug}`)!;
    const tags = headTags(page);
    expect(tags).toContain('<meta property="og:type" content="article" />');
    expect(tags).toContain('"@type":"BlogPosting"');
    expect(tags).toContain(`"datePublished":"${post.date}"`);
    expect(sitemapXml("2030-01-01")).toContain(`<loc>${canonicalUrl(page.path)}</loc>\n    <lastmod>${post.date}</lastmod>`);
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
