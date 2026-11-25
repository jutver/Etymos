// "See it in action": a few screens of a report, with example data, behind
// tabs. Auto-cycles every 4s (pausing on hover, focus, or off-screen) while
// remaining interactive when clicked. Nothing here is live; the window badge says it's an example.
import { useEffect, useId, useRef, useState, type ReactElement } from "react";
import { AnimatePresence, MotionConfig, m } from "motion/react";
import { ChartPieSlice, Lightbulb, Robot, PencilLine, ArrowRight, BookOpen, Globe } from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import { WindowFrame } from "../../components/marketing/Marketing";
import { SimilarityBadge, SeverityTag } from "../../components/Severity";
import { t, tr } from "../../lib/i18n";

const TABS = [
  { key: "report", label: tr("Similarity report"), icon: ChartPieSlice },
  { key: "why", label: tr("Why it's flagged"), icon: Lightbulb },
  { key: "ai", label: tr("AI writing"), icon: Robot },
  { key: "rewrite", label: tr("AI Rewrite"), icon: PencilLine },
] as const;

export type TabKey = (typeof TABS)[number]["key"];

export const AUTO_ADVANCE_MS = 4000;

export function nextTabKey(current: TabKey): TabKey {
  const idx = TABS.findIndex((item) => item.key === current);
  return TABS[(idx + 1) % TABS.length]!.key;
}

export function tabDirection(from: TabKey, to: TabKey): 1 | -1 {
  const fromIdx = TABS.findIndex((item) => item.key === from);
  const toIdx = TABS.findIndex((item) => item.key === to);
  if (fromIdx === TABS.length - 1 && toIdx === 0) return 1;
  if (fromIdx === 0 && toIdx === TABS.length - 1) return -1;
  return toIdx >= fromIdx ? 1 : -1;
}

const SOURCES = [
  { title: "Tạp chí Khoa học Thủy lợi, 2021", kind: tr("Academic paper"), share: 18, icon: BookOpen },
  { title: "vnexpress.net/bien-doi-khi-hau…", kind: tr("Web page"), share: 9, icon: Globe },
  { title: "Báo cáo Môi trường Quốc gia, 2020", kind: tr("Academic paper"), share: 7, icon: BookOpen },
];

