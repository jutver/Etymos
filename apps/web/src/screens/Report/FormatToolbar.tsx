import { useState } from "react";
import {
  ArrowUUpLeft,
  ArrowUUpRight,
  Columns,
  FileText,
  ListBullets,
  ListNumbers,
  LockSimple,
  PaintBucket,
  Table,
  TextAlignCenter,
  TextAlignJustify,
  TextAlignLeft,
  TextAlignRight,
  TextB,
  TextItalic,
  TextStrikethrough,
  TextUnderline,
} from "@phosphor-icons/react";
import { cn } from "@etymos/shared";

/**
 * Rich-text commands run through `document.execCommand`.
 *
 * It is formally deprecated but remains the only dependency-free way to apply
 * inline formatting to a `contenteditable` region, and it is what every
 * browser still ships. Isolated here so swapping in a real editor engine
 * (Lexical/ProseMirror) later means rewriting one file.
 */
function exec(command: string, value?: string) {
  document.execCommand(command, false, value);
}

/**
 * Table/column insertion goes through `insertHTML` rather than a dedicated
 * execCommand (browsers don't have one) — DocumentCanvas's `[&_table]`/
 * `[&_td]` descendant selectors style whatever lands here, so no inline
 * styling is needed on the inserted markup itself.
 */
function insertTable(rows: number, cols: number) {
  const cells = Array.from({ length: cols }, () => "<td><br></td>").join("");
  const body = Array.from({ length: rows }, () => `<tr>${cells}</tr>`).join("");
  exec("insertHTML", `<table><tbody>${body}</tbody></table><p><br></p>`);
}

/** Inserts an empty CSS-columns section for 2- or 3-column layout — manual
 * authoring, not automatic detection: the backend does not attempt to infer
 * multi-column layout from an uploaded PDF (see extractor.py), so this is
 * the toolbar's own way to add one, matching what a user could do in
 * Google Docs' "Columns" menu. */
function insertColumns(count: 2 | 3) {
  exec(
    "insertHTML",
    `<div style="column-count:${count};column-gap:2rem;" class="my-5"><p>Column text…</p></div><p><br></p>`,
  );
}

const TEXT_COLORS = [
  { label: "Default", value: "#1a2233" },
  { label: "Blue", value: "#1e4fc4" },
  { label: "Red", value: "#dc2626" },
  { label: "Amber", value: "#b45309" },
  { label: "Green", value: "#059669" },
  { label: "Violet", value: "#7c3aed" },
];

