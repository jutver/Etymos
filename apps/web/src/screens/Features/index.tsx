// Features: each capability on its own row, with what it does and a mock-up
// of the screen it lives on (example data), then the formats and languages
// Etymos takes and how it treats your documents.
import { useRef, type ComponentType, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  CheckCircle,
  ClockCounterClockwise,
  FileDoc,
  FilePdf,
  Lightbulb,
  LinkSimple,
  LockKey,
  MagnifyingGlass,
  PencilLine,
  Quotes,
  Robot,
  TextAa,
  Translate,
  type IconProps,
} from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import { Chip, CtaBand, Highlight, PageHero, SectionHeader, WindowFrame } from "../../components/marketing/Marketing";
import { t, tr } from "../../lib/i18n";
import { useSmoothPage } from "../../lib/useSmoothPage";
import { AiScreen, ReportScreen, RewriteScreen, WhyScreen } from "../Landing/ProductTour";

function SemanticScreen() {
  return (
    <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2">
      <div className="rounded-[var(--radius-card)] border border-line bg-surface-tint p-4">
        <p className="text-xs font-bold uppercase tracking-wide text-ink-500">{t("Your sentence")}</p>
        <p className="mt-2 text-sm leading-relaxed text-ink-700">
          Nước biển dâng có thể làm gần 40% Đồng bằng sông Cửu Long chìm trong nước vào giữa thế kỷ.
        </p>
      </div>
      <div className="rounded-[var(--radius-card)] border border-line bg-surface-tint p-4">
        <p className="text-xs font-bold uppercase tracking-wide text-ink-500">{t("The source")}</p>
        <p className="mt-2 text-sm leading-relaxed text-ink-700">
          Đến năm 2050, khoảng 38% diện tích Đồng bằng sông Cửu Long có nguy cơ bị ngập do nước biển dâng.
        </p>
      </div>
      <div className="flex items-center justify-between gap-3 rounded-[var(--radius-card)] border border-severity-moderate-line bg-severity-moderate-bg px-4 py-3 @sm:col-span-2">
        <p className="text-sm font-semibold text-navy-900">{t("Same meaning, different words")}</p>
        <span className="rounded-full bg-white px-2.5 py-1 text-xs font-bold text-severity-moderate">{t("Semantic match · 61%")}</span>
      </div>
      <p className="text-xs text-ink-500 @sm:col-span-2">{t("A keyword check finds almost no shared words here. Etymos compares what the sentences mean.")}</p>
    </div>
  );
}

const DRAFTS = [
  { name: tr("Draft 3 · today"), score: 9, note: tr("Re-checked 4 changed paragraphs") },
  { name: tr("Draft 2 · yesterday"), score: 21, note: tr("Rewrote section 2.1") },
  { name: tr("Draft 1 · 3 days ago"), score: 34, note: tr("First full check") },
];

