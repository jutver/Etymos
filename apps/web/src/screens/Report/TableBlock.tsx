import { memo, useCallback, useRef } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { DotsSixVertical, Plus, TrashSimple } from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import {
  insertColumn,
  insertRow,
  moveColumn,
  moveRow,
  removeColumn,
  removeRow,
  setCell,
  setColWidth,
  type TableData,
  type TableRow,
} from "./blocks";

export interface TableBlockProps {
  table: TableData;
  locked: boolean;
  muted: boolean;
  /** Applies a pure `TableData -> TableData` edit to this block's table,
   * lifted up to the document's block array. Kept as an updater (not a
   * plain value) so the caller never needs a stale closure over `table`. */
  onChange: (updater: (table: TableData) => TableData) => void;
}

/** One resizable, draggable, deletable column header cell. Purely chrome —
 * it holds no editable text content, so (unlike rows) it's fine for this to
 * re-render freely; nothing here is live, uncontrolled DOM state. */
function ColumnHeader({
  colId,
  index,
  width,
  locked,
  canRemove,
  onResize,
  onRemove,
}: {
  colId: string;
  index: number;
  width: number;
  locked: boolean;
  canRemove: boolean;
  onResize: (width: number) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useSortable({
    id: colId,
    disabled: locked,
  });
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);

  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (locked) return;
      e.preventDefault();
      e.stopPropagation();
      dragState.current = { startX: e.clientX, startWidth: width };
      const onMove = (ev: PointerEvent) => {
        if (!dragState.current) return;
        onResizeRef.current(dragState.current.startWidth + (ev.clientX - dragState.current.startX));
      };
      const onUp = () => {
        dragState.current = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [locked, width],
  );

  return (
    <div
      ref={setNodeRef}
      style={{ width, transform: CSS.Transform.toString(transform ? { ...transform, y: 0 } : null) }}
      className={cn(
        "group/col relative flex shrink-0 items-center gap-1 border-b border-r border-line bg-surface-muted px-2 py-1.5 last:border-r-0",
        isDragging && "z-20 opacity-70",
      )}
    >
      {!locked && (
        <button
          type="button"
          {...attributes}
          {...listeners}
          title="Drag to reorder column"
          className="flex size-4 shrink-0 cursor-grab items-center justify-center rounded text-ink-300 opacity-0 hover:bg-white hover:text-ink-600 group-hover/col:opacity-100 active:cursor-grabbing"
        >
          <DotsSixVertical size={12} weight="bold" />
        </button>
      )}
      <span className="flex-1 truncate text-[0.6875rem] font-semibold uppercase tracking-wide text-ink-400">
        Col {index + 1}
      </span>
      {!locked && canRemove && (
        <button
          type="button"
          title="Delete column"
          onClick={onRemove}
          className="flex size-4 shrink-0 items-center justify-center rounded text-ink-300 opacity-0 hover:bg-white hover:text-severity-high group-hover/col:opacity-100"
        >
          <TrashSimple size={11} />
        </button>
      )}
      {!locked && (
        <div
          onPointerDown={handlePointerDown}
          title="Drag to resize column"
          className="absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize"
        >
          <div className="mx-auto h-full w-px bg-line group-hover/col:bg-brand-400" />
        </div>
      )}
    </div>
  );
}

interface TableRowViewProps {
  row: TableRow;
  colWidths: number[];
  locked: boolean;
  muted: boolean;
  canRemove: boolean;
  onRemove: (rowId: string) => void;
  onCellBlur: (rowId: string, colIndex: number, value: string) => void;
}

/**
 * One table row. Memoized on `row`/`colWidths` identity — the whole point is
 * that a structural edit elsewhere (another row's insert/delete, a resize)
 * must NOT re-render rows whose data didn't change, or React would stomp the
 * live-typed-but-not-yet-blurred contentEditable text a user is mid-editing
 * in an unrelated cell. Column-count changes (insert/remove/move column)
 * unavoidably touch every row's `cells` array, so every row does re-render
 * then — acceptable, since cell text is synced back to state on blur (see
 * `onCellBlur`), so the re-render reflects the latest known-good content
 * rather than stale data.
 */
const TableRowView = memo(function TableRowView({
  row,
  colWidths,
  locked,
  muted,
  canRemove,
  onRemove,
  onCellBlur,
}: TableRowViewProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useSortable({
    id: row.id,
    disabled: locked,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform ? { ...transform, x: 0 } : null) }}
      className={cn("group/row flex", isDragging && "z-20 bg-white opacity-70 shadow-[var(--shadow-pop)]")}
    >
      <div className="flex w-6 shrink-0 items-center justify-center border-b border-line bg-surface-muted">
        {!locked && (
          <button
            type="button"
            {...attributes}
            {...listeners}
            title="Drag to reorder row"
            className="flex size-4 items-center justify-center rounded text-ink-300 opacity-0 hover:bg-white hover:text-ink-600 group-hover/row:opacity-100 active:cursor-grabbing"
          >
            <DotsSixVertical size={12} weight="bold" />
          </button>
        )}
      </div>
      {row.cells.map((cellText, ci) => (
        <div
          key={ci}
          style={{ width: colWidths[ci] }}
          className={cn(
            "shrink-0 border-b border-r border-line px-3 py-2 align-top text-sm outline-none last:border-r-0",
            muted && "text-ink-300",
          )}
          contentEditable={!locked}
          suppressContentEditableWarning
          data-table-cell="true"
          onBlur={(e) => onCellBlur(row.id, ci, (e.currentTarget as HTMLDivElement).innerText)}
        >
          {cellText}
        </div>
      ))}
      {!locked && canRemove && (
        <div className="flex w-6 shrink-0 items-center justify-center border-b border-line">
          <button
            type="button"
            title="Delete row"
            onClick={() => onRemove(row.id)}
            className="flex size-4 items-center justify-center rounded text-ink-300 opacity-0 hover:bg-surface-muted hover:text-severity-high group-hover/row:opacity-100"
          >
            <TrashSimple size={11} />
          </button>
        </div>
      )}
    </div>
  );
});