export function ReportScreen() {
  return (
    <div className="grid grid-cols-1 gap-5 @lg:grid-cols-[220px_1fr]">
      <div className="rounded-[var(--radius-card)] border border-line bg-surface-tint p-4">
        <p className="text-xs font-semibold text-ink-500">{t("Overall similarity")}</p>
        <div className="mt-3">
          <SimilarityBadge score={34} />
        </div>
        <dl className="mt-4 space-y-2 text-xs">
          <div className="flex justify-between"><dt className="text-ink-500">{t("Matched passages")}</dt><dd className="font-semibold text-navy-900">12</dd></div>
          <div className="flex justify-between"><dt className="text-ink-500">{t("Sources")}</dt><dd className="font-semibold text-navy-900">3</dd></div>
          <div className="flex justify-between"><dt className="text-ink-500">{t("Words checked")}</dt><dd className="font-semibold text-navy-900">4,812</dd></div>
        </dl>
      </div>
      <div>
        <p className="text-sm font-semibold text-navy-900">{t("Matched sources")}</p>
        <ul className="mt-3 space-y-2.5">
          {SOURCES.map((s) => (
            <li key={s.title} className="flex items-center gap-3 rounded-[var(--radius-card)] border border-line bg-white px-3.5 py-3">
              <s.icon size={18} className="shrink-0 text-brand-600" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-navy-900">{s.title}</p>
                <p className="text-xs text-ink-500">{t(s.kind)}</p>
              </div>
              <div className="w-24 shrink-0">
                <p className="text-right text-xs font-bold text-navy-900">{s.share}%</p>
                <div className="mk-meter mt-1"><span style={{ width: `${s.share * 4}%` }} /></div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function WhyScreen() {
  return (
    <div className="grid grid-cols-1 gap-5 @lg:grid-cols-2">
      <div className="rounded-[var(--radius-card)] border border-severity-high-line bg-severity-high-bg/50 p-4">
        <div className="flex items-center justify-between">
          <SeverityTag severity="high" />
          <span className="text-xs font-medium text-ink-500">{t("Semantic match")}</span>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-ink-700">
          “…đến năm 2050, khoảng 38% diện tích Đồng bằng sông Cửu Long có nguy cơ bị ngập do nước biển dâng…”
        </p>
        <p className="mt-3 border-t border-severity-high-line pt-3 text-xs text-ink-500">
          {t("Source: Tạp chí Khoa học Thủy lợi, 2021 · page 4")}
        </p>
      </div>
      <div className="rounded-[var(--radius-card)] border border-line bg-white p-4">
        <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-brand-600">
          <Lightbulb size={16} weight="fill" aria-hidden="true" /> {t("Why this is flagged")}
        </p>
        <p className="mt-3 text-sm leading-relaxed text-ink-700">
          {t("Same figures and sentence structure as the source, only a few words changed.")}
        </p>
        <ul className="mt-4 space-y-2 text-xs text-ink-600">
          <li className="flex gap-2"><span className="text-brand-500">•</span>{t("The 38% figure and the year 2050 are taken directly.")}</li>
          <li className="flex gap-2"><span className="text-brand-500">•</span>{t("The cause-and-effect order matches the source.")}</li>
          <li className="flex gap-2"><span className="text-brand-500">•</span>{t("Cite the source, or put the idea in your own analysis.")}</li>
        </ul>
      </div>
    </div>
  );
}

const AI_LINES = [
  { text: "Biến đổi khí hậu là một trong những thách thức lớn nhất của thế kỷ 21.", ai: true },
  { text: "Ở quê tôi tại Bến Tre, mùa khô năm ngoái nước mặn vào sâu hơn mọi năm.", ai: false },
  { text: "Việc áp dụng các giải pháp toàn diện và bền vững là vô cùng cần thiết.", ai: true },
  { text: "Bà con phải mua nước ngọt theo can để tưới vườn bưởi.", ai: false },
];

export function AiScreen() {
  return (
    <div className="grid grid-cols-1 gap-5 @lg:grid-cols-[1fr_220px]">
      <div className="space-y-2 rounded-[var(--radius-card)] border border-line bg-white p-4 text-sm leading-relaxed">
        {AI_LINES.map((line) => (
          <p
            key={line.text}
            className={cn(
              "rounded-md px-2 py-1",
              line.ai ? "bg-ai-flag-bg text-ink-900 ring-1 ring-ai-flag-line" : "text-ink-600",
            )}
          >
            {line.text}
          </p>
        ))}
      </div>
      <div className="rounded-[var(--radius-card)] border border-line bg-surface-tint p-4">
        <p className="text-xs font-semibold text-ink-500">{t("Likely AI-written")}</p>
        <p className="mk-stat mt-2 text-ai-flag">48%</p>
        <div className="mk-meter mt-3"><span style={{ width: "48%" }} /></div>
        <p className="mt-3 text-xs leading-relaxed text-ink-500">
          {t("Highlighted sentences read as generated text: generic, evenly paced, without personal detail.")}
        </p>
      </div>
    </div>
  );
}

export function RewriteScreen() {
  return (
    <div className="grid grid-cols-1 items-center gap-4 @lg:grid-cols-[1fr_auto_1fr]">
      <div className="rounded-[var(--radius-card)] border border-severity-high-line bg-severity-high-bg/40 p-4">
        <p className="text-xs font-bold uppercase tracking-wide text-severity-high">{t("Before")}</p>
        <p className="mt-2 text-sm leading-relaxed text-ink-700">
          Đến năm 2050, khoảng 38% diện tích Đồng bằng sông Cửu Long có nguy cơ bị ngập do nước biển dâng.
        </p>
      </div>
      <ArrowRight size={22} className="mx-auto rotate-90 text-brand-500 @lg:rotate-0" aria-hidden="true" />
      <div className="rounded-[var(--radius-card)] border border-success/30 bg-success-bg p-4">
        <p className="text-xs font-bold uppercase tracking-wide text-success">{t("Suggested rewrite")}</p>
        <p className="mt-2 text-sm leading-relaxed text-ink-700">
          Theo dự báo của Tạp chí Khoa học Thủy lợi (2021), nước biển dâng có thể khiến gần hai phần năm diện tích Đồng bằng sông Cửu Long bị ngập vào giữa thế kỷ này.
        </p>
      </div>
    </div>
  );
}

const SCREENS: Record<TabKey, () => ReactElement> = {
  report: ReportScreen,
  why: WhyScreen,
  ai: AiScreen,
  rewrite: RewriteScreen,
};

export function ProductTour() {
  const [tab, setTab] = useState<TabKey>("report");
  const [direction, setDirection] = useState<1 | -1>(1);
  const [cycleId, setCycleId] = useState(0);
  const [paused, setPaused] = useState(false);
  const [inView, setInView] = useState(true);
  const [docHidden, setDocHidden] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const remainingRef = useRef(AUTO_ADVANCE_MS);
  const startedAtRef = useRef<number | null>(null);
  const id = useId();
  const Screen = SCREENS[tab];

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (mq) {
      setReducedMotion(mq.matches);
      const onChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
      mq.addEventListener?.("change", onChange);
      return () => mq.removeEventListener?.("change", onChange);
    }
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return;
    setDocHidden(document.hidden);
    const onVisibility = () => setDocHidden(document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry) setInView(entry.isIntersecting);
      },
      { threshold: 0.15 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const isRunning = inView && !paused && !docHidden && !reducedMotion;

  useEffect(() => {
    if (!isRunning) return;
    startedAtRef.current = performance.now();
    const waitMs = Math.max(50, remainingRef.current);
    const timer = window.setTimeout(() => {
      startedAtRef.current = null;
      remainingRef.current = AUTO_ADVANCE_MS;
      setDirection(1);
      setTab((prev) => nextTabKey(prev));
      setCycleId((c) => c + 1);
    }, waitMs);

    return () => {
      window.clearTimeout(timer);
      if (startedAtRef.current !== null) {
        const elapsed = performance.now() - startedAtRef.current;
        remainingRef.current = Math.max(50, remainingRef.current - elapsed);
        startedAtRef.current = null;
      }
    };
  }, [tab, cycleId, isRunning]);

  function selectTab(next: TabKey) {
    setDirection(tabDirection(tab, next));
    setTab(next);
    remainingRef.current = AUTO_ADVANCE_MS;
    startedAtRef.current = null;
    setCycleId((c) => c + 1);
  }

  return (
    <MotionConfig reducedMotion="user">
      <div
        ref={rootRef}
        className="mk-reveal mt-10"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        onFocusCapture={() => setPaused(true)}
        onBlurCapture={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPaused(false);
        }}
      >
        <div role="tablist" aria-label={t("Parts of a report")} className="flex flex-wrap justify-center gap-2">
          {TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              role="tab"
              id={`${id}-${key}`}
              aria-selected={tab === key}
              aria-controls={`${id}-panel`}
              onClick={() => selectTab(key)}
              className="mk-tab"
            >
              <Icon size={16} weight="bold" aria-hidden="true" />
              {t(label)}
              {tab === key && !reducedMotion && (
                <span
                  key={`${key}-${cycleId}`}
                  aria-hidden="true"
                  className="mk-tab-progress"
                  style={{ animationPlayState: isRunning ? "running" : "paused" }}
                />
              )}
            </button>
          ))}
        </div>
        <WindowFrame
          title={t("etymos.site · Originality report · Bien-doi-khi-hau-DBSCL.docx")}
          badge={t("Example")}
          className="mx-auto mt-6 max-w-5xl"
        >
          <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${tab}`} className="mk-tour-panel min-h-[272px] overflow-hidden">
            <AnimatePresence mode="wait" initial={false}>
              <m.div
                key={tab}
                initial={{ opacity: 0, x: direction * 18 }}
                animate={{
                  opacity: 1,
                  x: 0,
                  transition: { duration: 0.28, ease: [0.22, 1, 0.36, 1] },
                }}
                exit={{
                  opacity: 0,
                  x: direction * -18,
                  transition: { duration: 0.18, ease: [0.4, 0, 0.2, 1] },
                }}
              >
                <Screen />
              </m.div>
            </AnimatePresence>
          </div>
        </WindowFrame>
      </div>
    </MotionConfig>
  );
}
