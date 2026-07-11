import { motion } from "motion/react";
import {
  ArrowRight,
  Brain,
  GraduationCap,
  Lightbulb,
  LinkSimple,
  MagicWand,
  Quotes,
  Translate,
  UploadSimple,
  Sparkle,
} from "@phosphor-icons/react";
import { Button } from "../../components/ui/Button";
import { HeroPreview } from "./HeroPreview";
import { COMPETITORS } from "../../lib/mockData";
import { cn } from "../../lib/cn";

const reveal = {
  initial: { opacity: 0, y: 28 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, amount: 0.25 },
  transition: { duration: 0.6, ease: [0.16, 1, 0.3, 1] as const },
};

const features = [
  {
    icon: Lightbulb,
    title: "Explainable AI",
    body: "Know exactly why a passage is flagged, in plain language, not just a percentage.",
    large: true,
    tint: "brand" as const,
    image: "/assets/image/CoreUI.png",
  },
  {
    icon: Brain,
    title: "Semantic detection",
    body: "Catches reworded and paraphrased copying that keyword tools miss.",
  },
  {
    icon: MagicWand,
    title: "AI Rewrite Assistant",
    body: "Turn a flagged passage into an original one, academic tone, one click.",
  },
  {
    icon: LinkSimple,
    title: "Matched-source suggestions",
    body: "See the exact page or paper your passage overlaps with.",
  },
];

const steps = [
  {
    title: "Upload your document",
    body: "Drag in a PDF, DOC, or paste your text directly. Choose Vietnamese, English, or another language.",
  },
  {
    title: "We scan everything",
    body: "Web pages, academic papers, and semantic rewrites, checked in parallel.",
  },
  {
    title: "Review, understand, rewrite",
    body: "See your similarity score, read plain-language explanations, and fix flagged passages in one click.",
  },
];

const testimonials = [
  {
    quote:
      "Explainable AI told me exactly which sentences to rewrite, not just a red percentage. I fixed my thesis chapter in one afternoon.",
    name: "User A",
    role: "Instiution A",
    featured: true,
  },
  {
    quote: "First tool I've used that catches paraphrased Vietnamese, not just copy-paste.",
    name: "User B",
    role: "Instiution B",
  },
  {
    quote:
      "My students submit through Etymos before Turnitin ever sees it. A tenth of the cost, and it catches more.",
    name: "User C",
    role: "Instiution C",
  },
];

