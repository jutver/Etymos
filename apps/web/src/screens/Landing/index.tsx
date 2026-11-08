// Home: what Etymos is, in the order a visitor asks. What does it do (hero),
// what does it take (formats), what's in it (features), what does it look like
// (tour), how does it work (steps), why not something else (pain → answer,
// comparison), what does it cost (plans), then a last nudge.
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  ArrowDown,
  BookOpen,
  CheckCircle,
  Clock,
  FilePdf,
  FileDoc,
  Lightbulb,
  LinkSimple,
  MagnifyingGlass,
  PencilLine,
  QrCode,
  Robot,
  ShieldCheck,
  LockKey,
  TextAa,
  Translate,
  X,
  ClockCounterClockwise,
  Sparkle,
} from "@phosphor-icons/react";
import type { PlanDefinition } from "@etymos/shared";
import { Button } from "../../components/ui/Button";
import SpecularButton from "../../components/ui/SpecularButton";
import { cn } from "@etymos/shared";
import { PlanCard, PLAN_GRID_CLASS } from "../../components/PlanCard";
import { SimilarityBadge, SeverityTag } from "../../components/Severity";
import { ShaderBackground } from "../../components/marketing/ShaderBackground";
import { Chip, CtaBand, Highlight, SectionHeader, WindowFrame } from "../../components/marketing/Marketing";
import { COMPETITORS } from "../../lib/mockData";
import { cachedPricingData, loadPricingData } from "../../lib/pricingData";
import { t, tr } from "../../lib/i18n";
import { useSmoothPage, useStaggerIn } from "../../lib/useSmoothPage";
import { ProductTour } from "./ProductTour";

const INPUTS = [
  { icon: FilePdf, title: tr("PDF"), body: tr("Theses, papers, reports") },
  { icon: FileDoc, title: tr("Word (.docx)"), body: tr("Straight from your draft") },
  { icon: TextAa, title: tr("Pasted text"), body: tr("A paragraph or a chapter") },
  { icon: Translate, title: tr("2 languages"), body: tr("Vietnamese and English") },
];

const FACTS = [
  { value: tr("~3 min"), label: tr("from upload to a full report") },
  { value: tr("2 kinds"), label: tr("of detection: word-for-word and paraphrase") },
  { value: tr("8×"), label: tr("more affordable than English-only writing tools") },
  { value: tr("0₫"), label: tr("to start, no card required") },
];

const FEATURES = [
  {
    icon: MagnifyingGlass,
    title: tr("Semantic detection"),
    body: tr("Finds reworded and paraphrased copying that keyword checks miss, tuned for Vietnamese."),
    points: [tr("Catches paraphrase, not just copy-paste"), tr("Compares meaning, not only words")],
  },
  {
    icon: Lightbulb,
    title: tr("Explainable AI"),
    body: tr("Every flagged passage comes with a plain-language reason, so you know what to fix."),
    points: [tr("Why it matched, in one or two sentences"), tr("What to do about it")],
  },
  {
    icon: Robot,
    title: tr("AI-writing detection"),
    body: tr("Highlights sentences that read as machine-generated, with an overall score."),
    points: [tr("Sentence-by-sentence highlights"), tr("Shown next to your similarity score")],
  },
  {
    icon: LinkSimple,
    title: tr("Matched sources"),
    body: tr("See the exact web page or academic paper behind each match, and how much it overlaps."),
    points: [tr("Web pages and academic papers"), tr("Ready-made citations")],
  },
  {
    icon: PencilLine,
    title: tr("AI Rewrite Assistant"),
    body: tr("Rewrite a flagged passage in an academic tone with one click, then keep editing it yourself."),
    points: [tr("Edit the suggestion before you use it"), tr("Available on Premium")],
  },
  {
    icon: ClockCounterClockwise,
    title: tr("Re-check every draft"),
    body: tr("Fix, re-check only what changed, and see your originality improve from draft to draft."),
    points: [tr("Every version kept and restorable"), tr("Free re-checks on every plan")],
  },
];

