// Blog index: every post, newest first. Posts are in code (blog/posts.ts).
import { useRef } from "react";
import { Link } from "react-router-dom";
import { ArrowRight } from "@phosphor-icons/react";
import { CtaBand, Highlight, PageHero } from "../../components/marketing/Marketing";
import { t, useLanguage } from "../../lib/i18n";
import { useSmoothPage } from "../../lib/useSmoothPage";
import { POSTS, type PostMeta } from "../../blog/posts";
import { PostByline } from "./PostByline";

export default function BlogPage() {
  const root = useRef<HTMLDivElement>(null);
  useSmoothPage(root, { intro: ".mk-hero-intro", reveal: ".mk-reveal" });
  const [latest, ...rest] = POSTS;

  return (
    <div ref={root} className="mk-page">
      <PageHero
        chip={t("Blog")}
        title={<>{t("Write better,")} <Highlight>{t("cite with confidence")}</Highlight></>}
        lead={t("Practical guides on plagiarism, paraphrasing and citing sources, for students and researchers writing in Vietnamese.")}
      />

      <section className="mx-auto max-w-6xl px-5 pb-20 pt-12 sm:px-8 sm:pt-16">
        {latest && <PostCard post={latest} featured />}
        {rest.length > 0 && (
          <div className="mt-5 grid gap-5 md:grid-cols-2">
            {rest.map((post) => (
              <PostCard key={post.slug} post={post} />
            ))}
          </div>
        )}
      </section>

      <CtaBand
        title={t("Check your own writing")}
        lead={t("Upload a document and see every match, with the reason it was flagged and how to fix it.")}
      />
    </div>
  );
}

function PostCard({ post, featured = false }: { post: PostMeta; featured?: boolean }) {
  const lang = useLanguage();
  const text = post[lang];
  return (
    <Link
      to={`/blog/${post.slug}`}
      className={
        featured
          ? "mk-reveal mk-card mk-card-hover group block p-8 sm:p-10"
          : "mk-reveal mk-card mk-card-hover group flex flex-col p-7"
      }
    >
      <span className="text-xs font-semibold uppercase tracking-wide text-brand-600">{text.topic}</span>
      <h2
        className={
          featured
            ? "mt-3 max-w-3xl text-2xl font-bold tracking-tight text-navy-900 sm:text-3xl"
            : "mt-3 text-xl font-bold tracking-tight text-navy-900"
        }
      >
        {text.title}
      </h2>
      <p className={featured ? "mt-3 max-w-2xl leading-relaxed text-ink-600" : "mt-2.5 flex-1 text-sm leading-relaxed text-ink-600"}>
        {text.description}
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <PostByline post={post} />
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand-600">
          {t("Read article")}
          <ArrowRight size={16} weight="bold" aria-hidden="true" className="transition-transform group-hover:translate-x-0.5" />
        </span>
      </div>
    </Link>
  );
}
