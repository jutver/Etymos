// About: why Etymos exists, what it's for, and the principles behind it.
// No team names on purpose; add a team section here when there is one.
import { useRef } from "react";
import {
  ArrowRight,
  ChalkboardTeacher,
  Compass,
  Coins,
  GraduationCap,
  Lightbulb,
  LockKey,
  Megaphone,
  Microscope,
  Target,
  Translate,
  UsersThree,
} from "@phosphor-icons/react";
import { Button } from "../../components/ui/Button";
import { CtaBand, Highlight, PageHero, SectionHeader } from "../../components/marketing/Marketing";
import { t, tr } from "../../lib/i18n";
import { useSmoothPage } from "../../lib/useSmoothPage";

const WHY = [
  {
    icon: Translate,
    title: tr("Vietnamese is different"),
    body: tr("Words built from several syllables, diacritics that change meaning, and academic phrasing of its own. A checker made for English misses a lot of it, and flags the wrong things."),
  },
  {
    icon: Lightbulb,
    title: tr("A number isn't enough"),
    body: tr("A similarity score on its own leaves you guessing. Knowing why a passage matched is what lets you fix it, cite it, or move on with confidence."),
  },
  {
    icon: Coins,
    title: tr("Good tools shouldn't need a university contract"),
    body: tr("The best-known checkers are sold to institutions. Students and researchers should be able to check their own work, at a price that makes sense in VND."),
  },
];

const PRINCIPLES = [
  { icon: Compass, title: tr("Explain, don't accuse"), body: tr("A match is a reason to look closer, not a verdict. Every flag comes with the why.") },
  { icon: LockKey, title: tr("Your writing is private"), body: tr("Documents are only used to check them for you. They're never sold or used to train our own models.") },
  { icon: Target, title: tr("Honest about limits"), body: tr("AI-writing detection is an estimate, and we say so. Results are there to help you review, not to replace your judgement.") },
  { icon: UsersThree, title: tr("Built with the people who use it"), body: tr("Feature requests and support messages go straight to the team that builds Etymos.") },
];

const AUDIENCES = [
  { icon: GraduationCap, title: tr("Students"), body: tr("Essays, reports and theses, checked before the deadline.") },
  { icon: Microscope, title: tr("Graduate and PhD researchers"), body: tr("Papers and dissertations, with the sources behind each match.") },
  { icon: ChalkboardTeacher, title: tr("Lecturers"), body: tr("A second look at submitted work, with explanations to share.") },
  { icon: Megaphone, title: tr("Content and SEO teams"), body: tr("Original copy, checked against what's already on the web.") },
];

export default function AboutPage() {
  const root = useRef<HTMLDivElement>(null);
  useSmoothPage(root, { intro: ".mk-hero-intro", reveal: ".mk-reveal" });

  return (
    <div ref={root} className="mk-page">
      <PageHero
        chip={t("About Etymos")}
        title={<>{t("Originality, explained,")} <Highlight>{t("for Vietnamese writing")}</Highlight></>}
        lead={t("Most plagiarism checkers were built for English and sold to universities. Etymos is built to understand Vietnamese, to explain what it finds, and to cost what a student can pay.")}
      >
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Button as="link" to="/signup" size="lg" iconRight={<ArrowRight size={20} aria-hidden="true" />}>
            {t("Start for free")}
          </Button>
          <Button as="link" to="/contact" size="lg" variant="outline">
            {t("Contact us")}
          </Button>
        </div>
      </PageHero>

      <section className="mx-auto grid max-w-6xl gap-5 px-5 py-20 sm:px-8 md:grid-cols-2">
        <article className="mk-reveal mk-card p-8">
          <span className="mk-icon"><Compass size={22} weight="bold" aria-hidden="true" /></span>
          <h2 className="mt-5 text-xl font-bold tracking-tight text-navy-900">{t("Our vision")}</h2>
          <p className="mt-3 leading-relaxed text-ink-600">
            {t("A Vietnam where every student and researcher can check their own work, understand it, and submit it with confidence.")}
          </p>
        </article>
        <article className="mk-reveal mk-card p-8">
          <span className="mk-icon"><Target size={22} weight="bold" aria-hidden="true" /></span>
          <h2 className="mt-5 text-xl font-bold tracking-tight text-navy-900">{t("Our mission")}</h2>
          <p className="mt-3 leading-relaxed text-ink-600">
            {t("Make originality checking accurate for Vietnamese, clear enough to act on, and affordable for one person, not only for institutions.")}
          </p>
        </article>
      </section>

      <section className="mk-tint border-y border-line">
        <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8">
          <SectionHeader
            chip={t("Why we built it")}
            title={<>{t("Three problems")} <Highlight>{t("worth solving")}</Highlight></>}
          />
          <div className="mt-12 grid gap-5 md:grid-cols-3">
            {WHY.map(({ icon: Icon, title, body }, i) => (
              <article key={title} className="mk-reveal mk-card p-7">
                <div className="flex items-center justify-between">
                  <span className="mk-icon"><Icon size={22} weight="bold" aria-hidden="true" /></span>
                  <span className="text-3xl font-extrabold tracking-tight text-brand-200">0{i + 1}</span>
                </div>
                <h3 className="mt-5 text-lg font-bold tracking-tight text-navy-900">{t(title)}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-600">{t(body)}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 py-20 sm:px-8">
        <SectionHeader
          chip={t("What we stand for")}
          title={<>{t("The principles")} <Highlight>{t("behind every check")}</Highlight></>}
        />
        <div className="mt-12 grid gap-5 sm:grid-cols-2">
          {PRINCIPLES.map(({ icon: Icon, title, body }) => (
            <article key={title} className="mk-reveal mk-card mk-card-hover flex gap-4 p-6">
              <span className="mk-icon shrink-0"><Icon size={22} weight="bold" aria-hidden="true" /></span>
              <div>
                <h3 className="font-bold text-navy-900">{t(title)}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-600">{t(body)}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="mk-tint border-y border-line">
        <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8">
          <SectionHeader
            chip={t("Who it's for")}
            title={<>{t("Made for anyone who")} <Highlight>{t("writes to be read")}</Highlight></>}
          />
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {AUDIENCES.map(({ icon: Icon, title, body }) => (
              <article key={title} className="mk-reveal mk-card mk-card-hover p-6">
                <span className="mk-icon"><Icon size={22} weight="bold" aria-hidden="true" /></span>
                <h3 className="mt-4 font-bold text-navy-900">{t(title)}</h3>
                <p className="mt-1.5 text-sm text-ink-600">{t(body)}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <div className="pt-20">
        <CtaBand
          title={t("Questions, ideas or feedback?")}
          lead={t("We read every message. Start a free account, or get in touch with the team.")}
        />
      </div>
    </div>
  );
}
