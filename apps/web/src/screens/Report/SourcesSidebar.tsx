import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaretRight, GraduationCap, MagnifyingGlass, Robot, ShieldCheck, Sidebar, X } from "@phosphor-icons/react";
import type { AiDetection, MatchedSource } from "@etymos/shared";
import { cn } from "@etymos/shared";
import { MatchCard } from "../../components/MatchCard";
import { Button } from "../../components/ui/Button";
import { AiDetectionSection } from "./AiDetectionSection";
import { buildSearchIndex, filterMatchIndexes } from "./sourceSearch";
import { t, tn } from "../../lib/i18n";

export type SidebarTab = "sources" | "ai";

export interface SourcesSidebarProps {
  matches: MatchedSource[];
  lockedCount: number;
  activeMatchId: string | null;
  /** Ids of matches that have a highlight to jump to in the document view.
   * Omit to skip the "couldn't locate" hint (e.g. when viewing the PDF). */
  locatedIds?: Set<string>;
  resolvedIds: Set<string>;
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
  onUpgrade: () => void;
  open: boolean;
  onToggle: () => void;
}

export function SourcesSidebar({
  matches,
  lockedCount,
  activeMatchId,
  locatedIds,
  resolvedIds,
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

  if (!open) {
    return (
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
    );
  }

  return (
    <aside
      id="report-sources-panel"
      aria-label={t("Matched sources")}
      className="flex max-h-[45%] w-full shrink-0 flex-col border-t border-line bg-white lg:max-h-none lg:w-[22rem] lg:border-l lg:border-t-0 xl:w-[24rem]"
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
          className="hidden size-8 shrink-0 items-center justify-center rounded-lg text-ink-500 transition-colors hover:bg-surface-muted hover:text-ink-900 lg:flex"
        >
          <CaretRight size={16} />
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
            <Button size="sm" className="mt-3 h-8 px-3 text-xs" onClick={onUpgrade}>
              {t("Unlock")}</Button>
          </div>
        )}
        </>)}

        {activeTab === "ai" && (
        <AiDetectionSection
          detection={aiDetection}
          locked={explanationLocked}
          onUpgrade={onUpgrade}
          activeSegmentId={activeAiSegmentId}
          onSegmentClick={onAiSegmentClick}
          defaultExpanded
        />
        )}
      </div>
    </aside>
  );
}
