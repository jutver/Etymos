// The first-run tour: a spotlight that walks a new user from the Upload screen
// to their Documents and through the sample report, one part at a time. It
// opens by itself once per account (profiles.tour_completed_at), waits for any
// other dialog (the Terms gate, an announcement) to close first, and can be
// restarted from the account menu. A step whose element isn't on screen (a
// phone, where the sidebar is folded away) is shown as a centred card instead.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import { AnimatePresence, MotionConfig, m } from "motion/react";
import { ArrowLeft, ArrowRight, Gift, Sparkle, X } from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import { Button } from "../ui/Button";
import { TrialDialog, useTrialOffer } from "../TrialOffer";
import { useAuth } from "../../lib/auth";
import { useAppStore } from "../../lib/store";
import { ensureSampleDocument, markTourDone, useTourStore } from "../../lib/tour";
import { TRIAL_DAYS } from "../../lib/trial";
import { t, tr } from "../../lib/i18n";
import { placePopover, type Box } from "./placePopover";

type Route = "upload" | "documents" | "report";

interface TourStep {
  route: Route;
  /** `data-tour` value of the element to spotlight; none = a centred card. */
  target?: string;
  title: string;
  body: string;
  kind?: "welcome" | "done";
}

const STEPS: TourStep[] = [
  {
    route: "upload",
    kind: "welcome",
    title: tr("Welcome to Etymos"),
    body: tr("Take a one-minute tour? We've added a sample document to your account so you can see a real report."),
  },
  {
    route: "upload",
    target: "upload-card",
    title: tr("Check your writing here"),
    body: tr("Upload a PDF or Word file, or paste your text. Etymos compares it with web pages and academic papers, and looks for AI-written passages."),
  },
  {
    route: "upload",
    target: "usage-meter",
    title: tr("Your checks"),
    body: tr("How many checks your plan has left this month, and any credits you've bought."),
  },
  {
    route: "upload",
    target: "nav-documents",
    title: tr("All your documents"),
    body: tr("Every check is saved here, and you can sort them into projects. Your sample is waiting there."),
  },
  {
    route: "documents",
    target: "sample-document",
    title: tr("Your sample report"),
    body: tr("A short Vietnamese essay we've already checked for you. Let's open it."),
  },
  {
    route: "report",
    target: "report-score",
    title: tr("Similarity score"),
    body: tr("How much of the text matches other sources. The colour shows at a glance whether it needs a closer look."),
  },
  {
    route: "report",
    target: "report-document",
    title: tr("Highlights in your text"),
    body: tr("Every matched passage is highlighted in its source's colour. Click one to jump to that source."),
  },
  {
    route: "report",
    target: "report-sources",
    title: tr("Sources and how to fix them"),
    body: tr("Each source says whether the text was copied word for word or paraphrased, explains why, and offers a rewrite and a ready-made citation."),
  },
  {
    route: "report",
    target: "report-ai",
    title: tr("AI writing check"),
    body: tr("An estimate of how much of the text reads as machine-written, paragraph by paragraph. Treat it as a guide, not proof."),
  },
  {
    route: "report",
    target: "report-toolbar",
    title: tr("Edit and re-check"),
    body: tr("On your own documents, switch to editing, fix what was flagged and re-check only the parts you changed."),
  },
  {
    route: "report",
    kind: "done",
    title: tr("You're all set"),
    body: tr("Upload your own document whenever you're ready. You can take this tour again from the account menu."),
  },
];

/** Steps with a number ("2 of 9"): everything between welcome and done. */
const NUMBERED = STEPS.filter((s) => !s.kind).length;
/** How long to look for a step's element before showing it centred. */
const FIND_TIMEOUT_MS = 2500;
const SPOT_PADDING = 6;

function pathFor(route: Route, sampleId: string | null): string {
  return route === "report" ? `/report/${sampleId}` : `/${route}`;
}

