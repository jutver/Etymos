import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { FileDashed, ImageSquare } from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import { chunkPassage, colorForIndex, type RenderedPassage } from "./highlights";

// US Letter at 96dpi, with 1" margins — the same proportions Word shows.
// Only the width is still load-bearing: page HEIGHT used to be a constant
// divisor faking page breaks (see the removed PAGE_CONTENT_HEIGHT); real
// page breaks now come from each passage's own `page` field (or, absent
// that, a synthetic paragraph-count bucket — see groupIntoPages below), so
// a page's rendered height is however tall its content actually is.
const PAGE_WIDTH = 816;

// Bucket size used ONLY when a document has no backend page metadata at
// all (the pasted-text check path never assigns one — see
// screens/Analyzing's buildPassagesFromBlocks). Purely cosmetic: it keeps
// the "real blank-space gaps between pages, not one long strip" promise
// even for inputs the backend can't paginate, rather than falling back to
// the old single-strip layout for that case.
const SYNTHETIC_PAGE_PASSAGES = 10;

/** Stable colour index per match, derived from sidebar ordering. */
export type MatchColorIndex = Map<string, number>;

interface DocumentBodyProps {
  rendered: RenderedPassage[];
  colorIndexByMatch: MatchColorIndex;
}

/** One physical page's worth of passages, grouped for real (blank-gap)
 * page breaks. `pageNumber` is null when the document carries no page
 * metadata at all — every passage in that document falls into synthetic
 * buckets instead. */
interface PageGroup {
  key: string;
  pageNumber: number | null;
  passages: RenderedPassage[];
}

function groupIntoPages(rendered: RenderedPassage[]): PageGroup[] {
  if (rendered.length === 0) return [];

  const hasPageMetadata = rendered.some((r) => r.passage.page != null);

  if (!hasPageMetadata) {
    const groups: PageGroup[] = [];
    for (let i = 0; i < rendered.length; i += SYNTHETIC_PAGE_PASSAGES) {
      groups.push({
        key: `synthetic-${i}`,
        pageNumber: null,
        passages: rendered.slice(i, i + SYNTHETIC_PAGE_PASSAGES),
      });
    }
    return groups;
  }

  const groups: PageGroup[] = [];
  let current: PageGroup | null = null;

  for (const item of rendered) {
    const page: number = item.passage.page ?? current?.pageNumber ?? 1;
    if (!current || current.pageNumber !== page) {
      current = { key: `page-${page}-${groups.length}`, pageNumber: page, passages: [] };
      groups.push(current);
    }
    current.passages.push(item);
  }

  return groups;
}

/** Renders one passage's text as alternating plain / highlighted spans —
 * the same `<mark>` markup every block type (paragraph, heading, list
 * item) shares. Tables render their own cell text directly instead
 * (see renderBlock's "table" case) since a match's offsets point into the
 * flattened `input_text`, not into any one cell. */
function renderChunks(text: string, spans: RenderedPassage["spans"], colorIndexByMatch: MatchColorIndex) {
  return chunkPassage(text, spans).map((chunk, i) => {
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
  });
}

/** Renders one structural block. List items are handled by the caller
 * (renderPageContent groups consecutive list items into a single <ul>/
 * <ol>) — this only ever emits the <li> itself for that case. */
