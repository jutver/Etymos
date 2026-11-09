// One blog post. Unknown slugs go back to the blog index.
import { useRef } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { ArrowLeft, Info } from "@phosphor-icons/react";
import { CtaBand } from "../../components/marketing/Marketing";
import { t, useLanguage } from "../../lib/i18n";
import { useSmoothPage } from "../../lib/useSmoothPage";
import { POSTS, findPost } from "../../blog/posts";
import { ARTICLES, type ArticleBlock } from "../../blog/articles";
import { PostByline } from "./PostByline";

export default function BlogPostPage() {
  const { slug } = useParams();
  const lang = useLanguage();
  const root = useRef<HTMLDivElement>(null);
  useSmoothPage(root, { intro: ".mk-hero-intro", reveal: ".mk-reveal" });

  const post = findPost(slug);
  const article = slug ? ARTICLES[slug] : undefined;
  if (!post || !article) return <Navigate to="/blog" replace />;

  const text = post[lang];
  const others = POSTS.filter((p) => p.slug !== post.slug).slice(0, 2);

  return (
    <div ref={root} className="mk-page">
      <article>
        <header className="mk-hero mk-page-hero">
          <div className="mk-hero-intro relative mx-auto max-w-3xl px-5 pb-12 pt-12 sm:px-8 sm:pb-14 sm:pt-16">
            <Link to="/blog" className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-500 hover:text-navy-900">
              <ArrowLeft size={16} aria-hidden="true" />
              {t("All posts")}
            </Link>
            <p className="mt-8 text-xs font-semibold uppercase tracking-wide text-brand-600">{text.topic}</p>
            <h1 className="mt-3 text-3xl font-bold tracking-tight text-navy-900 sm:text-[2.6rem] sm:leading-[1.15]">{text.title}</h1>
            <p className="mt-4 text-body-lg text-ink-600">{text.description}</p>
            <div className="mt-6">
              <PostByline post={post} />
            </div>
          </div>
        </header>

        <div className="mx-auto max-w-3xl space-y-5 px-5 pb-20 pt-4 sm:px-8">
          {article[lang].map((block, i) => (
            <Block key={i} block={block} />
          ))}
        </div>
      </article>

      {others.length > 0 && (
        <section className="mk-tint border-y border-line">
          <div className="mx-auto max-w-3xl px-5 py-16 sm:px-8">
            <h2 className="text-lg font-bold tracking-tight text-navy-900">{t("Keep reading")}</h2>
            <ul className="mt-5 grid gap-4 sm:grid-cols-2">
              {others.map((p) => (
                <li key={p.slug}>
                  <Link to={`/blog/${p.slug}`} className="mk-card mk-card-hover block h-full p-5">
                    <span className="text-xs font-semibold uppercase tracking-wide text-brand-600">{p[lang].topic}</span>
                    <p className="mt-2 font-bold leading-snug text-navy-900">{p[lang].title}</p>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      <div className="pt-20">
        <CtaBand
          title={t("Check your own writing")}
          lead={t("Upload a document and see every match, with the reason it was flagged and how to fix it.")}
        />
      </div>
    </div>
  );
}

function Block({ block }: { block: ArticleBlock }) {
  switch (block.kind) {
    case "p":
      return <p className="text-[1.0625rem] leading-[1.8] text-ink-700">{block.text}</p>;
    case "h2":
      return <h2 className="pt-5 text-xl font-bold tracking-tight text-navy-900 sm:text-2xl">{block.text}</h2>;
    case "list":
      return (
        <ul className="list-disc space-y-2.5 pl-6 text-[1.0625rem] leading-[1.75] text-ink-700 marker:text-brand-400">
          {block.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      );
    case "note":
      return (
        <div className="mt-4 flex items-start gap-3 rounded-[var(--radius-card)] border border-brand-100 bg-brand-50 px-5 py-4 leading-relaxed text-ink-700">
          <Info size={20} weight="fill" className="mt-0.5 shrink-0 text-brand-600" aria-hidden="true" />
          <p>{block.text}</p>
        </div>
      );
  }
}
