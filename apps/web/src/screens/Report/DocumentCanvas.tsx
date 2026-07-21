import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileDashed } from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import { chunkPassage, colorForIndex, type RenderedPassage } from "./highlights";

// US Letter at 96dpi, with 1" margins — the same proportions Word shows.
const PAGE_WIDTH = 816;
const PAGE_PADDING_Y = 96;
const PAGE_CONTENT_HEIGHT = 1056 - PAGE_PADDING_Y * 2;

/** Stable colour index per match, derived from sidebar ordering. */
export type MatchColorIndex = Map<string, number>;

interface DocumentBodyProps {
  rendered: RenderedPassage[];
  colorIndexByMatch: MatchColorIndex;
}

/**
 * The passage markup itself.
 *
 * Deliberately memoised on data-only props: once the user unlocks editing they
 * are typing directly into this DOM, and any React re-render of this subtree
 * would reconcile their typing away. Everything that changes at interaction
 * speed (which match is active, whether editing is locked) is therefore applied
 * imperatively by the parent — never through these props.
 */
const DocumentBody = memo(function DocumentBody({ rendered, colorIndexByMatch }: DocumentBodyProps) {
  if (rendered.length === 0) {
    return (
      <div className="flex flex-col items-center py-16 text-center">
        <FileDashed size={30} className="text-ink-300" />
        <p className="mt-3 text-sm font-medium text-ink-700">No extracted text for this document</p>
        <p className="mt-1 max-w-sm text-xs leading-relaxed text-ink-500">
          Start typing to draft here, or open the original file from the toolbar above.
        </p>
      </div>
    );
  }

  return (
    <>
      {rendered.map(({ passage, spans }) => (
        <p key={passage.id}>
          {chunkPassage(passage.text, spans).map((chunk, i) => {
            if (!chunk.matchId) return <span key={i}>{chunk.text}</span>;
            const colorIdx = colorIndexByMatch.get(chunk.matchId) ?? 0;
            const color = colorForIndex(colorIdx);
            return (
              <mark
                key={i}
                data-match-id={chunk.matchId}
                // Non-colour signal #1: every highlight is underlined, so it
                // survives greyscale and colour-blind viewing. Dotted means we
                // know the exact span (backend offsets, or an exact snippet
                // hit); dashed means we could only approximate it.
                //
                // These two must be mutually exclusive, not layered: `cn` is
                // plain clsx with no tailwind-merge, and Tailwind emits
                // `decoration-dashed` *before* `decoration-dotted`, so passing
                // both would let dotted win on CSS order and silently render
                // approximate matches as precise.
                className={cn(
                  "cursor-pointer rounded-[3px] px-[1px] underline decoration-2 underline-offset-[3px] transition-shadow",
                  chunk.approximate ? "decoration-dashed" : "decoration-dotted",
                  color.mark,
                )}
              >
                {chunk.text}
                {/* Non-colour signal #2: the index badge ties this highlight to
                    the numbered card in the sources sidebar. */}
                <sup
                  contentEditable={false}
                  className="ml-0.5 select-none text-[0.625rem] font-bold tabular-nums opacity-70"
                >
                  {colorIdx + 1}
                </sup>
              </mark>
            );
          })}
        </p>
      ))}
    </>
  );
});

export interface DocumentCanvasProps {
  rendered: RenderedPassage[];
  colorIndexByMatch: MatchColorIndex;
  activeMatchId: string | null;
  onSelectMatch: (matchId: string) => void;
  locked: boolean;
  onInput: (text: string) => void;
  onPageChange: (current: number, total: number) => void;
  /** Bumped by the parent to force a full re-mount (e.g. restoring a version). */
  resetKey: number;
  editorRef: React.RefObject<HTMLDivElement | null>;
}

