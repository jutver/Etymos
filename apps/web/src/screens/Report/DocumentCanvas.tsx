import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type FocusEvent,
  type MouseEvent,
} from "react";
import { FileDashed } from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { BlockItem } from "./BlockItem";
import { blocksFromRendered, newTableBlock, type DocBlock, type MatchColorIndex, type TableData } from "./blocks";
import type { RenderedPassage } from "./highlights";

export type { MatchColorIndex } from "./blocks";

/** Imperative surface exposed to `FormatToolbar`'s "Insert table" button —
 * structural edits (adding a whole new block) can't go through
 * `document.execCommand` any more now that the document is a real block
 * array, so the toolbar asks the canvas to do it directly. */
export interface DocumentCanvasHandle {
  insertTable: () => void;
}

interface DocumentEditorProps {
  rendered: RenderedPassage[];
  colorIndexByMatch: MatchColorIndex;
  activeMatchId: string | null;
  onSelectMatch: (matchId: string) => void;
  locked: boolean;
  onInput: (text: string) => void;
  overLimitOffset: number | undefined;
  editorRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * The actual editable block list. Kept separate from `DocumentCanvas` below
 * so the parent can force a full reset (fresh block state derived from
 * `rendered`) by remounting this component via `key={resetKey}` — the same
 * remount-based-reset trick the old single-blob editor used, just applied to
 * a component with real state now instead of raw DOM content.
 */
const DocumentEditor = forwardRef<DocumentCanvasHandle, DocumentEditorProps>(function DocumentEditor(
  { rendered, colorIndexByMatch, activeMatchId, onSelectMatch, locked, onInput, overLimitOffset, editorRef },
  ref,
) {
  const [blocks, setBlocks] = useState<DocBlock[]>(() => blocksFromRendered(rendered));
  // Tracks whichever block currently holds focus, without triggering a
  // re-render on every focus change — only "Insert table" ever reads it, and
  // only at the moment the user clicks the toolbar button.
  const focusedBlockIdRef = useRef<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setBlocks((prev) => {
      const oldIndex = prev.findIndex((b) => b.id === active.id);
      const newIndex = prev.findIndex((b) => b.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return prev;
      return arrayMove(prev, oldIndex, newIndex);
    });
  }, []);

  // Stable regardless of `blocks` (functional setState) so it never forces
  // every BlockItem to re-render just because this identity changed.
  const handleTableChange = useCallback((blockId: string, updater: (table: TableData) => TableData) => {
    setBlocks((prev) => prev.map((b) => (b.id === blockId && b.table ? { ...b, table: updater(b.table) } : b)));
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      insertTable: () => {
        setBlocks((prev) => {
          const focusedIndex = focusedBlockIdRef.current
            ? prev.findIndex((b) => b.id === focusedBlockIdRef.current)
            : -1;
          const insertAt = focusedIndex === -1 ? prev.length : focusedIndex + 1;
          const next = [...prev];
          next.splice(insertAt, 0, newTableBlock());
          return next;
        });
      },
    }),
    [],
  );

