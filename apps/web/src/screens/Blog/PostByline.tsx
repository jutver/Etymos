import { currentLocale, t, useLanguage } from "../../lib/i18n";
import type { PostMeta } from "../../blog/posts";

/** "9 November 2026 · 6 min read" */
export function PostByline({ post }: { post: PostMeta }) {
  useLanguage();
  // Noon UTC so the day doesn't shift in any time zone.
  const date = new Date(`${post.date}T12:00:00Z`).toLocaleDateString(currentLocale(), {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  return (
    <p className="text-sm text-ink-500">
      <time dateTime={post.date}>{date}</time>
      <span aria-hidden="true"> · </span>
      {t("{{minutes}} min read", { minutes: post.readMinutes })}
    </p>
  );
}
