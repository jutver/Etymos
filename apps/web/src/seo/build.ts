// Build-time SEO output, from the list in ./pages.ts: the <head> tags for each
// public page, sitemap.xml and robots.txt. vite.config.ts calls these; they are
// plain functions so seo.test.ts can check them.
import {
  OG_IMAGE,
  OG_IMAGE_HEIGHT,
  OG_IMAGE_WIDTH,
  PRIVATE_PREFIXES,
  PUBLIC_PAGES,
  SITE_NAME,
  SITE_URL,
  canonicalUrl,
  type PublicPage,
} from "./pages.ts";

/** index.html marks the tags this file owns with these two comments. */
export const SEO_START = "<!-- seo:start -->";
export const SEO_END = "<!-- seo:end -->";

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Structured data for the home page: what Etymos is, for Google's rich results. */
function structuredData(page: PublicPage): string {
  const data = [
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: SITE_NAME,
      url: `${SITE_URL}/`,
      inLanguage: "vi",
    },
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: SITE_NAME,
      url: `${SITE_URL}/`,
      logo: `${SITE_URL}/assets/logo/etymos-mark-email.png`,
      email: "support@etymos.site",
    },
    {
      "@context": "https://schema.org",
      "@type": "WebApplication",
      name: SITE_NAME,
      url: `${SITE_URL}/`,
      description: page.vi.description,
      applicationCategory: "EducationalApplication",
      operatingSystem: "Web",
      inLanguage: ["vi", "en"],
    },
  ];
  // "<" can't appear raw inside a <script>; none of the values carry it, but be safe.
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;
}

/** The tags between SEO_START and SEO_END for one page. */
export function headTags(page: PublicPage): string {
  const url = canonicalUrl(page.path);
  const { title, description } = page.vi;
  const image = `${SITE_URL}${OG_IMAGE}`;
  const lines = [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(description)}" />`,
    `<link rel="canonical" href="${url}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    `<meta property="og:locale" content="vi_VN" />`,
    `<meta property="og:locale:alternate" content="en_US" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:title" content="${esc(title)}" />`,
    `<meta property="og:description" content="${esc(description)}" />`,
    `<meta property="og:image" content="${image}" />`,
    `<meta property="og:image:width" content="${OG_IMAGE_WIDTH}" />`,
    `<meta property="og:image:height" content="${OG_IMAGE_HEIGHT}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(title)}" />`,
    `<meta name="twitter:description" content="${esc(description)}" />`,
    `<meta name="twitter:image" content="${image}" />`,
  ];
  if (page.path === "/") lines.push(structuredData(page));
  return lines.map((l) => `    ${l}`).join("\n");
}

/** index.html with its SEO block swapped for `page`'s. */
export function withPageHead(html: string, page: PublicPage): string {
  const start = html.indexOf(SEO_START);
  const end = html.indexOf(SEO_END);
  if (start < 0 || end < start) throw new Error(`index.html is missing the ${SEO_START} … ${SEO_END} block`);
  return `${html.slice(0, start + SEO_START.length)}\n${headTags(page)}\n    ${html.slice(end)}`;
}

/** Where the copy of index.html for `page` goes inside dist/. */
export function pageFile(page: PublicPage): string {
  return page.path === "/" ? "index.html" : `${page.path.slice(1)}/index.html`;
}

export function sitemapXml(lastmod: string): string {
  const urls = PUBLIC_PAGES.map(
    (p) =>
      `  <url>\n    <loc>${canonicalUrl(p.path)}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>${p.changefreq}</changefreq>\n    <priority>${p.priority.toFixed(1)}</priority>\n  </url>`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

export function robotsTxt(): string {
  const disallow = PRIVATE_PREFIXES.map((p) => `Disallow: ${p}`);
  return ["User-agent: *", "Allow: /", ...disallow, "", `Sitemap: ${SITE_URL}/sitemap.xml`, ""].join("\n");
}