export default function LandingPage() {
  return (
    <div>
      {/* Hero — asymmetric split */}
      <section className="mx-auto grid max-w-7xl items-center gap-12 px-5 pb-16 pt-16 sm:px-8 lg:grid-cols-[1.05fr_0.95fr] lg:gap-8 lg:pt-20">
        <div>
          <motion.h1
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
            className="text-display font-extrabold tracking-tight text-navy-900"
          >
            The plagiarism checker that actually reads Vietnamese.
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
            className="mt-5 max-w-lg text-body-lg text-ink-700"
          >
            Traditional and semantic detection, explainable AI, and one-click academic
            rewriting, at a tenth of Turnitin's price.
          </motion.p>
          <motion.div
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="mt-8 flex flex-wrap items-center gap-3"
          >
            <Button as="link" to="/signup" size="lg" iconRight={<ArrowRight size={18} weight="bold" />}>
              Get Started
            </Button>
            <Button as="link" to="/pricing" size="lg" variant="outline">
              See pricing
            </Button>
          </motion.div>
        </div>

        <div className="flex justify-center lg:justify-end">
          <HeroPreview />
        </div>
      </section>

      {/* Stats band — full-width navy */}
      <section className="bg-navy-900 py-12">
        <div className="mx-auto grid max-w-7xl grid-cols-1 gap-8 px-5 sm:grid-cols-3 sm:px-8">
          {[
            { stat: "8x cheaper", body: "than English-only tools like Grammarly Premium" },
            { stat: "Vietnamese-first", body: "Semantic detection tuned for Vietnamese academic writing" },
            { stat: "~3 minutes", body: "Average time from upload to full report" },
          ].map((s) => (
            <div key={s.stat}>
              <p className="brand-gradient-text text-3xl font-extrabold tracking-tight">{s.stat}</p>
              <p className="mt-1.5 text-sm text-white/60">{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Features — bento */}
      <section id="features" className="mx-auto max-w-7xl px-5 py-24 sm:px-8">
        <motion.p
          {...reveal}
          className="text-[0.6875rem] font-bold uppercase tracking-[0.14em] text-brand-600"
        >
          Core capabilities
        </motion.p>
        <motion.h2
          {...reveal}
          className="mt-3 max-w-xl text-h1 font-bold tracking-tight text-navy-900"
        >
          Everything a real plagiarism check needs
        </motion.h2>

        <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 lg:grid-rows-2">
          {features.map((f, i) => (
            <motion.div
              key={f.title}
              {...reveal}
              transition={{ ...reveal.transition, delay: i * 0.05 }}
              className={cn(
                "relative flex flex-col justify-between overflow-hidden rounded-[var(--radius-card-lg)] border p-6",
                f.large && "lg:col-span-2 lg:row-span-2",
                f.tint === "brand" && !f.image && "border-brand-300/50 bg-gradient-to-br from-brand-100 to-white",
                f.image && "border-brand-300/50",
                !f.tint && "border-line bg-white",
              )}
            >
              {f.image && (
                <>
                  <img
                    src={f.image}
                    alt=""
                    className="absolute inset-0 h-full w-full object-cover object-top"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-navy-900/90 via-navy-900/30 to-navy-900/10" />
                </>
              )}
              <div
                className={cn(
                  "relative z-10 flex size-11 items-center justify-center rounded-xl",
                  f.image
                    ? "brand-gradient text-white"
                    : f.tint === "brand"
                      ? "brand-gradient text-white"
                      : "bg-surface-muted text-brand-600",
                )}
              >
                <f.icon size={22} weight="bold" />
              </div>
              <div className="relative z-10 mt-6">
                <h3 className={cn("text-lg font-bold", f.image ? "text-white" : "text-navy-900")}>
                  {f.title}
                </h3>
                <p className={cn("mt-2 text-sm leading-relaxed", f.image ? "text-white/85" : "text-ink-600")}>
                  {f.body}
                </p>
              </div>
            </motion.div>
          ))}

          <motion.div
            {...reveal}
            className="flex flex-col justify-between rounded-[var(--radius-card-lg)] border border-line bg-white p-6"
          >
            <div className="flex size-11 items-center justify-center rounded-xl bg-surface-muted text-brand-600">
              <Translate size={22} weight="bold" />
            </div>
            <div className="mt-6">
              <h3 className="text-lg font-bold text-navy-900">Vietnamese & English checking</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-600">
                Deep, accurate detection in Vietnamese and English, not a shallow multi-language add-on.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {["Tiếng Việt", "English"].map((lang) => (
                  <span
                    key={lang}
                    className="rounded-full border border-line bg-surface-tint px-3 py-1.5 text-xs font-semibold text-ink-700"
                  >
                    {lang}
                  </span>
                ))}
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="bg-surface-tint py-24">
        <div className="mx-auto max-w-7xl px-5 sm:px-8">
          <motion.h2 {...reveal} className="max-w-lg text-h1 font-bold tracking-tight text-navy-900">
            How it works
          </motion.h2>

          <div className="relative mt-14 grid grid-cols-1 gap-10 md:grid-cols-3 md:gap-8">
            <div className="pointer-events-none absolute top-6 hidden h-px w-full bg-line md:block" />
            {steps.map((s, i) => (
              <motion.div
                key={s.title}
                {...reveal}
                transition={{ ...reveal.transition, delay: i * 0.1 }}
                className="relative"
              >
                <div className="relative z-10 flex size-12 items-center justify-center rounded-full brand-gradient text-lg font-bold text-white shadow-[0_8px_20px_-6px_rgba(30,79,196,0.5)]">
                  {i + 1}
                </div>
                <h3 className="mt-5 text-lg font-bold text-navy-900">{s.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-600">{s.body}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Explainable AI spotlight — split */}
      <section className="mx-auto max-w-7xl px-5 py-24 sm:px-8">
        <div className="grid items-center gap-14 lg:grid-cols-2">
          <motion.div {...reveal}>
            <h2 className="text-h1 font-bold leading-tight tracking-tight text-navy-900">
              Not just a percentage. A reason.
            </h2>
            <p className="mt-4 max-w-md text-body-lg leading-relaxed text-ink-600">
              Every flagged passage comes with a plain-language explanation of why it counts as
              plagiarism, so you know exactly what to fix, and why, before you resubmit.
            </p>
            <Button as="link" to="/upload" variant="secondary" size="lg" className="mt-7">
              See a real report
            </Button>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true, amount: 0.4 }}
            transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
            className="rounded-[var(--radius-card-lg)] border border-line bg-white p-6 shadow-[var(--shadow-card)]"
          >
            <div className="flex items-center gap-2 rounded-full bg-severity-moderate-bg px-3 py-1.5 text-xs font-semibold text-severity-moderate w-fit">
              <span className="size-1.5 rounded-full bg-severity-moderate" />
              Moderate match, 61%
            </div>
            <div className="mt-4 flex items-center gap-2 text-xs font-medium text-ink-500">
              <GraduationCap size={14} /> Tạp chí Khoa học Thủy lợi, 2021
            </div>
            <div className="mt-4 rounded-lg bg-brand-100/50 p-4">
              <p className="text-[0.6875rem] font-bold uppercase tracking-wide text-brand-600">
                Why this is flagged
              </p>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-700">
                The wording changed, but the argument, evidence, and cause-and-effect order match
                the source exactly. This reads as paraphrase, not analysis in your own voice.
              </p>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Competitor comparison — responsive grid */}
      <section className="bg-navy-900 py-24">
        <div className="mx-auto max-w-7xl px-5 sm:px-8">
          <motion.h2 {...reveal} className="max-w-lg text-h1 font-bold tracking-tight text-white">
            Built for a market the big players ignore
          </motion.h2>
          <motion.p {...reveal} className="mt-3 max-w-md text-body-lg text-white/60">
            Individual-friendly pricing, without cutting Vietnamese-language accuracy.
          </motion.p>

          <div className="mt-10 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {COMPETITORS.map((c) => (
              <div
                key={c.name}
                className={cn(
                  "rounded-[var(--radius-card-lg)] border p-6",
                  c.highlight
                    ? "border-brand-400 bg-white shadow-[0_16px_40px_-12px_rgba(30,79,196,0.5)]"
                    : "border-white/10 bg-white/[0.04]",
                )}
              >
                <div className="flex min-h-14 items-start gap-2">
                  <p className={cn("text-lg font-bold", c.highlight ? "text-navy-900" : "text-white")}>
                    {c.name}
                  </p>
                  {c.highlight && <Sparkle size={16} weight="fill" className="mt-1 shrink-0 text-brand-500" />}
                </div>
                <p
                  className={cn(
                    "mt-1 min-h-10 text-sm font-semibold",
                    c.highlight ? "text-brand-600" : "text-white/70",
                  )}
                >
                  {c.price}
                </p>
                <p className={cn("mt-3 text-xs", c.highlight ? "text-ink-500" : "text-white/40")}>
                  {c.audience}
                </p>
                <p className={cn("mt-3 text-sm leading-relaxed", c.highlight ? "text-ink-700" : "text-white/55")}>
                  {c.limitation}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Testimonials — asymmetric */}
      <section className="mx-auto max-w-7xl px-5 py-24 sm:px-8">
        <motion.h2 {...reveal} className="text-h1 font-bold tracking-tight text-navy-900">
          Trusted by students and researchers
        </motion.h2>

        <div className="mt-10 grid grid-cols-1 gap-5 lg:grid-cols-3">
          {testimonials.map((t, i) => (
            <motion.div
              key={t.name}
              {...reveal}
              transition={{ ...reveal.transition, delay: i * 0.08 }}
              className={cn(
                "flex flex-col justify-between rounded-[var(--radius-card-lg)] border border-line bg-white p-7",
                t.featured && "lg:row-span-2 lg:p-8",
              )}
            >
              <div>
                <Quotes size={28} weight="fill" className="text-brand-300" />
                <p
                  className={cn(
                    "mt-4 leading-relaxed text-ink-700",
                    t.featured ? "text-lg" : "text-sm",
                  )}
                >
                  "{t.quote}"
                </p>
              </div>
              <div className="mt-6">
                <p className="text-sm font-bold text-navy-900">{t.name}</p>
                <p className="text-xs text-ink-500">{t.role}</p>
              </div>
            </motion.div>
          ))}
        </div>
      </section>

      {/* Closing CTA band */}
      <section className="brand-gradient">
        <div className="mx-auto max-w-3xl px-5 py-24 text-center sm:px-8">
          <motion.h2 {...reveal} className="text-h1 font-bold tracking-tight text-white">
            Check your first paper today.
          </motion.h2>
          <motion.p {...reveal} className="mx-auto mt-3 max-w-md text-body-lg text-white/85">
            Three free checks a month, no card required.
          </motion.p>
          <motion.div {...reveal} className="mt-8">
            <Button
              as="link"
              to="/signup"
              variant="ghost"
              size="lg"
              className="!bg-white !text-brand-600 shadow-[0_12px_28px_-8px_rgba(15,27,61,0.35)] hover:!bg-white/90"
              iconLeft={<UploadSimple size={18} weight="bold" />}
            >
              Get Started
            </Button>
          </motion.div>
        </div>
      </section>
    </div>
  );
}
