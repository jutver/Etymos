import { useEffect, useRef } from "react";
import {
  ArrowRight,
  Lightbulb,
  LinkSimple,
  MagnifyingGlass,
  NotePencil,
  Translate,
} from "@phosphor-icons/react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import { Button } from "../../components/ui/Button";
import { HeroPreview } from "./HeroPreview";
import { COMPETITORS } from "../../lib/mockData";
import { t, tr } from "../../lib/i18n";

const capabilities = [
  { icon: Lightbulb, title: tr("Understand every match."), body: tr("Plain-language explanations show why a passage is flagged, beyond a similarity percentage."), label: tr("Explainable AI") },
  { icon: MagnifyingGlass, title: tr("Go beyond matching words."), body: tr("Semantic detection finds reworded and paraphrased copying that keyword checks can miss."), label: tr("Semantic detection") },
  { icon: NotePencil, title: tr("Find your own words."), body: tr("Rewrite flagged passages in an academic tone with the one-click AI Rewrite Assistant."), label: tr("AI-assisted rewriting") },
  { icon: LinkSimple, title: tr("Follow the evidence."), body: tr("See the exact page or academic paper that overlaps with your writing."), label: tr("Matched sources") },
];

const steps = [
  [tr("Bring your writing."), tr("Upload a PDF or DOC, or paste your text. Choose the language of your document.")],
  [tr("Look a little deeper."), tr("Scan web pages and academic papers for direct matches and semantic similarities.")],
  [tr("Make your next draft better."), tr("Review your score, understand flagged passages, and rewrite with a clearer direction.")],
];