  const handleFocusCapture = useCallback((e: FocusEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-block-id]");
    if (el?.dataset.blockId) focusedBlockIdRef.current = el.dataset.blockId;
  }, []);

  const handleClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      const mark = (e.target as HTMLElement).closest<HTMLElement>("mark[data-match-id]");
      if (mark?.dataset.matchId) onSelectMatch(mark.dataset.matchId);
    },
    [onSelectMatch],
  );

  // Active-match emphasis, applied imperatively so selecting a source from
  // the sidebar never re-renders (and therefore never clobbers) whatever the
  // user is mid-typing — same technique the old single-blob editor used.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const marks = editor.querySelectorAll<HTMLElement>("mark[data-match-id]");
    marks.forEach((mark) => {
      const isActive = mark.dataset.matchId === activeMatchId;
      mark.classList.toggle("ring-2", isActive);
      mark.classList.toggle("ring-navy-900/40", isActive);
      mark.classList.toggle("ring-offset-1", isActive);
      mark.classList.toggle("decoration-solid", isActive);
    });
    if (!activeMatchId) return;
    const target = editor.querySelector<HTMLElement>(`mark[data-match-id="${CSS.escape(activeMatchId)}"]`);
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeMatchId, editorRef]);

  if (blocks.length === 0) {
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
    <div
      ref={editorRef}
      id="report-document-editor"
      role="textbox"
      aria-multiline="true"
      aria-readonly={locked}
      aria-label="Document text"
      onFocusCapture={handleFocusCapture}
      onClick={handleClick}
      onInput={(e) => onInput((e.currentTarget as HTMLDivElement).innerText)}
      className={cn(
        "relative pl-8 text-[1.0625rem] leading-[1.85] text-ink-900 outline-none sm:pl-10",
        "[&_p]:mb-5 [&_p:last-child]:mb-0",
        "[&_h1]:mb-4 [&_h1]:mt-8 [&_h1]:text-h2 [&_h1]:font-bold [&_h1]:leading-tight [&_h1]:text-navy-900",
        "[&_h2]:mb-3 [&_h2]:mt-7 [&_h2]:text-h3 [&_h2]:font-bold [&_h2]:leading-tight [&_h2]:text-navy-900",
        "[&_h3]:mb-2.5 [&_h3]:mt-6 [&_h3]:text-lg [&_h3]:font-bold [&_h3]:leading-tight [&_h3]:text-navy-900",
        "[&_ul]:mb-1.5 [&_ul]:list-disc [&_ul]:pl-7 [&_ol]:mb-1.5 [&_ol]:list-decimal [&_ol]:pl-7",
        "[&_li]:mb-0",
        locked && "cursor-default caret-transparent select-text",
      )}
    >
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={blocks.map((b) => b.id)} strategy={verticalListSortingStrategy}>
          {blocks.map((block) => (
            <BlockItem
              key={block.id}
              block={block}
              colorIndexByMatch={colorIndexByMatch}
              overLimitOffset={overLimitOffset}
              locked={locked}
              onTableChange={handleTableChange}
            />
          ))}
        </SortableContext>
      </DndContext>
    </div>
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
  /** Character offset into the document's full text where the plan's word
   * limit is first crossed (see Report/index.tsx's `computeWordLimitOffset`).
   * `Infinity` means the whole document is within the limit. Omitted
   * entirely also means "nothing is over the limit". */
  overLimitOffset?: number;
}

/**
 * The Document view's canvas — one continuous, unpaged white surface
 * (Grammarly-style), not a stack of Letter-size page sheets. No ruler, no
 * page-break chrome, no CSS-columns layout: see PLAN.md item 8 for why the
 * previous page-sheet model was replaced.
 *
 * Structure/order (which blocks exist, what order they're in, each table's
 * shape) is real React state living in `DocumentEditor`; a block's own text
 * is still edited via per-block `contentEditable`, which is the normal,
 * expected way to build a rich-text block editor — only the *document*, not
 * each paragraph's keystrokes, needs to be React-owned.
 */
export const DocumentCanvas = forwardRef<DocumentCanvasHandle, DocumentCanvasProps>(function DocumentCanvas(
  { rendered, colorIndexByMatch, activeMatchId, onSelectMatch, locked, onInput, onPageChange, resetKey, editorRef, overLimitOffset },
  ref,
) {
  const innerRef = useRef<DocumentCanvasHandle>(null);
  useImperativeHandle(ref, () => ({ insertTable: () => innerRef.current?.insertTable() }), []);

  // There are no pages any more — reported once so the status pill's
  // "Page X of Y" reads as the single continuous surface it now is, rather
  // than being fed stale data from the old per-sheet IntersectionObserver.
  useEffect(() => {
    onPageChange(1, 1);
  }, [onPageChange, resetKey]);

  return (
    <div className="relative flex-1 overflow-y-auto scrollbar-thin bg-white px-4 pb-32">
      <div className="mx-auto w-full max-w-[52rem] pt-24">
        <DocumentEditor
          key={resetKey}
          ref={innerRef}
          rendered={rendered}
          colorIndexByMatch={colorIndexByMatch}
          activeMatchId={activeMatchId}
          onSelectMatch={onSelectMatch}
          locked={locked}
          onInput={onInput}
          overLimitOffset={overLimitOffset}
          editorRef={editorRef}
        />
      </div>
    </div>
  );
});