function ToolButton({
  label,
  onAction,
  children,
  active = false,
}: {
  label: string;
  onAction: () => void;
  children: React.ReactNode;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      // Keeps the caret/selection in the document while the command runs —
      // the toolbar never steals focus, so it can never trap it either.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onAction}
      className={cn(
        "flex size-8 items-center justify-center rounded-lg text-ink-700 transition-colors hover:bg-surface-muted hover:text-ink-900",
        active && "bg-brand-100 text-brand-600",
      )}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-line" />;
}

export interface FormatToolbarProps {
  locked: boolean;
  onRequestUnlock: () => void;
  /** Only rendered when the document actually has an original PDF to show. */
  hasOriginal: boolean;
  view: "document" | "original";
  onViewChange: (view: "document" | "original") => void;
}

export function FormatToolbar({
  locked,
  onRequestUnlock,
  hasOriginal,
  view,
  onViewChange,
}: FormatToolbarProps) {
  const [colorOpen, setColorOpen] = useState(false);
  const [columnsOpen, setColumnsOpen] = useState(false);

  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center px-4">
      <div
        role="toolbar"
        aria-label="Document formatting"
        aria-controls="report-document-editor"
        className="pointer-events-auto flex max-w-full items-center gap-0.5 overflow-x-auto scrollbar-thin rounded-full border border-line/80 bg-white/90 px-2 py-1.5 shadow-[var(--shadow-card)] backdrop-blur-md"
      >
        {hasOriginal && (
          <>
            <div className="flex items-center rounded-full bg-surface-muted p-0.5">
              {(["document", "original"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => onViewChange(v)}
                  aria-pressed={view === v}
                  className={cn(
                    "rounded-full px-3 py-1 text-xs font-semibold transition-colors",
                    view === v ? "bg-white text-ink-900 shadow-sm" : "text-ink-500 hover:text-ink-900",
                  )}
                >
                  {v === "document" ? "Document" : "Original"}
                </button>
              ))}
            </div>
            <Divider />
          </>
        )}

        {view === "original" ? (
          <span className="flex items-center gap-1.5 px-2 text-xs font-medium text-ink-500">
            <FileText size={14} /> Viewing the uploaded file
          </span>
        ) : locked ? (
          <button
            type="button"
            onClick={onRequestUnlock}
            className="flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold text-ink-500 transition-colors hover:bg-surface-muted hover:text-ink-900"
          >
            <LockSimple size={14} weight="fill" />
            Reading mode — unlock to edit
          </button>
        ) : (
          <>
            <ToolButton label="Undo" onAction={() => exec("undo")}>
              <ArrowUUpLeft size={16} />
            </ToolButton>
            <ToolButton label="Redo" onAction={() => exec("redo")}>
              <ArrowUUpRight size={16} />
            </ToolButton>

            <Divider />

            <select
              aria-label="Paragraph style"
              defaultValue="p"
              onMouseDown={(e) => e.stopPropagation()}
              onChange={(e) => {
                exec("formatBlock", e.target.value);
                e.target.blur();
              }}
              className="h-8 rounded-lg bg-transparent px-1.5 text-xs font-medium text-ink-700 outline-none hover:bg-surface-muted"
            >
              <option value="p">Body</option>
              <option value="h1">Heading 1</option>
              <option value="h2">Heading 2</option>
              <option value="h3">Heading 3</option>
              <option value="blockquote">Quote</option>
            </select>

            <Divider />

            <ToolButton label="Bold" onAction={() => exec("bold")}>
              <TextB size={16} weight="bold" />
            </ToolButton>
            <ToolButton label="Italic" onAction={() => exec("italic")}>
              <TextItalic size={16} />
            </ToolButton>
            <ToolButton label="Underline" onAction={() => exec("underline")}>
              <TextUnderline size={16} />
            </ToolButton>
            <ToolButton label="Strikethrough" onAction={() => exec("strikeThrough")}>
              <TextStrikethrough size={16} />
            </ToolButton>

            <div className="relative">
              <ToolButton
                label="Text colour"
                active={colorOpen}
                onAction={() => setColorOpen((v) => !v)}
              >
                <PaintBucket size={16} />
              </ToolButton>
              {colorOpen && (
                <div
                  className="absolute left-1/2 top-[calc(100%+8px)] z-20 flex -translate-x-1/2 gap-1 rounded-[var(--radius-input)] border border-line bg-white p-1.5 shadow-[var(--shadow-pop)]"
                  onMouseDown={(e) => e.preventDefault()}
                >
                  {TEXT_COLORS.map((c) => (
                    <button
                      key={c.value}
                      type="button"
                      title={c.label}
                      aria-label={`Text colour ${c.label}`}
                      onClick={() => {
                        exec("foreColor", c.value);
                        setColorOpen(false);
                      }}
                      className="size-6 rounded-full border border-line/70 transition-transform hover:scale-110"
                      style={{ backgroundColor: c.value }}
                    />
                  ))}
                </div>
              )}
            </div>

            <Divider />

            <ToolButton label="Align left" onAction={() => exec("justifyLeft")}>
              <TextAlignLeft size={16} />
            </ToolButton>
            <ToolButton label="Align centre" onAction={() => exec("justifyCenter")}>
              <TextAlignCenter size={16} />
            </ToolButton>
            <ToolButton label="Align right" onAction={() => exec("justifyRight")}>
              <TextAlignRight size={16} />
            </ToolButton>
            <ToolButton label="Justify" onAction={() => exec("justifyFull")}>
              <TextAlignJustify size={16} />
            </ToolButton>

            <Divider />

            <ToolButton label="Bulleted list" onAction={() => exec("insertUnorderedList")}>
              <ListBullets size={16} />
            </ToolButton>
            <ToolButton label="Numbered list" onAction={() => exec("insertOrderedList")}>
              <ListNumbers size={16} />
            </ToolButton>

            <Divider />

            <ToolButton label="Insert table" onAction={() => insertTable(3, 3)}>
              <Table size={16} />
            </ToolButton>

            <div className="relative">
              <ToolButton
                label="Columns"
                active={columnsOpen}
                onAction={() => setColumnsOpen((v) => !v)}
              >
                <Columns size={16} />
              </ToolButton>
              {columnsOpen && (
                <div
                  className="absolute left-1/2 top-[calc(100%+8px)] z-20 flex -translate-x-1/2 flex-col gap-0.5 rounded-[var(--radius-input)] border border-line bg-white p-1 shadow-[var(--shadow-pop)]"
                  onMouseDown={(e) => e.preventDefault()}
                >
                  <button
                    type="button"
                    onClick={() => {
                      insertColumns(2);
                      setColumnsOpen(false);
                    }}
                    className="whitespace-nowrap rounded-md px-3 py-1.5 text-left text-xs font-medium text-ink-700 hover:bg-surface-muted"
                  >
                    Two columns
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      insertColumns(3);
                      setColumnsOpen(false);
                    }}
                    className="whitespace-nowrap rounded-md px-3 py-1.5 text-left text-xs font-medium text-ink-700 hover:bg-surface-muted"
                  >
                    Three columns
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