function renderBlock(item: RenderedPassage, colorIndexByMatch: MatchColorIndex) {
  const { passage, spans } = item;

  switch (passage.blockType) {
    case "title":
      return (
        <h1 key={passage.id} className="!mt-0">
          {renderChunks(passage.text, spans, colorIndexByMatch)}
        </h1>
      );
    case "heading": {
      const level = passage.level ?? 2;
      if (level === 1) return <h1 key={passage.id}>{renderChunks(passage.text, spans, colorIndexByMatch)}</h1>;
      if (level === 3) return <h3 key={passage.id}>{renderChunks(passage.text, spans, colorIndexByMatch)}</h3>;
      return <h2 key={passage.id}>{renderChunks(passage.text, spans, colorIndexByMatch)}</h2>;
    }
    case "list_item":
      return <li key={passage.id}>{renderChunks(passage.text, spans, colorIndexByMatch)}</li>;
    case "table": {
      const rows = passage.tableRows && passage.tableRows.length > 0 ? passage.tableRows : [[passage.text]];
      return (
        <table key={passage.id} contentEditable={false}>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) => (
                  <td key={ci}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    case "image":
      return (
        <div
          key={passage.id}
          contentEditable={false}
          className="my-5 flex flex-col items-center gap-2 rounded-[var(--radius-control)] border border-dashed border-line bg-surface-muted px-4 py-10 text-center text-ink-400"
        >
          <ImageSquare size={28} />
          <span className="max-w-sm text-xs">{passage.text || "Image (position preserved, not extracted)"}</span>
        </div>
      );
    default:
      return <p key={passage.id}>{renderChunks(passage.text, spans, colorIndexByMatch)}</p>;
  }
}

/** Walks one page's passages, wrapping consecutive list_item blocks of the
 * same list type into a single <ul>/<ol> instead of one per item. */
function renderPageContent(passages: RenderedPassage[], colorIndexByMatch: MatchColorIndex) {
  const nodes: React.ReactNode[] = [];
  let i = 0;

  while (i < passages.length) {
    const item = passages[i];
    if (item.passage.blockType === "list_item") {
      const listType = item.passage.listType ?? "bullet";
      const group: RenderedPassage[] = [];
      while (
        i < passages.length &&
        passages[i].passage.blockType === "list_item" &&
        (passages[i].passage.listType ?? "bullet") === listType
      ) {
        group.push(passages[i]);
        i += 1;
      }
      const ListTag = listType === "number" ? "ol" : "ul";
      nodes.push(
        <ListTag key={`list-${group[0].passage.id}`}>
          {group.map((g) => renderBlock(g, colorIndexByMatch))}
        </ListTag>,
      );
      continue;
    }
    nodes.push(renderBlock(item, colorIndexByMatch));
    i += 1;
  }

  return nodes;
}

/**
 * The passage markup itself.
 *
 * Deliberately memoised on data-only props: once the user unlocks editing they
 * are typing directly into this DOM, and any React re-render of this subtree
 * would reconcile their typing away. Everything that changes at interaction
 * speed (which match is active, whether editing is locked) is therefore applied
 * imperatively by the parent — never through these props.
 *
 * Real page breaks are part of this same one-shot render (grouping
 * `rendered` into PageGroups below), not something recomputed from layout
 * on every keystroke — see the module comment on groupIntoPages.
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

  const pages = groupIntoPages(rendered);

  return (
    <>
      {pages.map((page, pageIndex) => (
        <div
          key={page.key}
          data-page-sheet="true"
          className={cn(
            "relative min-h-[70vh] rounded-[2px] border border-line/70 bg-white px-8 py-12 shadow-[var(--shadow-card)] sm:px-14 sm:py-16 lg:px-24 lg:py-24",
            // The blank space between pages IS the page break — a real
            // gap in the layout, not a tick mark drawn over continuous
            // text (the previous implementation).
            pageIndex > 0 && "mt-10 sm:mt-14",
          )}
        >
          {renderPageContent(page.passages, colorIndexByMatch)}
          <div
            contentEditable={false}
            className="pointer-events-none absolute inset-x-0 -bottom-7 select-none text-center text-[0.6875rem] font-medium tabular-nums text-ink-300"
          >
            Page {pageIndex + 1} of {pages.length}
          </div>
        </div>
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
  const pageCountRef = useRef(1);
  const lastReported = useRef("");

  // --- Page metering -------------------------------------------------------
  // Pages are now real DOM regions (one `[data-page-sheet]` per PageGroup
  // from DocumentBody, above) rather than a pixel-height divisor, so
  // "which page am I on" is measured against their actual bounding boxes.
  const measurePages = useCallback(() => {
    const editor = editorRef.current;
    const scroller = scrollRef.current;
    if (!editor || !scroller) return;

    const sheets = Array.from(editor.querySelectorAll<HTMLElement>("[data-page-sheet]"));
    const total = Math.max(1, sheets.length);
    if (total !== pageCountRef.current) {
      pageCountRef.current = total;
    }

    if (sheets.length === 0) {
      const signature = `1/${total}`;
      if (signature !== lastReported.current) {
        lastReported.current = signature;
        onPageChange(1, total);
      }
      return;
    }

    const scrollerRect = scroller.getBoundingClientRect();
    const viewportLine = scrollerRect.top + scrollerRect.height * 0.35;
    let current = 1;
    for (let i = 0; i < sheets.length; i += 1) {
      if (sheets[i].getBoundingClientRect().top <= viewportLine) current = i + 1;
    }

    const signature = `${current}/${total}`;
    if (signature === lastReported.current) return;
    lastReported.current = signature;
    onPageChange(current, total);
  }, [editorRef, onPageChange]);

  useEffect(() => {
    measurePages();
    const editor = editorRef.current;
    if (!editor || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measurePages());
    ro.observe(editor);
    return () => ro.disconnect();
  }, [measurePages, editorRef, resetKey]);

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
      onScroll={() => measurePages()}
      className="relative flex-1 overflow-y-auto scrollbar-thin bg-surface-muted px-4 pb-32 pt-24"
    >
      <div className="mx-auto w-full" style={sheetStyle}>
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
            "text-[1.0625rem] leading-[1.85] text-ink-900 outline-none",
            "[&_p]:mb-5 [&_p:last-child]:mb-0",
            "[&_h1]:mb-4 [&_h1]:mt-8 [&_h1]:text-h2 [&_h1]:font-bold [&_h1]:leading-tight [&_h1]:text-navy-900",
            "[&_h2]:mb-3 [&_h2]:mt-7 [&_h2]:text-h3 [&_h2]:font-bold [&_h2]:leading-tight [&_h2]:text-navy-900",
            "[&_h3]:mb-2.5 [&_h3]:mt-6 [&_h3]:text-lg [&_h3]:font-bold [&_h3]:leading-tight [&_h3]:text-navy-900",
            "[&_ul]:mb-5 [&_ul]:list-disc [&_ul]:pl-7 [&_ol]:mb-5 [&_ol]:list-decimal [&_ol]:pl-7",
            "[&_li]:mb-1.5",
            "[&_blockquote]:my-5 [&_blockquote]:border-l-2 [&_blockquote]:border-line [&_blockquote]:pl-4 [&_blockquote]:text-ink-700",
            "[&_table]:mb-5 [&_table]:w-full [&_table]:table-auto [&_table]:border-collapse [&_table]:text-sm",
            "[&_td]:border [&_td]:border-line [&_td]:px-3 [&_td]:py-2 [&_td]:align-top",
            "[&_th]:border [&_th]:border-line [&_th]:bg-surface-muted [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold",
            locked && "cursor-default caret-transparent select-text",
          )}
        >
          <DocumentBody rendered={rendered} colorIndexByMatch={colorIndexByMatch} />
        </div>
      </div>
    </div>
  );
}
