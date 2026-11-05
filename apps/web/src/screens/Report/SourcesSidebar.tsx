import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, MotionConfig, m, type TargetAndTransition } from "motion/react";
import { CaretDown, CaretRight, CaretUp, GraduationCap, MagnifyingGlass, Robot, ShieldCheck, Sidebar, X } from "@phosphor-icons/react";
import type { AiDetection, MatchedSource } from "@etymos/shared";
import { cn } from "@etymos/shared";
import { MatchCard } from "../../components/MatchCard";
import { Button } from "../../components/ui/Button";
import { AiDetectionSection } from "./AiDetectionSection";
import { buildSearchIndex, filterMatchIndexes } from "./sourceSearch";
import { t, tn } from "../../lib/i18n";

export type SidebarTab = "sources" | "ai";

const WIDE_QUERY = "(min-width: 1024px)";
function subscribeWide(onChange: () => void) {
  const mq = window.matchMedia(WIDE_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
/** True at `lg`, where the panel sits beside the document instead of under it. */
function useIsWide() {
  return useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE_QUERY).matches, () => true);
}

/* Opening grows the panel out of the folded rail (44px wide, beside the
 * document) or bar (48px tall, under it), so the swap has no jump; closing
 * shrinks it back into that size before the rail or bar takes its place. */
const OPEN_EASE = [0.22, 1, 0.36, 1] as const;
const CLOSE_EASE = [0.4, 0, 0.2, 1] as const;
const PANEL: Record<"wide" | "narrow", { folded: TargetAndTransition; open: TargetAndTransition }> = {
  wide: {
    folded: { width: 44, transition: { duration: 0.26, ease: CLOSE_EASE } },
    open: { width: "auto", transition: { duration: 0.38, ease: OPEN_EASE } },
  },
  narrow: {
    folded: { height: 48, transition: { duration: 0.26, ease: CLOSE_EASE } },
    open: { height: "auto", transition: { duration: 0.38, ease: OPEN_EASE } },
  },
};
const PANEL_CONTENT = {
  folded: { opacity: 0, transition: { duration: 0.12 } },
  open: { opacity: 1, transition: { duration: 0.24, delay: 0.1 } },
};

export interface SourcesSidebarProps {
  matches: MatchedSource[];
  lockedCount: number;
  activeMatchId: string | null;
  /** Ids of matches that have a highlight to jump to in the document view.
   * Omit to skip the "couldn't locate" hint (e.g. when viewing the PDF). */
  locatedIds?: Set<string>;
  resolvedIds: Set<string>;
  /** match id -> title of the source its rewritten/edited text still
   * overlaps (quick check, useQuickCheck.ts). */
  stillFlaggedNotes?: Map<string, string>;
  explanationLocked: boolean;
  rewriteLocked: boolean;
  /** Same data as the top bar's AiContentChip — rendered as its own section
   * below the matched sources instead of behind a chip+modal. `undefined`
   * (no detection run / old report) or `{ available: false }` renders
   * nothing, same as the chip. */
  aiDetection: AiDetection | undefined;
  /** Passed straight through to AiDetectionSection — see its own docs. */
  activeAiSegmentId?: string | null;
  onAiSegmentClick?: (segmentId: string) => void;
  /** Controlled tab, so the Report page can show only the highlights that
   * belong to it (sources tab -> matches, AI tab -> AI-flagged paragraphs).
   * Omit both to keep the sidebar's own tab state. */
  tab?: SidebarTab;
  onTabChange?: (tab: SidebarTab) => void;
  onSelect: (matchId: string) => void;
  onViewComparison: (match: MatchedSource) => void;
  onRewrite: (match: MatchedSource) => void;
  onCite: (match: MatchedSource) => void;
  /** Which locked section the user clicked, so the paywall can say what it unlocks. */
  onUpgrade: (reason: "semantic" | "ai-detection") => void;
  /** Similarity score pill, shown in the folded bar on phones (the top bar
   * has no room for it there). */
  scoreBadge?: React.ReactNode;
  open: boolean;
  onToggle: () => void;
}

