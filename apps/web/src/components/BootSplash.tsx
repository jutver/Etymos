import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "@etymos/shared";
import MetallicPaint, { supportsMetallicPaint } from "./ui/MetallicPaint";
import { t } from "../lib/i18n";

/** The splash never comes and goes faster than this, so it reads as a
 * deliberate brand moment rather than a flicker. */
const MIN_VISIBLE_MS = 2000;
const FADE_MS = 300;
const LOGO_SRC = "/assets/logo/etymos-mark-white.svg";

type Phase = "visible" | "leaving" | "hidden";

interface SplashValue {
  hold: (id: string, reshow: boolean) => void;
  release: (id: string) => void;
  show: () => void;
}

const SplashContext = createContext<SplashValue | null>(null);

function SplashScreen({ leaving }: { leaving: boolean }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy={!leaving}
      className={cn(
        "fixed inset-0 z-[100] flex items-center justify-center bg-surface-tint",
        "transition-opacity duration-300 motion-reduce:transition-none",
        leaving ? "pointer-events-none opacity-0" : "opacity-100",
      )}
    >
      {supportsMetallicPaint() ? (
        <MetallicPaint imageSrc={LOGO_SRC} scale={1} lightMode style={{ width: 128, height: 128 }} />
      ) : (
        <img src="/assets/logo/etymos-mark-blue.svg" alt="" width={128} height={128} className="object-contain" />
      )}
      <span className="sr-only">{t("Loading…")}</span>
    </div>
  );
}

/**
 * Full-screen logo splash shown first on every visit. It stays up for at
 * least MIN_VISIBLE_MS and for as long as any part of the app holds it (see
 * `useSplashHold`) — auth, the maintenance check, the profile check, the
 * first route chunk — so whatever sits underneath is already final when it
 * fades out. One overlay is kept mounted across those phases, so the logo
 * animation never restarts mid-boot.
 */
export function SplashProvider({ children }: { children: ReactNode }) {
  const [holds, setHolds] = useState<ReadonlySet<string>>(() => new Set());
  const [phase, setPhase] = useState<Phase>("visible");
  const [shownAt, setShownAt] = useState(() => performance.now());

  // Read from callbacks without re-creating them; written wherever phase changes.
  const phaseRef = useRef<Phase>("visible");
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const hold = useCallback((id: string, reshow: boolean) => {
    // Boot-only holds never bring the splash back once it has gone.
    if (phaseRef.current === "hidden" && !reshow) return;
    if (phaseRef.current === "hidden") setShownAt(performance.now());
    phaseRef.current = "visible";
    setPhase("visible");
    setHolds((s) => (s.has(id) ? s : new Set(s).add(id)));
  }, []);

  const release = useCallback((id: string) => {
    setHolds((s) => {
      if (!s.has(id)) return s;
      const next = new Set(s);
      next.delete(id);
      return next;
    });
  }, []);

  useEffect(() => {
    if (phase === "visible" && holds.size === 0) {
      const wait = Math.max(0, MIN_VISIBLE_MS - (performance.now() - shownAt));
      const timer = window.setTimeout(() => setPhase("leaving"), wait);
      return () => window.clearTimeout(timer);
    }
    if (phase === "leaving") {
      const timer = window.setTimeout(() => setPhase("hidden"), FADE_MS);
      return () => window.clearTimeout(timer);
    }
  }, [phase, holds, shownAt]);

  /** Brings the splash back for at least MIN_VISIBLE_MS with no hold of its
   * own; holds placed meanwhile (even boot-only ones) can extend it. */
  const show = useCallback(() => {
    if (phaseRef.current === "visible") return;
    phaseRef.current = "visible";
    setShownAt(performance.now());
    setPhase("visible");
  }, []);

  const value = useMemo(() => ({ hold, release, show }), [hold, release, show]);

  return (
    <SplashContext.Provider value={value}>
      {children}
      {phase !== "hidden" && <SplashScreen leaving={phase === "leaving"} />}
    </SplashContext.Provider>
  );
}

/**
 * Keeps the splash up while `active`. With `reshow` (the default) a hold that
 * starts after the splash has gone brings it back — e.g. the profile check
 * right after signing in. Pass `reshow: false` for waits that only matter
 * during the first load, like a lazy route chunk.
 */
export function useSplashHold(active: boolean, { reshow = true }: { reshow?: boolean } = {}) {
  const ctx = useContext(SplashContext);
  const id = useId();

  useEffect(() => {
    if (!ctx || !active) return;
    ctx.hold(id, reshow);
    return () => ctx.release(id);
  }, [ctx, id, active, reshow]);
}

/**
 * Shows the splash when the calling component mounts (if `active`). Runs as a
 * layout effect so the splash is up before the first paint — nothing behind
 * it flashes — and before children's holds register, so a boot-only hold
 * from a Suspense fallback underneath still keeps it up.
 */
export function useSplashOnMount(active: boolean) {
  const ctx = useContext(SplashContext);
  // Mount only: later changes to `active` must not re-trigger it.
  const activeAtMount = useRef(active);

  useLayoutEffect(() => {
    if (activeAtMount.current) ctx?.show();
  }, [ctx]);
}

/** Imperative `show()` for transitions a boolean can't express (e.g. "came
 * from page A to page B"). Call it from a layout effect for the same
 * no-flash timing as the hooks below. */
export function useShowSplash(): () => void {
  const ctx = useContext(SplashContext);
  return ctx?.show ?? noop;
}

const noop = () => {};

/**
 * Shows the splash each time `active` turns true (including on mount), for
 * components that stay mounted across route changes. Same layout-effect
 * timing as `useSplashOnMount`.
 */
export function useSplashOnEnter(active: boolean) {
  const ctx = useContext(SplashContext);

  useLayoutEffect(() => {
    if (active) ctx?.show();
  }, [ctx, active]);
}