/**
 * A structured, editable table block — resizable columns, insert/delete row
 * or column, and drag-to-reorder for both rows and columns. Two independent
 * `DndContext`s (row-axis, column-axis) live inside this one block, separate
 * from the document-level block-reorder `DndContext` in DocumentCanvas.tsx —
 * dnd-kit doesn't require a single global context, only that each drag
 * interaction's ids stay inside its own context/SortableContext.
 */
export function TableBlock({ table, locked, muted, onChange }: TableBlockProps) {
  const canRemoveRow = table.rows.length > 1;
  const canRemoveCol = table.columnIds.length > 1;

  const rowSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const colSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const handleResizeColumn = useCallback(
    (index: number, width: number) => onChange((t) => setColWidth(t, index, width)),
    [onChange],
  );
  const handleRemoveColumn = useCallback(
    (index: number) => onChange((t) => removeColumn(t, index)),
    [onChange],
  );
  const handleInsertColumn = useCallback(
    (index: number) => onChange((t) => insertColumn(t, index)),
    [onChange],
  );
  const handleRemoveRow = useCallback((rowId: string) => onChange((t) => removeRow(t, rowId)), [onChange]);
  const handleInsertRow = useCallback((index: number) => onChange((t) => insertRow(t, index)), [onChange]);
  const handleCellBlur = useCallback(
    (rowId: string, colIndex: number, value: string) => onChange((t) => setCell(t, rowId, colIndex, value)),
    [onChange],
  );

  const handleRowDragEnd = useCallback(
    (e: DragEndEvent) => {
      const { active, over } = e;
      if (!over || active.id === over.id) return;
      onChange((t) => moveRow(t, String(active.id), String(over.id)));
    },
    [onChange],
  );
  const handleColDragEnd = useCallback(
    (e: DragEndEvent) => {
      const { active, over } = e;
      if (!over || active.id === over.id) return;
      onChange((t) => moveColumn(t, String(active.id), String(over.id)));
    },
    [onChange],
  );

  return (
    <div contentEditable={false} className={cn("my-6", muted && "opacity-70")}>
      <div className="inline-block max-w-full overflow-x-auto rounded-[3px] border border-line bg-white align-top scrollbar-thin">
        <DndContext sensors={colSensors} collisionDetection={closestCenter} onDragEnd={handleColDragEnd}>
          <div className="flex">
            <div className="w-6 shrink-0 border-b border-line bg-surface-muted" />
            <SortableContext items={table.columnIds} strategy={horizontalListSortingStrategy}>
              {table.columnIds.map((colId, i) => (
                <ColumnHeader
                  key={colId}
                  colId={colId}
                  index={i}
                  width={table.colWidths[i]}
                  locked={locked}
                  canRemove={canRemoveCol}
                  onResize={(w) => handleResizeColumn(i, w)}
                  onRemove={() => handleRemoveColumn(i)}
                />
              ))}
            </SortableContext>
            {!locked && (
              <button
                type="button"
                title="Add column"
                onClick={() => handleInsertColumn(table.columnIds.length)}
                className="flex w-6 shrink-0 items-center justify-center border-b border-line text-ink-300 hover:bg-surface-muted hover:text-brand-600"
              >
                <Plus size={12} />
              </button>
            )}
          </div>
        </DndContext>

        <DndContext sensors={rowSensors} collisionDetection={closestCenter} onDragEnd={handleRowDragEnd}>
          <SortableContext items={table.rows.map((r) => r.id)} strategy={verticalListSortingStrategy}>
            {table.rows.map((row) => (
              <TableRowView
                key={row.id}
                row={row}
                colWidths={table.colWidths}
                locked={locked}
                muted={muted}
                canRemove={canRemoveRow}
                onRemove={handleRemoveRow}
                onCellBlur={handleCellBlur}
              />
            ))}
          </SortableContext>
        </DndContext>

        {!locked && (
          <button
            type="button"
            onClick={() => handleInsertRow(table.rows.length)}
            className="flex w-full items-center justify-center gap-1 border-t border-line py-1 text-[0.6875rem] font-medium text-ink-400 hover:bg-surface-muted hover:text-brand-600"
          >
            <Plus size={11} /> Add row
          </button>
        )}
      </div>
    </div>
  );
}