export function DocumentCanvas({
  rendered,
  colorIndexByMatch,
  activeMatchId,
  onSelectMatch,
  locked,
  onInput,
  onPageChange,
  resetKey,
  editorRef,
}: DocumentCanvasProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pageCount, setPageCount] = useState(1);
  const pageCountRef = useRef(1);
  const lastReported = useRef("");

  // --- Page metering -------------------------------------------------------
  // Content flows continuously (a real page-break layout engine is out of
  // scope); page boundaries are drawn as tick marks in the right margin and
  // reported to the word-count pill, which is enough to read as "pages"
  // without occluding a single line of text.
  const reportPage = useCallback(
    (total: number) => {
      const scroller = scrollRef.current;
      const editor = editorRef.current;
      if (!scroller || !editor) return;
      const offset = scroller.scrollTop - editor.offsetTop + scroller.clientHeight * 0.3;
      const current = Math.min(total, Math.max(1, Math.floor(offset / PAGE_CONTENT_HEIGHT) + 1));
      const signature = `${current}/${total}`;
      if (signature === lastReported.current) return;
      lastReported.current = signature;
      onPageChange(current, total);
    },
    [editorRef, onPageChange],
  );

  const remeasure = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const total = Math.max(1, Math.ceil(editor.scrollHeight / PAGE_CONTENT_HEIGHT));
    if (total !== pageCountRef.current) {
      pageCountRef.current = total;
      setPageCount(total);
    }
    reportPage(total);
  }, [editorRef, reportPage]);

  useEffect(() => {
    remeasure();
    const editor = editorRef.current;
    if (!editor || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => remeasure());
    ro.observe(editor);
    return () => ro.disconnect();
  }, [remeasure, editorRef, resetKey]);

  // --- Active-match emphasis ----------------------------------------------
  // Applied imperatively so selecting a source never re-renders (and therefore
  // never clobbers) text the user is editing.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const marks = editor.querySelectorAll<HTMLElement>("mark[data-match-id]");
    marks.forEach((mark) => {
      const isActive = mark.dataset.matchId === activeMatchId;
      mark.classList.toggle("ring-2", isActive);
      mark.classList.toggle("ring-navy-900/40", isActive);
      mark.classList.toggle("ring-offset-1", isActive);
      // Non-colour signal #3: the active match is the only one drawn solid.
      mark.classList.toggle("decoration-solid", isActive);
    });
    if (!activeMatchId) return;
    const target = editor.querySelector<HTMLElement>(`mark[data-match-id="${CSS.escape(activeMatchId)}"]`);
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeMatchId, editorRef, resetKey, rendered]);

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const mark = (e.target as HTMLElement).closest<HTMLElement>("mark[data-match-id]");
      if (mark?.dataset.matchId) onSelectMatch(mark.dataset.matchId);
    },
    [onSelectMatch],
  );

  const sheetStyle = useMemo(() => ({ maxWidth: PAGE_WIDTH }), []);

  return (
    <div
      ref={scrollRef}
      onScroll={() => reportPage(pageCountRef.current)}
      className="relative flex-1 overflow-y-auto scrollbar-thin bg-surface-muted px-4 pb-32 pt-24"
    >
      <div className="mx-auto w-full" style={sheetStyle}>
        <div className="relative rounded-[2px] border border-line/70 bg-white px-8 py-12 shadow-[var(--shadow-card)] sm:px-14 sm:py-16 lg:px-24 lg:py-24">
          <div className="relative">
            {/* Page boundary ticks live entirely in the right margin so they
                never sit on top of a line of text. */}
            <div aria-hidden="true" className="pointer-events-none absolute inset-0 hidden lg:block">
              {Array.from({ length: Math.max(0, pageCount - 1) }, (_, i) => (
                <div
                  key={i}
                  className="absolute -right-[4.5rem] select-none"
                  style={{ top: (i + 1) * PAGE_CONTENT_HEIGHT }}
                >
                  <div className="h-px w-6 bg-line" />
                  <div className="mt-1 text-[0.625rem] font-medium tabular-nums text-ink-300">
                    Page {i + 2}
                  </div>
                </div>
              ))}
            </div>
            <div
              key={resetKey}
              ref={editorRef}
              id="report-document-editor"
              role="textbox"
              aria-multiline="true"
              aria-readonly={locked}
              aria-label="Document text"
              tabIndex={0}
              contentEditable={!locked}
              suppressContentEditableWarning
              spellCheck={!locked}
              onClick={handleClick}
              onInput={(e) => onInput((e.currentTarget as HTMLDivElement).innerText)}
              className={cn(
                "min-h-[864px] text-[1.0625rem] leading-[1.85] text-ink-900 outline-none",
                "[&_p]:mb-5 [&_p:last-child]:mb-0",
                "[&_h1]:mb-4 [&_h1]:mt-8 [&_h1]:text-h2 [&_h1]:font-bold [&_h1]:leading-tight [&_h1]:text-navy-900",
                "[&_h2]:mb-3 [&_h2]:mt-7 [&_h2]:text-h3 [&_h2]:font-bold [&_h2]:leading-tight [&_h2]:text-navy-900",
                "[&_ul]:mb-5 [&_ul]:list-disc [&_ul]:pl-7 [&_ol]:mb-5 [&_ol]:list-decimal [&_ol]:pl-7",
                "[&_blockquote]:my-5 [&_blockquote]:border-l-2 [&_blockquote]:border-line [&_blockquote]:pl-4 [&_blockquote]:text-ink-700",
                locked && "cursor-default caret-transparent select-text",
              )}
            >
              <DocumentBody rendered={rendered} colorIndexByMatch={colorIndexByMatch} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