function findTarget(name: string): HTMLElement | null {
  const el = document.querySelector<HTMLElement>(`[data-tour="${name}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? el : null;
}

/** The element's box, padded and kept inside the viewport (the document area
 * is taller than the screen). */
function spotBox(el: HTMLElement): Box {
  const r = el.getBoundingClientRect();
  const top = Math.max(r.top - SPOT_PADDING, 4);
  const left = Math.max(r.left - SPOT_PADDING, 4);
  const bottom = Math.min(r.bottom + SPOT_PADDING, window.innerHeight - 4);
  const right = Math.min(r.right + SPOT_PADDING, window.innerWidth - 4);
  return { top, left, width: Math.max(right - left, 0), height: Math.max(bottom - top, 0) };
}

const sameBox = (a: Box | null, b: Box | null) =>
  a === b || (!!a && !!b && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height);

/** Opens the tour by itself for an account that hasn't seen it. */
function useAutoStart() {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const profileLoaded = useAppStore((s) => s.profileLoaded);
  const tourCompletedAt = useAppStore((s) => s.tourCompletedAt);
  const active = useTourStore((s) => s.active);

  useEffect(() => {
    if (!user || !profileLoaded || tourCompletedAt !== null || active || pathname !== "/upload") return;
    let cancelled = false;
    let timer = 0;
    const tryOpen = async () => {
      // Never on top of another dialog (Terms, an announcement, the survey).
      if (document.querySelector('[role="dialog"]')) {
        timer = window.setTimeout(() => void tryOpen(), 1000);
        return;
      }
      const sampleId = await ensureSampleDocument();
      if (cancelled || !sampleId) return;
      useTourStore.getState().begin(sampleId);
    };
    timer = window.setTimeout(() => void tryOpen(), 900);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [user, profileLoaded, tourCompletedAt, active, pathname]);
}

export function AppTour() {
  useAutoStart();
  const { user } = useAuth();
  const navigate = useNavigate();
  const { active, step: index, sampleId, go, end } = useTourStore();
  const trialOffered = useTrialOffer();
  const [trialOpen, setTrialOpen] = useState(false);
  const step = active ? STEPS[index] : undefined;

  const finish = useCallback(() => {
    end();
    if (user) void markTourDone(user.id);
  }, [end, user]);

  // Each step opens the screen it's about.
  useEffect(() => {
    if (!step) return;
    const path = pathFor(step.route, sampleId);
    if (window.location.pathname !== path) navigate(path);
    // Only when the step changes: the screen is the tour's to choose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, index]);

  return (
    <>
      {step && (
        <TourOverlay
          key="tour"
          step={step}
          index={index}
          onNext={() => (index < STEPS.length - 1 ? go(index + 1) : finish())}
          onBack={() => go(Math.max(index - 1, 1))}
          onSkip={finish}
          onUpload={() => {
            finish();
            navigate("/upload");
          }}
          trialOffered={trialOffered}
          onTrial={() => {
            finish();
            setTrialOpen(true);
          }}
        />
      )}
      <TrialDialog open={trialOpen} onClose={() => setTrialOpen(false)} />
    </>
  );
}

function TourOverlay({
  step,
  index,
  onNext,
  onBack,
  onSkip,
  onUpload,
  trialOffered,
  onTrial,
}: {
  step: TourStep;
  index: number;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
  onUpload: () => void;
  trialOffered: boolean;
  onTrial: () => void;
}) {
  const [box, setBox] = useState<Box | null>(null);
  // False while the step's element is still being looked for.
  const [ready, setReady] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  const [popSize, setPopSize] = useState({ width: 360, height: 220 });
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });

  // Find the element (screens load and animate in), then follow it.
  useEffect(() => {
    setBox(null);
    setReady(!step.target);
    if (!step.target) return;
    const started = performance.now();
    let scrolled = false;
    const tick = () => {
      const el = findTarget(step.target!);
      if (el) {
        const r = el.getBoundingClientRect();
        if (!scrolled && (r.top < 0 || r.bottom > window.innerHeight)) {
          el.scrollIntoView({ block: "center", behavior: "smooth" });
        }
        scrolled = true;
        const next = spotBox(el);
        setBox((prev) => (sameBox(prev, next) ? prev : next));
        setReady(true);
      } else if (performance.now() - started > FIND_TIMEOUT_MS) {
        setBox(null);
        setReady(true);
      }
    };
    tick();
    const timer = window.setInterval(tick, 120);
    return () => window.clearInterval(timer);
  }, [step]);

  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useLayoutEffect(() => {
    const el = popRef.current;
    if (!el) return;
    const measure = () => setPopSize({ width: el.offsetWidth, height: el.offsetHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ready, index]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onSkip();
      else if (e.key === "ArrowRight" && !step.kind) onNext();
      else if (e.key === "ArrowLeft" && index > 1 && !step.kind) onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSkip, onNext, onBack, index, step.kind]);

  useEffect(() => {
    if (ready) popRef.current?.focus({ preventScroll: true });
  }, [ready, index]);

  const pos = placePopover(box, popSize, viewport);
  const number = STEPS.slice(0, index + 1).filter((s) => !s.kind).length;
  // With nothing to point at, the spotlight shrinks to the centre and only the dim remains.
  const spot = box ?? { top: viewport.height / 2, left: viewport.width / 2, width: 0, height: 0 };

  return createPortal(
    <MotionConfig reducedMotion="user">
      <div className="fixed inset-0 z-[95]" data-tour-root>
        {/* Takes every click outside the card, so the tour stays on its step. */}
        <div className="absolute inset-0" aria-hidden="true" />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute rounded-xl transition-[top,left,width,height] duration-[400ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
          style={{
            top: spot.top,
            left: spot.left,
            width: spot.width,
            height: spot.height,
            boxShadow: "0 0 0 9999px rgb(10 25 45 / 0.58)",
            outline: box ? "2px solid rgb(255 255 255 / 0.85)" : "none",
          }}
        />
        <AnimatePresence mode="wait">
          {ready && (
            <m.div
              key={index}
              ref={popRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="tour-title"
              aria-describedby="tour-body"
              tabIndex={-1}
              initial={{ opacity: 0, y: 8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 4, transition: { duration: 0.12 } }}
              transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
              className="studio-card absolute w-[min(22.5rem,calc(100vw-2rem))] rounded-[var(--radius-card-lg)] bg-white p-5 shadow-[var(--shadow-pop)] outline-none"
              style={{ top: pos.top, left: pos.left }}
            >
              <button
                type="button"
                onClick={onSkip}
                aria-label={t("Close the tour")}
                className="absolute right-3 top-3 flex size-8 items-center justify-center rounded-full text-ink-400 transition-colors hover:bg-surface-muted hover:text-ink-900"
              >
                <X size={16} />
              </button>

              {step.kind === "welcome" ? (
                <div className="flex size-10 items-center justify-center rounded-full bg-brand-100 text-brand-600">
                  <Sparkle size={20} weight="fill" />
                </div>
              ) : !step.kind ? (
                <p className="text-xs font-semibold text-brand-600">
                  {t("Step {{number}} of {{total}}", { number, total: NUMBERED })}
                </p>
              ) : null}

              <h2 id="tour-title" className={cn("pr-8 text-base font-bold text-navy-900", step.kind !== "done" && "mt-2")}>
                {t(step.title)}
              </h2>
              <p id="tour-body" className="mt-1.5 text-sm leading-relaxed text-ink-600">
                {t(step.body)}
              </p>

              {step.kind === "welcome" ? (
                <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                  <Button variant="ghost" size="sm" onClick={onSkip}>
                    {t("Skip for now")}
                  </Button>
                  <Button size="sm" onClick={onNext} iconRight={<ArrowRight size={15} weight="bold" />}>
                    {t("Show me around")}
                  </Button>
                </div>
              ) : step.kind === "done" ? (
                <div className="mt-5 flex flex-col gap-2">
                  <Button size="sm" fullWidth onClick={onUpload}>
                    {t("Upload a document")}
                  </Button>
                  {trialOffered && (
                    <Button size="sm" variant="outline" fullWidth onClick={onTrial} iconLeft={<Gift size={15} weight="fill" />}>
                      {t("Try Standard free for {{days}} days", { days: TRIAL_DAYS })}
                    </Button>
                  )}
                </div>
              ) : (
                <div className="mt-5 flex items-center justify-between gap-2">
                  <div className="flex gap-1" aria-hidden="true">
                    {Array.from({ length: NUMBERED }, (_, i) => (
                      <span
                        key={i}
                        className={cn(
                          "h-1.5 rounded-full transition-all duration-300",
                          i + 1 === number ? "w-4 bg-brand-500" : "w-1.5 bg-line",
                        )}
                      />
                    ))}
                  </div>
                  <div className="flex gap-2">
                    {index > 1 && (
                      <Button variant="ghost" size="sm" onClick={onBack} iconLeft={<ArrowLeft size={15} weight="bold" />}>
                        {t("Back")}
                      </Button>
                    )}
                    <Button size="sm" onClick={onNext} iconRight={<ArrowRight size={15} weight="bold" />}>
                      {step.target === "sample-document" ? t("Open it") : t("Next")}
                    </Button>
                  </div>
                </div>
              )}
            </m.div>
          )}
        </AnimatePresence>
      </div>
    </MotionConfig>,
    document.body,
  );
}