export function SourcesSidebar({
  matches,
  lockedCount,
  activeMatchId,
  locatedIds,
  resolvedIds,
  stillFlaggedNotes,
  explanationLocked,
  rewriteLocked,
  aiDetection,
  activeAiSegmentId,
  onAiSegmentClick,
  tab: controlledTab,
  onTabChange,
  onSelect,
  onViewComparison,
  onRewrite,
  onCite,
  onUpgrade,
  scoreBadge,
  open,
  onToggle,
}: SourcesSidebarProps) {
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [query, setQuery] = useState("");
  // Two tabs: matched sources and AI-content detection. The AI tab only
  // exists when a detection result is there to show (same rule as
  // AiDetectionSection, which renders nothing otherwise).
  const hasAiTab = aiDetection?.available === true;
  const [ownTab, setOwnTab] = useState<"sources" | "ai">("sources");
  const tab = controlledTab ?? ownTab;
  const setTab = useCallback(
    (next: SidebarTab) => {
      setOwnTab(next);
      onTabChange?.(next);
    },
    [onTabChange],
  );
  const activeTab = hasAiTab ? tab : "sources";

  // Haystacks are built once per match list; each keystroke is then just a
  // handful of `includes` calls, which matters with hundreds of matches.
  const searchIndex = useMemo(() => buildSearchIndex(matches), [matches]);
  // Positions in `matches`, not copies: a card's position is also its badge
  // number and highlight colour, which must not change while filtering.
  const shownIndexes = useMemo(() => filterMatchIndexes(searchIndex, query), [searchIndex, query]);
  const isFiltering = query.trim().length > 0;

  // Clicking a highlight on the document/PDF sets activeMatchId, but the
  // matching card can be scrolled off-screen in this panel — without this,
  // the click had no visible effect.
  // Follow whatever was clicked in the document: a match highlight opens the
  // sources tab, an AI-flagged paragraph the AI tab.
  useEffect(() => {
    if (activeMatchId) setTab("sources");
  }, [activeMatchId, setTab]);
  useEffect(() => {
    if (activeAiSegmentId) setTab("ai");
  }, [activeAiSegmentId, setTab]);

  useEffect(() => {
    if (!activeMatchId) return;
    cardRefs.current.get(activeMatchId)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeMatchId]);

  const wide = useIsWide();
  const panel = PANEL[wide ? "wide" : "narrow"];

  return (
    <MotionConfig reducedMotion="user">
    {/* "wait": the rail/bar only comes back once the panel has folded into it. */}
    <AnimatePresence mode="wait" initial={false}>
    {!open ? (
      // display: contents keeps both buttons laid out as if unwrapped.
      <m.div key="folded" className="contents" exit={{ opacity: 1, transition: { duration: 0 } }}>
      {/* Phones: a bar under the document that unfolds the panel. */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={false}
        aria-controls="report-sources-panel"
        aria-label={t("Expand sources panel")}
        className="flex h-12 w-full shrink-0 items-center gap-2 border-t border-line bg-white px-4 text-left text-sm font-bold text-navy-900 lg:hidden"
      >
        <ShieldCheck size={16} className="text-ink-500" />
        <span className="min-w-0 flex-1 truncate">
          {tn(matches.length, "{{count}} matched source", "{{count}} matched sources")}</span>
        {scoreBadge}
        {aiDetection?.available && (
          <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-ai-flag-line bg-ai-flag-bg px-2.5 py-1 text-xs font-semibold tabular-nums text-ai-flag">
            <Robot size={13} />
            {t("AI")}{" "}{Math.round(aiDetection.overallScore)}%</span>
        )}
        <CaretUp size={16} className="shrink-0 text-ink-500" />
      </button>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={false}
        aria-controls="report-sources-panel"
        className="hidden w-11 shrink-0 flex-col items-center gap-2 border-l border-line bg-white px-2 py-4 text-ink-500 transition-colors hover:text-ink-900 lg:flex"
      >
        <Sidebar size={18} />
        <span className="text-xs font-bold tabular-nums">{matches.length}</span>
        <span className="[writing-mode:vertical-rl] text-xs font-semibold tracking-wide">
          {t("Sources")}</span>
      </button>
      </m.div>
    ) : (
    <m.aside
      key={wide ? "panel-wide" : "panel-narrow"}
      id="report-sources-panel"
      aria-label={t("Matched sources")}
      initial={panel.folded}
      animate={panel.open}
      exit={panel.folded}
      className="flex max-h-[55%] w-full shrink-0 flex-col overflow-hidden border-t border-line bg-white lg:max-h-none lg:w-auto lg:border-l lg:border-t-0"
    >
      {/* Fixed width at lg, so nothing inside reflows while the panel grows. */}
      <m.div
        initial={PANEL_CONTENT.folded}
        animate={PANEL_CONTENT.open}
        exit={PANEL_CONTENT.folded}
        className="flex min-h-0 flex-1 flex-col lg:w-[22rem] xl:w-[24rem]"
      >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-bold text-navy-900">
            {activeTab === "ai" ? t("AI-generated content") : isFiltering ? t("{{shown}} of {{total}} matched sources", { shown: shownIndexes.length, total: matches.length }) : tn(matches.length, "{{count}} matched source", "{{count}} matched sources")}
          </h2>
          <p className="mt-0.5 text-xs text-ink-500">
            {activeTab === "ai" ? t("Paragraphs that look machine-written, and why.") : t("Each colour matches a highlight in your document.")}</p>
        </div>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded
          aria-controls="report-sources-panel"
          aria-label={t("Collapse sources panel")}
          title={t("Collapse sources panel")}
          className="flex size-11 shrink-0 items-center justify-center rounded-lg text-ink-500 transition-colors hover:bg-surface-muted hover:text-ink-900 lg:size-8"
        >
          <CaretDown size={16} className="lg:hidden" />
          <CaretRight size={16} className="hidden lg:block" />
        </button>
      </div>

      {hasAiTab && (
        <div role="tablist" aria-label={t("Sidebar sections")} className="flex shrink-0 gap-1 border-b border-line px-3 py-2">
          {([
            { id: "sources", label: t("Matched sources"), badge: String(matches.length), icon: <ShieldCheck size={14} /> },
            {
              id: "ai",
              label: t("AI"),
              badge: aiDetection?.available ? `${Math.round(aiDetection.overallScore)}%` : "",
              icon: <Robot size={14} />,
            },
          ] as const).map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={activeTab === item.id}
              onClick={() => setTab(item.id)}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold transition-colors",
                activeTab === item.id
                  ? item.id === "ai"
                    ? "bg-ai-flag-bg text-ai-flag"
                    : "bg-brand-100/60 text-navy-900"
                  : "text-ink-500 hover:bg-surface-muted hover:text-ink-900",
              )}
            >
              {item.icon}
              {item.label}
              {item.badge && <span className="tabular-nums opacity-80">{item.badge}</span>}
            </button>
          ))}
        </div>
      )}

      {activeTab === "sources" && matches.length > 0 && (
        <div className="shrink-0 border-b border-line px-3 py-2.5">
          <label className="relative block">
            <span className="sr-only">{t("Search matched sources")}</span>
            <MagnifyingGlass
              size={14}
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-500"
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && query) {
                  e.preventDefault();
                  setQuery("");
                }
              }}
              placeholder={t("Search title, author or text…")}
              autoComplete="off"
              className="h-11 w-full rounded-[var(--radius-input)] border border-line bg-white pl-9 pr-10 text-sm text-ink-900 outline-none transition-colors placeholder:text-ink-500 focus:border-brand-400 focus:ring-2 focus:ring-brand-400/20 [&::-webkit-search-cancel-button]:appearance-none"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label={t("Clear search")}
                className="absolute right-1.5 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-ink-500 transition-colors hover:bg-surface-muted hover:text-ink-900"
              >
                <X size={12} />
              </button>
            )}
          </label>
        </div>
      )}

      <div className="flex-1 overflow-y-auto scrollbar-thin px-3 py-3">
        {activeTab === "sources" && (<>
        {matches.length === 0 ? (
          <div className="flex flex-col items-center px-4 py-14 text-center">
            <ShieldCheck size={28} className="text-success" />
            <p className="mt-3 text-sm font-semibold text-navy-900">{t("No matched sources")}</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-500">
              {t("Nothing in this document overlapped the sources we scanned.")}</p>
          </div>
        ) : shownIndexes.length === 0 ? (
          <div className="flex flex-col items-center px-4 py-12 text-center">
            <MagnifyingGlass size={26} className="text-ink-300" />
            <p className="mt-3 text-sm font-semibold text-navy-900">{t("No sources match")}</p>
            <p className="mt-1 break-words text-xs leading-relaxed text-ink-500">
              {t("Nothing matched \"")}{query.trim()}{t("\". Try a different word from the title, author or text.")}</p>
            <Button size="sm" variant="outline" className="mt-3 h-8 px-3 text-xs" onClick={() => setQuery("")}>
              {t("Clear search")}</Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {shownIndexes.map((i) => {
              const m = matches[i];
              return (
                <div
                  key={m.id}
                  ref={(el) => {
                    if (el) cardRefs.current.set(m.id, el);
                    else cardRefs.current.delete(m.id);
                  }}
                >
                  <MatchCard
                    match={m}
                    index={i}
                    locked={explanationLocked}
                    rewriteLocked={rewriteLocked}
                    selected={activeMatchId === m.id}
                    resolved={resolvedIds.has(m.id)}
                    stillFlaggedBy={stillFlaggedNotes?.get(m.id)}
                    notLocated={locatedIds ? !locatedIds.has(m.id) : false}
                    onSelect={onSelect}
                    onViewComparison={onViewComparison}
                    onRewrite={onRewrite}
                    onCite={onCite}
                  />
                </div>
              );
            })}
          </div>
        )}

        {lockedCount > 0 && (
          <div
            className={cn(
              "mt-3 rounded-[var(--radius-card)] border border-dashed border-brand-300 bg-brand-100/30 p-4 text-center",
            )}
          >
            <GraduationCap size={20} weight="bold" className="mx-auto text-brand-600" />
            <p className="mt-2 text-xs font-semibold text-navy-900">
              {lockedCount}{" "}{t("more found by Semantic Detection")}</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-500">
              {t("Upgrade to catch paraphrased and reworded copying too.")}</p>
            <Button size="sm" className="mt-3 h-8 px-3 text-xs" onClick={() => onUpgrade("semantic")}>
              {t("Unlock")}</Button>
          </div>
        )}
        </>)}

        {activeTab === "ai" && (
        <AiDetectionSection
          detection={aiDetection}
          locked={explanationLocked}
          onUpgrade={() => onUpgrade("ai-detection")}
          activeSegmentId={activeAiSegmentId}
          onSegmentClick={onAiSegmentClick}
          defaultExpanded
        />
        )}
      </div>
      </m.div>
    </m.aside>
    )}
    </AnimatePresence>
    </MotionConfig>
  );
}
