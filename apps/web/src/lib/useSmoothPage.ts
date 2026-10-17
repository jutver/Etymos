import { useEffect, type RefObject } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";

gsap.registerPlugin(ScrollTrigger);

interface SmoothPageOptions {
  /** Its children slide up one after another on load. */
  intro?: string;
  /** Each match slides up once as it scrolls into view. */
  reveal?: string;
}

/**
 * The marketing pages' motion (Landing, Pricing): Lenis smooth scrolling, a
 * staggered entrance for the intro, and sections that rise into view. All of
 * it is skipped under prefers-reduced-motion.
 */
export function useSmoothPage(
  root: RefObject<HTMLElement | null>,
  { intro = ".composition-intro", reveal = ".editorial-reveal" }: SmoothPageOptions = {},
) {
  useEffect(() => {
    const media = gsap.matchMedia();
    media.add("(prefers-reduced-motion: no-preference)", () => {
      const lenis = new Lenis({ autoRaf: false, smoothWheel: true });
      const tick = (time: number) => lenis.raf(time * 1000);
      lenis.on("scroll", ScrollTrigger.update);
      gsap.ticker.add(tick);
      const context = gsap.context(() => {
        gsap.from(`${intro} > *`, { y: 24, duration: 0.8, stagger: 0.1, ease: "power3.out", clearProps: "transform" });
        gsap.utils.toArray<HTMLElement>(reveal).forEach((section) => {
          gsap.from(section, { y: 30, duration: 0.85, ease: "power3.out", clearProps: "transform", scrollTrigger: { trigger: section, start: "top 90%", once: true } });
        });
      }, root);
      return () => { context.revert(); gsap.ticker.remove(tick); lenis.destroy(); };
    });
    return () => media.revert();
  }, [root, intro, reveal]);
}

/**
 * Content that arrives after the page mounted (cards from the database):
 * stagger it in, and re-measure scroll triggers since the page grew.
 * Pass the selector of the new items, and call when they've rendered.
 */
export function useStaggerIn(root: RefObject<HTMLElement | null>, selector: string, ready: boolean) {
  useEffect(() => {
    if (!ready) return;
    const media = gsap.matchMedia();
    media.add("(prefers-reduced-motion: no-preference)", () => {
      const context = gsap.context(() => {
        gsap.from(selector, { y: 28, autoAlpha: 0, duration: 0.7, stagger: 0.08, ease: "power3.out", clearProps: "transform,opacity,visibility" });
      }, root);
      return () => context.revert();
    });
    ScrollTrigger.refresh();
    return () => media.revert();
  }, [root, selector, ready]);
}
