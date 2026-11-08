import { useLayoutEffect, type RefObject } from "react";

// Layout effects, not plain effects: the starting state of each entrance
// (shifted down, transparent) has to be applied before the browser paints,
// or the content shows for one frame, vanishes, then fades in.
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
 * The public pages' motion (Home, Features, Pricing, About): Lenis smooth
 * scrolling, a staggered entrance for the intro, and sections that rise and
 * come into focus as they scroll into view. All of
 * it is skipped under prefers-reduced-motion.
 */
export function useSmoothPage(
  root: RefObject<HTMLElement | null>,
  { intro = ".mk-hero-intro", reveal = ".editorial-reveal" }: SmoothPageOptions = {},
) {
  useLayoutEffect(() => {
    const media = gsap.matchMedia();
    media.add("(prefers-reduced-motion: no-preference)", () => {
      const lenis = new Lenis({ autoRaf: false, smoothWheel: true });
      const tick = (time: number) => lenis.raf(time * 1000);
      lenis.on("scroll", ScrollTrigger.update);
      gsap.ticker.add(tick);
      const context = gsap.context(() => {
        gsap.from(`${intro} > *`, { y: 24, duration: 0.8, stagger: 0.1, ease: "power3.out", clearProps: "transform" });
        gsap.utils.toArray<HTMLElement>(reveal).forEach((section) => {
          gsap.from(section, {
            y: 30,
            autoAlpha: 0,
            filter: "blur(6px)",
            duration: 0.85,
            ease: "power3.out",
            clearProps: "transform,opacity,visibility,filter",
            // Late enough to be seen, early enough that the last item on a
            // short page still crosses it.
            scrollTrigger: { trigger: section, start: "top 95%", once: true },
          });
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
  useLayoutEffect(() => {
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
