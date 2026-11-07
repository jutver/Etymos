// Keeps <head> right while the app runs: the built HTML only has the tags for
// the page that was first loaded, so moving to another screen (or switching
// language) has to update the title, description, canonical and preview tags.
// Screens that aren't public get noindex so a crawler that renders them
// (an old link, a guessed URL) doesn't index a login wall or an empty app.
import { OG_IMAGE, SITE_NAME, SITE_URL, canonicalUrl, findPublicPage } from "./pages.ts";

type Language = "en" | "vi";

function setMeta(attr: "name" | "property", key: string, content: string | null) {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (content === null) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.content = content;
}

function setCanonical(href: string | null) {
  let el = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (href === null) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement("link");
    el.rel = "canonical";
    document.head.appendChild(el);
  }
  el.href = href;
}

export interface AppliedMeta {
  title: string;
  indexable: boolean;
}

export function applyPageMeta(pathname: string, language: Language): AppliedMeta {
  const page = findPublicPage(pathname);
  if (!page) {
    document.title = SITE_NAME;
    setMeta("name", "robots", "noindex, nofollow");
    setCanonical(null);
    return { title: SITE_NAME, indexable: false };
  }
  const { title, description } = page[language];
  const url = canonicalUrl(page.path);
  document.title = title;
  setMeta("name", "robots", null);
  setMeta("name", "description", description);
  setCanonical(url);
  setMeta("property", "og:url", url);
  setMeta("property", "og:title", title);
  setMeta("property", "og:description", description);
  setMeta("property", "og:image", `${SITE_URL}${OG_IMAGE}`);
  setMeta("name", "twitter:title", title);
  setMeta("name", "twitter:description", description);
  return { title, indexable: true };
}
