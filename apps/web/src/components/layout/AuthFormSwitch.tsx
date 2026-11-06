import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useOutlet } from "react-router-dom";
import { AnimatePresence, MotionConfig, m, type Variants } from "motion/react";

/** Order of the forms that share the card, so moving forward (Forgot password
 * → Log in → Sign up) slides one way and coming back slides the other. */
export const AUTH_FORM_PATHS = ["/forgot-password", "/login", "/signup"];

const EASE = [0.22, 1, 0.36, 1] as const;

const FORM: Variants = {
  enter: (dir: number) => ({ opacity: 0, x: 24 * dir }),
  shown: { opacity: 1, x: 0, transition: { duration: 0.28, ease: EASE } },
  leave: (dir: number) => ({ opacity: 0, x: -24 * dir, transition: { duration: 0.16, ease: "easeIn" } }),
};

/**
 * The Log in, Sign up and Forgot password forms share one card. Switching
 * between them keeps the card in place: the old form slides out, the card
 * grows or shrinks to the new form's height, and the new form slides in. The card also eases to any
 * height change inside a form, such as an error message appearing.
 */
export function AuthFormSwitch() {
  const { pathname } = useLocation();
  // The routed element is captured per key so the outgoing form keeps
  // rendering itself while it leaves, not the incoming route.
  const outlet = useOutlet();

  const index = AUTH_FORM_PATHS.indexOf(pathname);
  const prevIndex = useRef(index);
  const dir = index >= prevIndex.current ? 1 : -1;
  useEffect(() => {
    prevIndex.current = index;
  }, [index]);

  // Each form loads as its own chunk; fetch the others now so the switch never
  // stops on a loader.
  useEffect(() => {
    void import("../../screens/Login");
    void import("../../screens/Signup");
    void import("../../screens/ForgotPassword");
  }, []);

  const contentRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setHeight(entry.borderBoxSize?.[0]?.blockSize ?? el.offsetHeight);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <MotionConfig reducedMotion="user">
      <m.div
        initial={false}
        animate={{ height: height ?? "auto" }}
        transition={{ duration: 0.32, ease: EASE }}
        className="overflow-hidden rounded-[var(--radius-card-lg)] border border-line bg-white shadow-[var(--shadow-card)]"
      >
        <div ref={contentRef}>
          <AnimatePresence mode="wait" initial={false} custom={dir}>
            <m.div key={pathname} custom={dir} variants={FORM} initial="enter" animate="shown" exit="leave">
              {outlet}
            </m.div>
          </AnimatePresence>
        </div>
      </m.div>
    </MotionConfig>
  );
}