function DraftsScreen() {
  return (
    <ul className="space-y-2.5">
      {DRAFTS.map((d, i) => (
        <li key={d.name} className={cn("flex items-center gap-4 rounded-[var(--radius-card)] border px-4 py-3", i === 0 ? "border-brand-300 bg-brand-100/50" : "border-line bg-white")}>
          <ClockCounterClockwise size={18} className="shrink-0 text-brand-600" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-navy-900">{t(d.name)}</p>
            <p className="text-xs text-ink-500">{t(d.note)}</p>
          </div>
          <div className="w-28 shrink-0">
            <p className="text-right text-sm font-bold text-navy-900">{d.score}%</p>
            <div className="mk-meter mt-1"><span style={{ width: `${d.score * 2.5}%` }} /></div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function CitationScreen() {
  return (
    <div className="space-y-3">
      <div className="rounded-[var(--radius-card)] border border-line bg-white p-4">
        <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-brand-600">
          <Quotes size={15} weight="fill" aria-hidden="true" /> {t("Citation")}
        </p>
        <p className="mt-2 font-mono text-xs leading-relaxed text-ink-700">
          Nguyễn, V. A. (2021). Tác động của nước biển dâng đến Đồng bằng sông Cửu Long. <em>Tạp chí Khoa học Thủy lợi</em>, 64, 1–9.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <span className="rounded-full bg-surface-muted px-3 py-1 text-xs font-medium text-ink-700">{t("Copy citation")}</span>
        <span className="rounded-full bg-surface-muted px-3 py-1 text-xs font-medium text-ink-700">{t("Open source")}</span>
      </div>
    </div>
  );
}

interface FeatureRow {
  icon: ComponentType<IconProps>;
  label: string;
  title: string;
  body: string;
  points: string[];
  window: string;
  screen: () => ReactNode;
  plan?: string;
}

const ROWS: FeatureRow[] = [
  {
    icon: MagnifyingGlass,
    label: tr("Semantic detection"),
    title: tr("Catches paraphrase, not just copy-paste"),
    body: tr("Rewording a source changes the words but keeps the idea. Etymos compares meaning as well as wording, so paraphrased Vietnamese doesn't slip through."),
    points: [tr("Exact and reworded matches in one report"), tr("Tuned for Vietnamese writing"), tr("Works for English too")],
    window: tr("Etymos · Semantic match"),
    screen: SemanticScreen,
    plan: tr("Standard and Premium"),
  },
  {
    icon: Lightbulb,
    label: tr("Explainable AI"),
    title: tr("Know why a passage was flagged"),
    body: tr("A percentage tells you how much. An explanation tells you why. Each flagged passage says what matched and what you can do about it."),
    points: [tr("Plain-language reason for every match"), tr("Points out copied figures, structure and wording"), tr("Suggests citing or rewriting")],
    window: tr("Etymos · Why it's flagged"),
    screen: WhyScreen,
    plan: tr("Standard and Premium"),
  },
  {
    icon: LinkSimple,
    label: tr("Matched sources"),
    title: tr("Follow the evidence to its source"),
    body: tr("See which web pages and academic papers overlap with your writing, how much each one contributes, and the exact passages that match."),
    points: [tr("Web pages and academic papers"), tr("Share of the document for each source"), tr("Side-by-side view of each match")],
    window: tr("Etymos · Similarity report"),
    screen: ReportScreen,
  },
  {
    icon: Robot,
    label: tr("AI-writing detection"),
    title: tr("See which sentences read as AI-written"),
    body: tr("Alongside similarity, Etymos estimates how much of a document reads as machine-generated and highlights the sentences behind that estimate."),
    points: [tr("An overall AI-writing score"), tr("Sentence-level highlights"), tr("Treat it as a signal to review, not a verdict")],
    window: tr("Etymos · AI writing"),
    screen: AiScreen,
  },
  {
    icon: PencilLine,
    label: tr("AI Rewrite Assistant"),
    title: tr("A better starting point for a flagged passage"),
    body: tr("Get an academic rewording of a flagged passage in one click, then make it yours. The suggestion is a draft for you to edit, not a replacement for your voice."),
    points: [tr("An academic tone"), tr("One click from the flagged passage"), tr("Edit the suggestion before you use it")],
    window: tr("Etymos · AI Rewrite"),
    screen: RewriteScreen,
    plan: tr("Premium"),
  },
  {
    icon: ClockCounterClockwise,
    label: tr("Drafts and re-checks"),
    title: tr("Watch your originality improve"),
    body: tr("Fix a few paragraphs and re-check only what changed. Every version is kept, so you can compare drafts or go back to an earlier one."),
    points: [tr("Re-check only the changed paragraphs"), tr("Every version kept and restorable"), tr("Free re-checks on every plan")],
    window: tr("Etymos · Document history"),
    screen: DraftsScreen,
  },
  {
    icon: Quotes,
    label: tr("Citations"),
    title: tr("Cite it instead of rewriting it"),
    body: tr("Sometimes the right fix is a citation. Copy a ready-made reference for a matched source and paste it straight into your document."),
    points: [tr("Ready-made reference for each source"), tr("Copy in one click"), tr("Open the source to check it yourself")],
    window: tr("Etymos · Cite a source"),
    screen: CitationScreen,
  },
];

const FORMATS = [
  { icon: FilePdf, title: tr("PDF"), body: tr("Text-based PDFs, including theses and journal papers") },
  { icon: FileDoc, title: tr("Word (.docx)"), body: tr("Upload your draft as it is") },
  { icon: TextAa, title: tr("Pasted text"), body: tr("Check a paragraph without making a file") },
  { icon: Translate, title: tr("2 languages"), body: tr("Vietnamese and English") },
];

export default function FeaturesPage() {
  const root = useRef<HTMLDivElement>(null);
  useSmoothPage(root, { intro: ".mk-hero-intro", reveal: ".mk-reveal" });

  return (
    <div ref={root} className="mk-page">
      <PageHero
        chip={t("Features")}
        title={<>{t("Everything in an")} <Highlight>{t("Etymos check")}</Highlight></>}
        lead={t("What each part of Etymos does, what it looks like, and which plan it comes with: from paraphrase detection to re-checking your next draft.")}
      >
        <ul className="mt-8 flex flex-wrap justify-center gap-2">
          {ROWS.map((row, i) => (
            <li key={row.label}>
              <a href={`#feature-${i + 1}`} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-white/80 px-3 py-1.5 text-xs font-medium text-ink-700 transition-colors hover:border-brand-300 hover:text-brand-600">
                <row.icon size={14} weight="bold" aria-hidden="true" />
                {t(row.label)}
              </a>
            </li>
          ))}
        </ul>
      </PageHero>

      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        {ROWS.map((row, i) => {
          const Screen = row.screen;
          const flip = i % 2 === 1;
          return (
            <section
              key={row.label}
              id={`feature-${i + 1}`}
              className="grid items-center gap-10 border-b border-line py-16 last:border-0 lg:grid-cols-2 lg:gap-16 lg:py-24"
            >
              <div className={cn("mk-reveal", flip && "lg:order-2")}>
                <Chip>{`${String(i + 1).padStart(2, "0")} · ${t(row.label)}`}</Chip>
                <div className="mt-5 flex items-center gap-3">
                  <span className="mk-icon shrink-0"><row.icon size={22} weight="bold" aria-hidden="true" /></span>
                  <h2 className="text-[clamp(1.5rem,2.6vw,2rem)] font-bold leading-tight tracking-tight text-navy-900">{t(row.title)}</h2>
                </div>
                <p className="mt-4 text-body-lg text-ink-600">{t(row.body)}</p>
                <ul className="mt-5 space-y-2.5">
                  {row.points.map((p) => (
                    <li key={p} className="flex items-start gap-2.5 text-sm text-ink-700">
                      <CheckCircle size={18} weight="fill" className="mt-px shrink-0 text-brand-500" aria-hidden="true" />
                      {t(p)}
                    </li>
                  ))}
                </ul>
                <p className="mt-6 text-xs font-medium text-ink-500">
                  {row.plan ? t("Included in: {{plans}}", { plans: t(row.plan) }) : t("Included in every plan")}
                </p>
              </div>
              <div className={cn("mk-reveal min-w-0", flip && "lg:order-1")}>
                <WindowFrame title={t(row.window)} badge={t("Example")}>
                  <Screen />
                </WindowFrame>
              </div>
            </section>
          );
        })}
      </div>

      <section className="mk-tint border-y border-line">
        <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8">
          <SectionHeader
            chip={t("Formats and languages")}
            title={<>{t("Bring your writing")} <Highlight>{t("as it is")}</Highlight></>}
            lead={t("No converting, no copying into a special template.")}
          />
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {FORMATS.map(({ icon: Icon, title, body }) => (
              <div key={title} className="mk-reveal mk-card mk-card-hover p-6">
                <span className="mk-icon"><Icon size={22} weight="bold" aria-hidden="true" /></span>
                <h3 className="mt-4 font-bold text-navy-900">{t(title)}</h3>
                <p className="mt-1.5 text-sm text-ink-600">{t(body)}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 py-20 sm:px-8">
        <div className="mk-reveal mk-card grid gap-6 p-7 sm:p-10 md:grid-cols-[auto_1fr_auto] md:items-center">
          <span className="mk-icon !size-14"><LockKey size={28} weight="bold" aria-hidden="true" /></span>
          <div>
            <h2 className="text-xl font-bold tracking-tight text-navy-900">{t("Your documents stay yours")}</h2>
            <p className="mt-2 text-sm leading-relaxed text-ink-600">
              {t("Your documents are only used to check them for you. Other users can never see them, we don't sell them or use them to train our own models, and you can delete them whenever you like.")}
            </p>
          </div>
          <Link to="/privacy-policy" className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand-600 hover:underline">
            {t("Privacy policy")}
            <ArrowRight size={15} aria-hidden="true" />
          </Link>
        </div>
      </section>

      <CtaBand
        title={t("See it on your own writing")}
        lead={t("Upload a document and get a full report in about 3 minutes. It's free to start.")}
      />
    </div>
  );
}
