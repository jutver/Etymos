import { memo } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { DotsSixVertical, ImageSquare } from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import type { DocBlock, MatchColorIndex, TableData } from "./blocks";
import { isOverLimit, renderPassageText } from "./renderPassageText";
import { TableBlock } from "./TableBlock";
import { t } from "../../lib/i18n";

export interface BlockItemProps {
  block: DocBlock;
  colorIndexByMatch: MatchColorIndex;
  overLimitOffset: number | undefined;
  locked: boolean;
  onTableChange: (blockId: string, updater: (table: TableData) => TableData) => void;
  /** True when this block's whole paragraph was flagged by AI-content
   * detection (see highlights.ts's `mapAiSegmentsToPassages` — the detector
   * scores paragraphs, not sentences, so this is a whole-block wash rather
   * than a `<mark>` spliced into the middle of the text). Kept apart from
   * `block.spans` (plagiarism) on purpose — DESIGN.md's Functional Wall
   * Rule: different signal, never merged into the same highlight. */
  aiFlagged: boolean;
  /** True when this is the block the reader picked from the AI Detection
   * sidebar card — same "focused" emphasis matches get, scoped to AI. */
  aiActive: boolean;
}

/** Renders one block's actual content (no drag chrome). Split out from
 * `BlockItem` purely for readability — both are memoized together as one
 * unit below. */
function BlockContent({ block, colorIndexByMatch, overLimitOffset, locked, onTableChange, aiFlagged, aiActive }: BlockItemProps) {
  const muted = isOverLimit(block.passage, overLimitOffset);
  // Paragraph-level AI wash: a left rule + faint violet background, applied
  // straight onto the block's own element (not an extra wrapper) so it still
  // works on an <li> — wrapping a list item in a <div> would break the
  // surrounding <ul>/<ol>.
  const aiClass = aiFlagged
    ? cn(
        "-ml-3 rounded-r-sm border-l-[3px] border-ai-flag-line bg-ai-flag-bg/25 pl-3",
        aiActive && "bg-ai-flag-bg/50 ring-1 ring-inset ring-ai-flag-line",
      )
    : undefined;

  if (block.kind === "table" && block.table) {
    return (
      <TableBlock
        table={block.table}
        locked={locked}
        muted={muted}
        onChange={(updater) => onTableChange(block.id, updater)}
      />
    );
  }

  if (block.kind === "image") {
    if (block.imageUrl) {
      return (
        <div contentEditable={false} className="my-5 flex justify-center">
          <img src={block.imageUrl} alt="" className="max-w-full rounded-[2px]" />
        </div>
      );
    }
    return (
      <div
        contentEditable={false}
        className="my-5 flex flex-col items-center gap-2 rounded-[var(--radius-control)] border border-dashed border-line bg-surface-muted px-4 py-10 text-center text-ink-400"
      >
        <ImageSquare size={28} />
        <span className="max-w-sm text-xs">
          {block.imageCaption || t("Image (position preserved, not extracted)")}
        </span>
      </div>
    );
  }

  const text = block.passage
    ? renderPassageText(block.passage.text, block.spans, colorIndexByMatch, muted, block.passage.textMarks)
    : "";
  const editableProps = {
    contentEditable: !locked,
    suppressContentEditableWarning: true,
    className: "outline-none",
  } as const;

  if (block.kind === "heading") {
    const level = block.level ?? 2;
    if (level === 1) return <h1 {...editableProps}>{text}</h1>;
    if (level === 3) return <h3 {...editableProps}>{text}</h3>;
    return <h2 {...editableProps}>{text}</h2>;
  }

  const aiTitle = aiFlagged ? t("Flagged by AI-content detection") : undefined;

  if (block.kind === "list_item") {
    const ListTag = block.listType === "number" ? "ol" : "ul";
    return (
      <ListTag className="mb-0">
        <li {...editableProps} className={cn(editableProps.className, aiClass)} title={aiTitle}>
          {text}
        </li>
      </ListTag>
    );
  }

  return (
    <p {...editableProps} className={cn(editableProps.className, aiClass)} title={aiTitle}>
      {text}
    </p>
  );
}

/**
 * One document block, wrapped for `@dnd-kit/sortable` drag-to-reorder.
 *
 * The drag handle (visible on hover, left gutter) is the ONLY element with
 * `listeners`/`attributes` attached — never the block itself — so placing
 * the caret in the text or clicking a table cell never fights with starting
 * a drag.
 *
 * Memoized on its props (not on anything derived from sibling blocks or
 * drag state elsewhere): reordering the document only changes array order,
 * never these objects' identity, so unaffected blocks bail out of
 * re-rendering entirely and keep whatever the user is mid-typing into their
 * `contentEditable` DOM, exactly like the old single-blob editor relied on
 * `memo` for the same reason.
 */
function BlockItemInner(props: BlockItemProps) {
  const { block, locked } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: block.id,
    disabled: locked,
  });

  return (
    <div
      ref={setNodeRef}
      data-block-id={block.id}
      style={{
        transform: CSS.Transform.toString(transform ? { ...transform, x: 0 } : null),
        transition,
      }}
      className={cn("group/block relative", isDragging && "z-20 opacity-80")}
    >
      {!locked && (
        <button
          type="button"
          {...attributes}
          {...listeners}
          title={t("Drag to reorder")}
          className="absolute -left-8 top-1 flex size-6 items-center justify-center rounded-md text-ink-300 opacity-0 transition-opacity hover:bg-surface-muted hover:text-ink-600 group-hover/block:opacity-100 active:cursor-grabbing sm:-left-9"
        >
          <DotsSixVertical size={15} weight="bold" />
        </button>
      )}
      <BlockContent {...props} />
    </div>
  );
}

export const BlockItem = memo(BlockItemInner);