const STEPS = [
  { title: tr("Bring your writing"), body: tr("Upload a PDF or Word file, or paste your text, and pick its language."), points: [tr("PDF, DOCX or text"), tr("Vietnamese or English")] },
  { title: tr("Etymos looks deeper"), body: tr("Your document is compared with web pages and academic papers, word for word and by meaning."), points: [tr("Exact and paraphrased matches"), tr("AI-writing check")] },
  { title: tr("Improve your next draft"), body: tr("Read why each passage was flagged, fix it, and re-check only what changed."), points: [tr("Plain-language explanations"), tr("Re-check and compare drafts")] },
];

const PAINS = [
  { pain: tr("Flagged even though you wrote it yourself"), fix: tr("See exactly which sentence matched which source, and why") },
  { pain: tr("Reworded copying slips past keyword checks"), fix: tr("Semantic detection catches paraphrase in Vietnamese") },
  { pain: tr("A percentage with no explanation"), fix: tr("Every flagged passage gets a reason you can act on") },
  { pain: tr("Not sure whether a text was written by AI"), fix: tr("AI-writing detection highlights the sentences in question") },
  { pain: tr("Don't know how to fix a passage"), fix: tr("AI Rewrite suggests an academic rewording to start from") },
];

export default function LandingPage() {
  const root = useRef<HTMLDivElement>(null);
  const [plans, setPlans] = useState<PlanDefinition[]>(() => cachedPricingData()?.plans ?? []);

  useSmoothPage(root, { intro: ".mk-hero-intro", reveal: ".mk-reveal" });
  useStaggerIn(root, ".mk-home-plans > *", plans.length > 0);

  useEffect(() => {
    let cancelled = false;
    // Loads Pricing's data too, so that page opens with its cards in place.
    loadPricingData()
      .then((data) => !cancelled && setPlans(data.plans))
      .catch((err: unknown) => console.error("Failed to load plans", err));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div ref={root} className="mk-page">
      {/* Hero */}
      {/* Fills the screen under the sticky nav, so the rest of the page only
          appears once the visitor scrolls. */}
      <section className="mk-hero mk-hero-full">
        <ShaderBackground />
        <div className="mx-auto grid w-full max-w-7xl items-center gap-14 px-5 pb-24 pt-14 sm:px-8 lg:grid-cols-[1.05fr_1fr] lg:gap-16 lg:py-24">
          <div className="mk-hero-intro">
            <Chip>{t("Made for Vietnamese writing")}</Chip>
            <h1 className="mk-h1 mt-5">
              {t("Your ideas. Your voice.")} <Highlight>{t("Clearly original.")}</Highlight>
            </h1>
            <p className="mk-hero-lead mt-5 max-w-xl text-body-lg">
              {t("A plagiarism checker that understands Vietnamese. Traditional and semantic detection, clear AI explanations, and academic rewriting — at a tenth of Turnitin’s price.")}
            </p>
            <ul className="mt-6 flex flex-wrap gap-2">
              {[tr("Paraphrase detection"), tr("AI-writing check"), tr("Plain-language explanations")].map((label) => (
                <li key={label} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-white/80 px-3 py-1.5 text-xs font-medium text-ink-700">
                  <CheckCircle size={15} weight="fill" className="text-brand-500" aria-hidden="true" />
                  {t(label)}
                </li>
              ))}
            </ul>
            <div className="mt-8 flex flex-wrap gap-3">
              {/* Same look as the primary button, plus a light that circles its
                  edge and leans towards the cursor. */}
              <SpecularButton
                to="/signup"
                size="lg"
                radius={12}
                textColor="#ffffff"
                lineColor="#ffffff"
                baseColor="#93c5fd"
                intensity={1}
                idleIntensity={0.35}
                shineSize={10}
                shineFade={34}
                thickness={1.2}
                glow={1}
                followMouse
                proximity={250}
                autoAnimate
                className="brand-gradient h-[3.25rem] px-7 text-base font-semibold shadow-[0_3px_8px_-2px_rgba(23,45,70,0.25)] hover:brightness-[1.08]"
              >
                {t("Start for free")}
                <ArrowRight size={20} aria-hidden="true" />
              </SpecularButton>
              <Button as="link" to="/features" size="lg" variant="outline">
                {t("Explore features")}
              </Button>
            </div>
            {/* Pills, so the line stays readable over the darker part of the waves. */}
            <ul className="mt-5 flex flex-wrap gap-2 text-xs text-ink-600">
              <li className="mk-trust"><ShieldCheck size={15} aria-hidden="true" />{t("No card required")}</li>
              <li className="mk-trust"><QrCode size={15} aria-hidden="true" />{t("Pay by VietQR, MoMo or ZaloPay")}</li>
              <li className="mk-trust"><Clock size={15} aria-hidden="true" />{t("A full report in about 3 minutes")}</li>
              <li className="mk-trust"><LockKey size={15} aria-hidden="true" />{t("Your writing is private")}</li>
            </ul>
          </div>

          <div className="mk-hero-intro relative">
            <WindowFrame title={t("Etymos · Originality report")} badge={t("Example")}>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-4">
                <div>
                  <p className="text-sm font-semibold text-navy-900">{t("Bien-doi-khi-hau-DBSCL.docx")}</p>
                  <p className="text-xs text-ink-500">{t("Checked just now")}</p>
                </div>
                <span className="rounded-full bg-success-bg px-2.5 py-1 text-[0.6875rem] font-bold text-success">{t("Report ready")}</span>
              </div>
              <div className="grid gap-4 py-4 sm:grid-cols-2">
                <div className="rounded-[var(--radius-card)] bg-surface-tint p-4">
                  <p className="text-xs font-semibold text-ink-500">{t("Overall similarity")}</p>
                  <div className="mt-2"><SimilarityBadge score={34} /></div>
                </div>
                <div className="rounded-[var(--radius-card)] bg-surface-tint p-4">
                  <p className="text-xs font-semibold text-ink-500">{t("Likely AI-written")}</p>
                  <p className="mt-2 text-2xl font-extrabold tracking-tight text-ai-flag">12%</p>
                </div>
              </div>
              <div className="rounded-[var(--radius-card)] border border-severity-high-line bg-severity-high-bg/40 p-4">
                <div className="flex items-center justify-between">
                  <SeverityTag severity="high" />
                  <span className="flex items-center gap-1 text-[0.6875rem] font-medium text-ink-500">
                    <BookOpen size={13} aria-hidden="true" /> {t("Academic")}
                  </span>
                </div>
                <p className="mt-2.5 text-xs leading-relaxed text-ink-700">
                  “…đến năm 2050, khoảng 38% diện tích Đồng bằng sông Cửu Long có nguy cơ…”
                </p>
                <div className="mt-2.5 rounded-lg bg-white px-3 py-2">
                  <p className="text-[0.625rem] font-bold uppercase tracking-wide text-brand-600">{t("Why this is flagged")}</p>
                  <p className="mt-1 text-[0.6875rem] leading-relaxed text-ink-500">
                    {t("Same figures and sentence structure as the source, only a few words changed.")}
                  </p>
                </div>
              </div>
            </WindowFrame>
            <div className="mk-float -bottom-6 -left-6 hidden lg:flex">
              <span className="mk-icon !size-9"><MagnifyingGlass size={18} weight="bold" aria-hidden="true" /></span>
              <span><strong className="block text-navy-900">{t("Paraphrase caught")}</strong><span className="text-ink-500">{t("Semantic match · 61%")}</span></span>
            </div>
          </div>
        </div>
        <a href="#what-it-takes" className="mk-scroll-cue" aria-label={t("Scroll to see more")}>
          <span>{t("Scroll to explore")}</span>
          <ArrowDown size={16} weight="bold" aria-hidden="true" />
        </a>
      </section>

      {/* What it takes */}
      <section id="what-it-takes" className="scroll-mt-20 border-b border-line bg-white">
        <div className="mx-auto max-w-6xl px-5 py-10 sm:px-8">
          <p className="text-center text-xs font-semibold uppercase tracking-[0.16em] text-ink-500">{t("Works with the writing you already have")}</p>
          <ul className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {INPUTS.map(({ icon: Icon, title, body }) => (
              <li key={title} className="mk-reveal flex items-center gap-3 rounded-[var(--radius-card)] border border-line bg-surface-tint px-4 py-3">
                <Icon size={24} className="shrink-0 text-brand-600" aria-hidden="true" />
                <span className="min-w-0">
                  <strong className="block text-sm text-navy-900">{t(title)}</strong>
                  <span className="block truncate text-xs text-ink-500">{t(body)}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* At a glance */}
      <section className="mx-auto max-w-6xl px-5 py-20 sm:px-8">
        <SectionHeader
          chip={t("Why Etymos")}
          title={<>{t("Built for a language.")} <Highlight>{t("Priced for a person.")}</Highlight></>}
          lead={t("Most checkers are made for English and sold to universities. Etymos is made for Vietnamese writing, and for you.")}
        />
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FACTS.map((fact) => (
            <div key={fact.label} className="mk-reveal mk-card mk-card-hover p-6">
              <p className="mk-stat text-brand-500">{t(fact.value)}</p>
              <p className="mt-3 text-sm text-ink-600">{t(fact.label)}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Features */}
      <section id="features" className="mk-tint border-y border-line">
        <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8">
          <SectionHeader
            chip={t("Core features")}
            title={<>{t("More than a score.")} <Highlight>{t("A way forward.")}</Highlight></>}
            lead={t("Understand what overlaps, where it comes from, and how to make your writing your own.")}
          />
          <div className="mt-12 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, body, points }) => (
              <article key={title} className="mk-reveal mk-card mk-card-hover flex flex-col p-6">
                <span className="mk-icon"><Icon size={22} weight="bold" aria-hidden="true" /></span>
                <h3 className="mt-5 text-lg font-bold tracking-tight text-navy-900">{t(title)}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-600">{t(body)}</p>
                <ul className="mt-4 space-y-1.5 text-sm text-ink-700">
                  {points.map((p) => (
                    <li key={p} className="flex items-start gap-2">
                      <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-brand-500" />
                      {t(p)}
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
          <div className="mk-reveal mt-10 text-center">
            <Button as="link" to="/features" variant="outline" iconRight={<ArrowRight size={18} aria-hidden="true" />}>
              {t("See every feature in detail")}
            </Button>
          </div>
        </div>
      </section>

      {/* Tour */}
      <section className="mx-auto max-w-6xl px-5 py-20 sm:px-8">
        <SectionHeader
          chip={t("See it in action")}
          title={<>{t("Inside an")} <Highlight>{t("Etymos report")}</Highlight></>}
          lead={t("The screens you'll work with, filled with example data. Pick a tab to look around.")}
        />
        <ProductTour />
      </section>

      {/* How it works */}
      <section id="how-it-works" className="mk-tint border-y border-line">
        <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8">
          <SectionHeader
            chip={t("How it works")}
            title={<>{t("Bring a document.")} <Highlight>{t("Leave with clarity.")}</Highlight></>}
            lead={t("Three steps, a few minutes, and no settings to learn.")}
          />
          <ol className="mk-timeline mt-14 grid gap-10 md:grid-cols-3 md:gap-6">
            {STEPS.map((step, i) => (
              <li key={step.title} className="mk-reveal text-center md:px-4">
                <span className="mk-step-dot">{i + 1}</span>
                <h3 className="mt-5 text-lg font-bold tracking-tight text-navy-900">{t(step.title)}</h3>
                <p className="mx-auto mt-2 max-w-xs text-sm leading-relaxed text-ink-600">{t(step.body)}</p>
                <ul className="mt-4 space-y-1 text-sm text-ink-700">
                  {step.points.map((p) => (
                    <li key={p} className="flex items-center justify-center gap-1.5">
                      <CheckCircle size={15} weight="fill" className="text-brand-500" aria-hidden="true" />
                      {t(p)}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Pain → answer */}
      <section className="mx-auto max-w-6xl px-5 py-20 sm:px-8">
        <SectionHeader
          chip={t("Real problems, real answers")}
          title={<>{t("From second-guessing")} <Highlight>{t("to submitting with confidence")}</Highlight></>}
          lead={t("The worries every student knows before a deadline, and what Etymos does about each one.")}
        />
        <div className="mt-12 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {PAINS.map(({ pain, fix }) => (
            <article key={pain} className="mk-reveal mk-card p-5">
              <div className="flex items-start gap-3 rounded-[var(--radius-card)] border border-severity-high-line bg-severity-high-bg/60 p-3.5">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-white text-severity-high"><X size={14} weight="bold" aria-hidden="true" /></span>
                <span>
                  <span className="block text-[0.6875rem] font-bold uppercase tracking-wide text-severity-high">{t("The worry")}</span>
                  <span className="text-sm font-semibold text-navy-900">{t(pain)}</span>
                </span>
              </div>
              <ArrowDown size={18} className="mx-auto my-2 text-brand-400" aria-hidden="true" />
              <div className="flex items-start gap-3 rounded-[var(--radius-card)] border border-success/25 bg-success-bg p-3.5">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-white text-success"><CheckCircle size={16} weight="fill" aria-hidden="true" /></span>
                <span>
                  <span className="block text-[0.6875rem] font-bold uppercase tracking-wide text-success">{t("With Etymos")}</span>
                  <span className="text-sm font-semibold text-navy-900">{t(fix)}</span>
                </span>
              </div>
            </article>
          ))}
          <article className="mk-reveal mk-cta flex flex-col justify-center !rounded-[var(--radius-card-lg)] !p-7 text-left">
            <Sparkle size={26} weight="fill" className="text-white/85" aria-hidden="true" />
            <h3 className="mt-3 text-xl font-bold tracking-tight text-white">{t("Try it on your next paper")}</h3>
            <p className="mt-2 text-sm text-white/80">{t("Free checks every month on the Free plan. Upgrade only when you need more.")}</p>
            <Link to="/signup" className="mk-cta-primary mt-5 !h-11 self-start !px-5 text-sm">
              {t("Create a free account")}
              <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </article>
        </div>
      </section>

      {/* Comparison */}
      <section className="mk-tint border-y border-line">
        <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8">
          <SectionHeader
            chip={t("A better fit")}
            title={<>{t("How Etymos")} <Highlight>{t("compares")}</Highlight></>}
            lead={t("Individual-friendly pricing, with Vietnamese-language accuracy at its heart.")}
          />
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            {COMPETITORS.map((c) => (
              <article
                key={c.name}
                className={
                  c.highlight
                    ? "mk-reveal mk-card flex flex-col border-brand-300 p-5 ring-2 ring-brand-500/30"
                    : "mk-reveal mk-card flex flex-col p-5"
                }
              >
                <p className={c.highlight ? "text-sm font-bold text-brand-600" : "text-sm font-semibold text-navy-900"}>{t(c.name)}</p>
                <p className="mt-3 text-lg font-bold tracking-tight text-navy-900">{t(c.price)}</p>
                <p className="mt-1 text-xs text-ink-500">{t(c.audience)}</p>
                <p className="mt-4 border-t border-line pt-3 text-xs leading-relaxed text-ink-600">{t(c.limitation)}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* Plans */}
      <section className="mx-auto max-w-6xl px-5 py-20 sm:px-8">
        <SectionHeader
          chip={t("Pricing")}
          title={<>{t("Start free,")} <Highlight>{t("upgrade when you need to")}</Highlight></>}
          lead={t("Monthly plans for regular writing, or credits for a one-off check. Pay in VND by bank transfer.")}
        />
        <div className={cn("mk-home-plans mt-12", PLAN_GRID_CLASS)}>
          {plans.map((plan) => (
            <PlanCard key={plan.id} plan={plan} billingCycle="monthly" />
          ))}
        </div>
        <div className="mk-reveal mt-10 text-center">
          <Button as="link" to="/pricing" variant="outline" iconRight={<ArrowRight size={18} aria-hidden="true" />}>
            {t("Compare plans, credits and annual prices")}
          </Button>
        </div>
      </section>

      <CtaBand
        title={t("Make room for your own ideas.")}
        lead={t("Check your first paper today. It's free to start, and no card is required.")}
      />
    </div>
  );
}
