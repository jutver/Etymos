import { memo } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { DotsSixVertical, ImageSquare } from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import type { DocBlock, MatchColorIndex, TableData } from "./blocks";
import { isOverLimit, renderPassageText } from "./renderPassageText";
import { TableBlock } from "./TableBlock";

export interface BlockItemProps {
  block: DocBlock;
  colorIndexByMatch: MatchColorIndex;
  overLimitOffset: number | undefined;
  locked: boolean;
  onTableChange: (blockId: string, updater: (table: TableData) => TableData) => void;
}

/** Renders one block's actual content (no drag chrome). Split out from
 * `BlockItem` purely for readability — both are memoized together as one
 * unit below. */
function BlockContent({ block, colorIndexByMatch, overLimitOffset, locked, onTableChange }: BlockItemProps) {
  const muted = isOverLimit(block.passage, overLimitOffset);

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
          {block.imageCaption || "Image (position preserved, not extracted)"}
        </span>
      </div>
    );
  }

  const text = block.passage ? renderPassageText(block.passage.text, block.spans, colorIndexByMatch, muted) : "";
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

  if (block.kind === "list_item") {
    const ListTag = block.listType === "number" ? "ol" : "ul";
    return (
      <ListTag className="mb-0">
        <li {...editableProps}>{text}</li>
      </ListTag>
    );
  }

  return <p {...editableProps}>{text}</p>;
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
          title="Drag to reorder"
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
