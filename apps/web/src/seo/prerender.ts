// Build-time page text for search engines and link previews that don't run
// JavaScript (Cốc Cốc, Bing's first pass, Zalo/Facebook): each public page's
// HTML file gets real content inside <div id="root">, in Vietnamese. React
// replaces it as soon as the app starts (createRoot clears the element), so
// visitors see it only while the app downloads.
//
// Blog posts carry their full text; other pages carry their heading and
// summary. Every page links to every public page so crawlers can find them all.
//
// Only vite.config.ts (and tests) import this, so the article text never
// lands in the app's own bundle twice.
import { PUBLIC_PAGES, type PublicPage } from "./pages.ts";
import { POSTS, findPost } from "../blog/posts.ts";
import { ARTICLES, type ArticleBlock } from "../blog/articles.ts";

const ROOT = '<div id="root"></div>';

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** "Bảng giá — Etymos" → "Bảng giá". The home title keeps its full text. */
function heading(page: PublicPage): string {
  return page.path === "/" ? page.vi.title : page.vi.title.replace(/ — Etymos$/, "");
}

function vnDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} tháng ${m}, ${y}`;
}

function block(b: ArticleBlock): string {
  switch (b.kind) {
    case "p":
      return `<p class="mt-5 leading-[1.8] text-ink-700">${esc(b.text)}</p>`;
    case "h2":
      return `<h2 class="mt-10 text-xl font-bold text-navy-900">${esc(b.text)}</h2>`;
    case "list":
      return `<ul class="mt-5 list-disc space-y-2 pl-6 text-ink-700">${b.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
    case "note":
      return `<p class="mt-6 rounded-lg border border-brand-100 bg-brand-50 px-5 py-4 text-ink-700">${esc(b.text)}</p>`;
  }
}

function postBody(slug: string): string | null {
  const post = findPost(slug);
  const article = ARTICLES[slug];
  if (!post || !article) return null;
  return [
    `<article>`,
    `<p class="text-sm"><a href="/blog" class="text-brand-600">← Tất cả bài viết</a></p>`,
    `<p class="mt-6 text-xs font-semibold uppercase tracking-wide text-brand-600">${esc(post.vi.topic)}</p>`,
    `<h1 class="mt-2 text-3xl font-bold text-navy-900">${esc(post.vi.title)}</h1>`,
    `<p class="mt-3 text-sm text-ink-500"><time datetime="${post.date}">${vnDate(post.date)}</time> · ${post.readMinutes} phút đọc</p>`,
    ...article.vi.map(block),
    `</article>`,
  ].join("\n");
}

function blogIndexBody(page: PublicPage): string {
  const items = POSTS.map(
    (p) =>
      `<li class="mt-6"><a href="/blog/${p.slug}" class="text-lg font-bold text-navy-900">${esc(p.vi.title)}</a>` +
      `<p class="mt-1 text-ink-600">${esc(p.vi.description)}</p>` +
      `<p class="mt-1 text-sm text-ink-500"><time datetime="${p.date}">${vnDate(p.date)}</time> · ${p.readMinutes} phút đọc</p></li>`,
  );
  return [
    `<h1 class="text-3xl font-bold text-navy-900">${esc(heading(page))}</h1>`,
    `<p class="mt-3 text-ink-600">${esc(page.vi.description)}</p>`,
    `<ul>${items.join("")}</ul>`,
  ].join("\n");
}

function summaryBody(page: PublicPage): string {
  return [
    `<h1 class="text-3xl font-bold text-navy-900">${esc(heading(page))}</h1>`,
    `<p class="mt-4 leading-relaxed text-ink-600">${esc(page.vi.description)}</p>`,
  ].join("\n");
}

function siteLinks(): string {
  const links = PUBLIC_PAGES.filter((p) => !p.article).map(
    (p) => `<li><a href="${p.path}" class="text-ink-600">${esc(p.path === "/" ? "Trang chủ" : heading(p))}</a></li>`,
  );
  return `<nav aria-label="Etymos" class="mt-16 border-t border-line pt-6"><ul class="flex flex-wrap gap-x-5 gap-y-2 text-sm">${links.join("")}</ul></nav>`;
}

/** What goes inside #root for `page`. */
export function pageBody(page: PublicPage): string {
  const slug = page.path.startsWith("/blog/") ? page.path.slice("/blog/".length) : null;
  const main = (slug && postBody(slug)) || (page.path === "/blog" ? blogIndexBody(page) : summaryBody(page));
  return [
    `<div class="mx-auto max-w-3xl px-5 py-12">`,
    `<p><a href="/" class="text-xl font-bold text-navy-900">Etymos</a></p>`,
    `<main class="mt-10">${main}</main>`,
    siteLinks(),
    `</div>`,
  ].join("\n");
}

/** The body of the 404 page. */
export function notFoundBody(): string {
  return [
    `<div class="mx-auto max-w-3xl px-5 py-12">`,
    `<p><a href="/" class="text-xl font-bold text-navy-900">Etymos</a></p>`,
    `<main class="mt-10"><h1 class="text-3xl font-bold text-navy-900">Không tìm thấy trang</h1>`,
    `<p class="mt-4 text-ink-600">Trang bạn tìm không tồn tại hoặc đã được chuyển đi.</p></main>`,
    siteLinks(),
    `</div>`,
  ].join("\n");
}

/** `html` with `body` placed inside the empty #root. */
export function withRootContent(html: string, body: string): string {
  if (!html.includes(ROOT)) throw new Error(`index.html is missing ${ROOT}`);
  return html.replace(ROOT, `<div id="root">\n${body}\n</div>`);
}
