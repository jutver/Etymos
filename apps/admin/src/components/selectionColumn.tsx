import type { Column } from "./DataTable";
import { t, tr } from "../lib/i18n";

const BOX = "size-4 cursor-pointer accent-accent";

/** A checkbox column for picking rows to act on, with a header box that
 * selects or clears every row on the current page. */
export function selectionColumn<T>(
  rows: T[],
  rowKey: (row: T) => string,
  selected: Set<string>,
  onChange: (next: Set<string>) => void,
): Column<T> {
  const pageKeys = rows.map(rowKey);
  const allPicked = pageKeys.length > 0 && pageKeys.every((k) => selected.has(k));
  return {
    key: "select",
    label: tr("Select"),
    className: "w-10",
    header: (
      <input
        type="checkbox"
        aria-label={t("Select all on this page")}
        checked={allPicked}
        onChange={() => {
          const next = new Set(selected);
          for (const k of pageKeys) {
            if (allPicked) next.delete(k);
            else next.add(k);
          }
          onChange(next);
        }}
        className={BOX}
      />
    ),
    render: (row) => {
      const key = rowKey(row);
      return (
        <input
          type="checkbox"
          aria-label={t("Select")}
          checked={selected.has(key)}
          // Rows that open on click mustn't open when the box is ticked.
          onClick={(e) => e.stopPropagation()}
          onChange={() => {
            const next = new Set(selected);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            onChange(next);
          }}
          className={BOX}
        />
      );
    },
  };
}
