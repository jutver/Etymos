import { useEffect, useMemo, useRef, useState } from "react";
import { CaretRight, GraduationCap, MagnifyingGlass, ShieldCheck, Sidebar, X } from "@phosphor-icons/react";
import type { MatchedSource } from "@etymos/shared";
import { cn } from "@etymos/shared";
import { MatchCard } from "../../components/MatchCard";
import { Button } from "../../components/ui/Button";
import { buildSearchIndex, filterMatchIndexes } from "./sourceSearch";

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
          Sources
        </span>
      </button>
    );
  }

  return (
    <aside
      id="report-sources-panel"
      aria-label="Matched sources"
      className="studio-sources flex max-h-[45%] w-full shrink-0 flex-col border-t border-line bg-white lg:max-h-none lg:w-[22rem] lg:border-l lg:border-t-0 xl:w-[24rem]"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-bold text-navy-900">
            {isFiltering ? `${shownIndexes.length} of ${matches.length}` : matches.length} matched source
            {(isFiltering ? shownIndexes.length : matches.length) === 1 ? "" : "s"}
          </h2>
          <p className="mt-0.5 text-xs text-ink-500">
            Each colour matches a highlight in your document.
          </p>
        </div>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded
          aria-controls="report-sources-panel"
          aria-label="Collapse sources panel"
          title="Collapse sources panel"
          className="hidden size-11 shrink-0 items-center justify-center rounded-lg text-ink-500 transition-colors hover:bg-surface-muted hover:text-ink-900 lg:flex"
        >
          <CaretRight size={16} />
        </button>
      </div>

      {matches.length > 0 && (
        <div className="shrink-0 border-b border-line px-3 py-2.5">
          <label className="relative block">
            <span className="sr-only">Search matched sources</span>
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
              placeholder="Search title, author or text…"
              autoComplete="off"
              className="h-11 w-full rounded-[var(--radius-input)] border border-line bg-white pl-9 pr-10 text-sm text-ink-900 outline-none transition-colors placeholder:text-ink-500 focus:border-brand-400 focus:ring-2 focus:ring-brand-400/20 [&::-webkit-search-cancel-button]:appearance-none"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="absolute right-1 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-md text-ink-500 transition-colors hover:bg-surface-muted hover:text-ink-900"
              >
                <X size={12} />
              </button>
            )}
          </label>
        </div>
      )}

      <div className="flex-1 overflow-y-auto scrollbar-thin px-3 py-3">
        {matches.length === 0 ? (
          <div className="flex flex-col items-center px-4 py-14 text-center">
            <ShieldCheck size={28} className="text-success" />
            <p className="mt-3 text-sm font-semibold text-navy-900">No matched sources</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-500">
              Nothing in this document overlapped the sources we scanned.
            </p>
          </div>
        ) : shownIndexes.length === 0 ? (
          <div className="flex flex-col items-center px-4 py-12 text-center">
            <MagnifyingGlass size={26} className="text-ink-300" />
            <p className="mt-3 text-sm font-semibold text-navy-900">No sources match</p>
            <p className="mt-1 break-words text-xs leading-relaxed text-ink-500">
              Nothing matched "{query.trim()}". Try a different word from the title, author or text.
            </p>
            <Button size="sm" variant="outline" className="mt-3 h-8 px-3 text-xs" onClick={() => setQuery("")}>
              Clear search
            </Button>
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
              {lockedCount} more found by Semantic Detection
            </p>
            <p className="mt-1 text-xs leading-relaxed text-ink-500">
              Upgrade to catch paraphrased and reworded copying too.
            </p>
            <Button size="sm" className="mt-3 h-8 px-3 text-xs" onClick={onUpgrade}>
              Unlock
            </Button>
          </div>
        )}
      </div>
    </aside>
  );
}