export default function LandingPage() {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    gsap.registerPlugin(ScrollTrigger);
    const media = gsap.matchMedia();
    media.add("(prefers-reduced-motion: no-preference)", () => {
      const lenis = new Lenis({ autoRaf: false, smoothWheel: true });
      const tick = (time: number) => lenis.raf(time * 1000);
      lenis.on("scroll", ScrollTrigger.update);
      gsap.ticker.add(tick);
      const context = gsap.context(() => {
        gsap.from(".composition-intro > *", { y: 24, duration: 0.8, stagger: 0.1, ease: "power3.out", clearProps: "transform" });
        gsap.utils.toArray<HTMLElement>(".editorial-reveal").forEach((section) => {
          gsap.from(section, { y: 30, duration: 0.85, ease: "power3.out", clearProps: "transform", scrollTrigger: { trigger: section, start: "top 90%", once: true } });
        });
      }, root);
      return () => { context.revert(); gsap.ticker.remove(tick); lenis.destroy(); };
    });
    return () => media.revert();
  }, []);

  return (
    <div ref={root} className="editorial-site composition-site">
      <section className="composition-hero">
        <div className="composition-intro">
          <p className="editorial-kicker"><span /> {t("MADE FOR VIETNAMESE WRITING")}</p>
          <p className="composition-index" aria-hidden="true">{t("01 — ORIGINALITY, EXPLAINED")}</p>
          <h1>{t("Your ideas. Your voice.")}<br /><em>{t("Clearly original.")}</em></h1>
          <p className="editorial-lead">{t("A plagiarism checker that understands Vietnamese. Traditional and semantic detection, clear AI explanations, and academic rewriting — at a tenth of Turnitin’s price.")}</p>
          <div className="editorial-actions">
            <Button as="link" to="/signup" size="lg" iconRight={<ArrowRight size={20} aria-hidden="true" />}>{t("Get Started")}</Button>
            <Button as="link" to="/pricing" size="lg" variant="outline">{t("See pricing")}</Button>
          </div>
          <p className="editorial-note">{t("Vietnamese-first. English-ready. Built for your next draft.")}</p>
        </div>
        <div className="composition-visual" aria-label={t("An example of an Etymos originality report")}>
          <figure className="composition-photo">
            <img src="/assets/design/research-still-life.webp" width="1536" height="1024" fetchPriority="high" alt={t("Open books and research notes in natural sunlight")} />
            <figcaption>{t("Research deserves a clear trail.")}</figcaption>
          </figure>
          <div className="composition-report"><div className="composition-report-heading"><strong>{t("Inside your originality report")}</strong><span>{t("Example preview")}</span></div><HeroPreview /></div>
          <p className="composition-stamp" aria-hidden="true">{t("VIETNAMESE")}<br />{t("& ENGLISH")}</p>
        </div>
      </section>

      <section className="composition-facts" aria-label={t("At a glance")}>
        <div><span>01</span><strong>{t("Vietnamese-first")}</strong><p>{t("Built around academic writing in Vietnamese")}</p></div>
        <div><span>02</span><strong>{t("~3 minutes")}</strong><p>{t("Average time from upload to a full report")}</p></div>
        <div><span>03</span><strong>{t("8× more affordable")}</strong><p>{t("Than English-only tools like Grammarly Premium")}</p></div>
      </section>

      <section id="features" className="composition-features editorial-reveal">
        <div className="composition-heading-row"><div className="editorial-section-heading"><p className="editorial-kicker">{t("02 / A CLOSER LOOK")}</p><h2>{t("More than a score.")}<br /><em>{t("A way forward.")}</em></h2></div><p>{t("Understand what overlaps, where it comes from, and how to make your writing your own.")}</p></div>
        <div className="composition-feature-grid">{capabilities.map((feature, i) => { const FeatureIcon = feature.icon; return <article key={feature.label} className={`composition-feature-card composition-feature-${i + 1}`}><div className="composition-card-meta"><span>0{i + 1}</span><p className="editorial-kicker">{t(feature.label)}</p></div><FeatureIcon size={31} aria-hidden="true" /><h3>{t(feature.title)}</h3><p>{t(feature.body)}</p></article>; })}</div>
        <div className="composition-language"><Translate size={30} aria-hidden="true" /><div><p className="editorial-kicker">{t("BUILT FOR BOTH LANGUAGES")}</p><h3>{t("Two languages. The same depth.")}</h3><p>{t("Accurate Vietnamese and English checking, with more than surface-level language support.")}</p></div><span>Tiếng Việt<br />English</span></div>
      </section>

      <section id="how-it-works" className="composition-process editorial-reveal">
        <div className="composition-process-art"><img src="/assets/design/research-still-life.webp" alt="" loading="lazy" width="1536" height="1024" /><div><span>{t("FROM FIRST DRAFT")}</span><strong>{t("TO CLEARER DIRECTION")}</strong></div></div>
        <div className="composition-process-content"><div className="editorial-section-heading"><p className="editorial-kicker">{t("03 / FROM DRAFT TO DIRECTION")}</p><h2>{t("Bring a document.")}<br /><em>{t("Leave with clarity.")}</em></h2></div><div className="composition-steps">{steps.map(([title, body], i) => <article key={title}><span>0{i + 1}</span><div><h3>{t(title)}</h3><p>{t(body)}</p></div></article>)}</div></div>
      </section>

      <section className="composition-spotlight editorial-reveal"><div className="composition-spotlight-copy"><p className="editorial-kicker">{t("04 / KNOW THE WHY")}</p><h2>{t("A percentage tells you how much.")}<br /><em>{t("An explanation tells you why.")}</em></h2><p>{t("Every flagged passage comes with a plain-language reason. Understand what needs attention, and why, before you resubmit.")}</p><Button as="link" to="/upload" size="lg" variant="secondary" iconRight={<ArrowRight size={20} aria-hidden="true" />}>{t("See a real report")}</Button></div><div className="composition-annotation"><div className="composition-annotation-top"><p className="editorial-kicker">{t("ANATOMY OF A MATCH")}</p><span className="editorial-match">{t("Moderate match · 61%")}</span></div><blockquote>{t("“The wording changed, but the argument, evidence, and cause-and-effect order match the source.”")}</blockquote><div className="composition-annotation-note"><Lightbulb size={24} aria-hidden="true" /><p>{t("This reads as paraphrase, rather than analysis in your own voice.")}</p></div><small>{t("Tạp chí Khoa học Thủy lợi, 2021 · Example explanation")}</small></div></section>

      <section className="composition-comparison editorial-reveal"><div className="composition-heading-row"><div className="editorial-section-heading"><p className="editorial-kicker">{t("05 / A BETTER FIT")}</p><h2>{t("Built for a language.")}<br /><em>{t("Priced for a person.")}</em></h2></div><p>{t("Individual-friendly pricing, with Vietnamese-language accuracy at its heart.")}</p></div><div className="composition-compare-grid">{COMPETITORS.map(c => <article key={c.name} className={c.highlight ? "is-etymos" : ""}><p>{t(c.name)}</p><strong>{t(c.price)}</strong><span>{t(c.audience)}</span><p>{t(c.limitation)}</p></article>)}</div></section>

      <section className="composition-outcomes editorial-reveal"><div><p className="editorial-kicker">{t("FOR STUDENTS & RESEARCHERS")}</p><h2>{t("Less second-guessing.")}<br /><em>{t("More thoughtful writing.")}</em></h2></div><div className="composition-outcome-list"><p><strong>{t("Know what to revise.")}</strong> {t("See which passages need attention, with explanations you can act on.")}</p><p><strong>{t("Look beyond copy-paste.")}</strong> {t("Catch paraphrased Vietnamese as well as direct matches.")}</p><p><strong>{t("Review before you submit.")}</strong> {t("Give your next paper a clearer, more original starting point.")}</p></div></section>

      <section className="composition-final"><div className="composition-final-copy"><p className="editorial-kicker">{t("YOUR NEXT DRAFT STARTS HERE")}</p><h2>{t("Make room for")}<br /><em>{t("your own ideas.")}</em></h2><p>{t("Check your first paper today. Three free checks a month, no card required.")}</p><Button as="link" to="/signup" size="lg" variant="outline" iconRight={<ArrowRight size={20} aria-hidden="true" />}>{t("Get Started")}</Button></div><div className="composition-final-art"><img src="/assets/design/research-still-life.webp" alt="" loading="lazy" width="1536" height="1024" /><span aria-hidden="true">ETYMOS<br />ORIGINALITY<br />STUDIO</span></div></section>
    </div>
  );
}
