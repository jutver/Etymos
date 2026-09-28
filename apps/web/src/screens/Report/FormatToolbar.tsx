import { useEffect, useLayoutEffect, useRef, useState, forwardRef } from "react";
import { createPortal } from "react-dom";
import {
  ArrowUUpLeft,
  ArrowUUpRight,
  Eraser,
  Eye,
  EyeSlash,
  FileText,
  LinkSimple,
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
  X,
} from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import { t, tr } from "../../lib/i18n";

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

/** Inserts a hyperlink around the current selection, or unlinks if the
 * selection is already inside one — a bare `window.prompt` is the simplest
 * dependency-free way to collect the URL without a whole popover component. */
function toggleLink() {
  const selection = window.getSelection();
  const anchor = selection?.anchorNode?.parentElement?.closest("a");
  if (anchor) {
    exec("unlink");
    return;
  }
  const url = window.prompt(t("Link URL"));
  if (url) exec("createLink", url);
}

const TEXT_COLORS = [
  { label: tr("Default"), value: "#1a2233" },
  { label: tr("Blue"), value: "#1e4fc4" },
  { label: tr("Red"), value: "#dc2626" },
  { label: tr("Amber"), value: "#b45309" },
  { label: tr("Green"), value: "#059669" },
  { label: tr("Violet"), value: "#7c3aed" },
];

const ToolButton = forwardRef<
  HTMLButtonElement,
  {
    label: string;
    onAction: () => void;
    children: React.ReactNode;
    active?: boolean;
  }
>(function ToolButton({ label, onAction, children, active = false }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      title={t(label)}
      aria-label={t(label)}
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
});

/**
 * Portal-based dropdown anchored to a trigger element's on-screen position.
 *
 * The toolbar's root container sets `overflow-x-auto` (for horizontal
 * scrolling when it overflows the viewport), which per the CSS overflow
 * spec forces the other axis to `overflow-y: auto` too — clipping any
 * `absolute`-positioned descendant popup to the toolbar's own pill-shaped
 * bounds. Rendering into `document.body` via a portal with `position:
 * fixed` escapes that ancestor clipping entirely (same technique as
 * `ui/ContextMenu.tsx`, but anchored to a trigger button's rect —
 * horizontally centered underneath — rather than a cursor point, and
 * self-measuring so it clamps against its own actual size instead of an
 * assumed menu size).
 */
function ToolbarDropdown({
  open,
  onClose,
  anchorRef,
  children,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; ready: boolean }>({
    left: 0,
    top: 0,
    ready: false,
  });

  useLayoutEffect(() => {
    if (!open) {
      setPos((p) => (p.ready ? { ...p, ready: false } : p));
      return;
    }
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const anchorRect = anchor.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const center = anchorRect.left + anchorRect.width / 2;
    const left = Math.min(
      Math.max(8, center - panelRect.width / 2),
      window.innerWidth - panelRect.width - 8,
    );
    const top = Math.min(anchorRect.bottom + 8, window.innerHeight - panelRect.height - 8);
    setPos({ left, top, ready: true });
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open, onClose, anchorRef]);

  if (!open) return null;

  return createPortal(
    <div
      ref={panelRef}
      style={{ position: "fixed", left: pos.left, top: pos.top, visibility: pos.ready ? "visible" : "hidden" }}
      className="z-50"
      onMouseDown={(e) => e.preventDefault()}
    >
      {children}
    </div>,
    document.body,
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
  /** Plagiarism highlights on/off in the Document view. The switch only
   * renders when `onToggleHighlights` is provided and the Document view is
   * showing (the Original view has its own highlight layer). */
  showHighlights?: boolean;
  onToggleHighlights?: () => void;
  /** A single source is focused (only its highlight is shown). Renders a
   * "Show all" button that calls `onClearFocus`. */
  focusActive?: boolean;
  onClearFocus?: () => void;
  /** Inserts a new table block after the currently-focused block — a
   * structural document edit, so it goes through the canvas's imperative
   * handle rather than `document.execCommand` (see DocumentCanvas.tsx's
   * `DocumentCanvasHandle`). */
  onInsertTable: () => void;
}

export function FormatToolbar({
  locked,
  onRequestUnlock,
  hasOriginal,
  view,
  onViewChange,
  showHighlights = true,
  onToggleHighlights,
  focusActive = false,
  onClearFocus,
  onInsertTable,
}: FormatToolbarProps) {
  const [colorOpen, setColorOpen] = useState(false);
  const colorButtonRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center px-4">
      <div
        role="toolbar"
        aria-label={t("Document formatting")}
        aria-controls="report-document-editor"
        className="pointer-events-auto flex max-w-full items-center gap-0.5 overflow-x-auto scrollbar-thin rounded-xl border border-line/80 bg-white/95 px-2 py-1.5 shadow-[var(--shadow-card)] backdrop-blur-md"
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
                  {v === "document" ? t("Document") : t("Original")}
                </button>
              ))}
            </div>
            <Divider />
          </>
        )}

        {view === "document" && onToggleHighlights && (
          <>
            <button
              type="button"
              role="switch"
              aria-checked={showHighlights}
              onClick={onToggleHighlights}
              title={showHighlights ? t("Hide plagiarism highlights") : t("Show plagiarism highlights")}
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold transition-colors",
                showHighlights
                  ? "bg-severity-high-bg text-severity-high hover:brightness-95"
                  : "text-ink-500 hover:bg-surface-muted hover:text-ink-900",
              )}
            >
              {showHighlights ? <Eye size={14} weight="bold" /> : <EyeSlash size={14} weight="bold" />}
              {t("Plagiarism")}</button>
            {focusActive && onClearFocus && (
              <button
                type="button"
                onClick={onClearFocus}
                title={t("Show every highlight again (Esc)")}
                className="ml-0.5 flex shrink-0 items-center gap-1 rounded-full bg-surface-muted px-2.5 py-1 text-xs font-semibold text-ink-700 transition-colors hover:bg-line hover:text-ink-900"
              >
                {t("Showing 1 source · Show all")}<X size={12} weight="bold" />
              </button>
            )}
            <Divider />
          </>
        )}

        {view === "original" ? (
          <span className="flex items-center gap-1.5 px-2 text-xs font-medium text-ink-500">
            <FileText size={14} />{" "}{t("Viewing the uploaded file")}</span>
        ) : locked ? (
          <button
            type="button"
            onClick={onRequestUnlock}
            className="flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold text-ink-500 transition-colors hover:bg-surface-muted hover:text-ink-900"
          >
            <LockSimple size={14} weight="fill" />
            {t("Reading mode — unlock to edit")}</button>
        ) : (
          <>
            <ToolButton label={t("Undo")} onAction={() => exec("undo")}>
              <ArrowUUpLeft size={16} />
            </ToolButton>
            <ToolButton label={t("Redo")} onAction={() => exec("redo")}>
              <ArrowUUpRight size={16} />
            </ToolButton>

            <Divider />

            <select
              aria-label={t("Paragraph style")}
              defaultValue="p"
              onMouseDown={(e) => e.stopPropagation()}
              onChange={(e) => {
                exec("formatBlock", e.target.value);
                e.target.blur();
              }}
              className="h-8 rounded-lg bg-transparent px-1.5 text-xs font-medium text-ink-700 outline-none hover:bg-surface-muted"
            >
              <option value="p">{t("Body")}</option>
              <option value="h1">{t("Heading 1")}</option>
              <option value="h2">{t("Heading 2")}</option>
              <option value="h3">{t("Heading 3")}</option>
              <option value="blockquote">{t("Quote")}</option>
            </select>

            <Divider />

            <ToolButton label={t("Bold")} onAction={() => exec("bold")}>
              <TextB size={16} weight="bold" />
            </ToolButton>
            <ToolButton label={t("Italic")} onAction={() => exec("italic")}>
              <TextItalic size={16} />
            </ToolButton>
            <ToolButton label={t("Underline")} onAction={() => exec("underline")}>
              <TextUnderline size={16} />
            </ToolButton>
            <ToolButton label={t("Strikethrough")} onAction={() => exec("strikeThrough")}>
              <TextStrikethrough size={16} />
            </ToolButton>

            <ToolButton
              ref={colorButtonRef}
              label={t("Text colour")}
              active={colorOpen}
              onAction={() => setColorOpen((v) => !v)}
            >
              <PaintBucket size={16} />
            </ToolButton>
            <ToolbarDropdown open={colorOpen} onClose={() => setColorOpen(false)} anchorRef={colorButtonRef}>
              <div className="flex gap-1 rounded-[var(--radius-input)] border border-line bg-white p-1.5 shadow-[var(--shadow-pop)]">
                {TEXT_COLORS.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    title={t(c.label)}
                    aria-label={t("Text colour {{label}}", { label: c.label })}
                    onClick={() => {
                      exec("foreColor", c.value);
                      setColorOpen(false);
                    }}
                    className="size-6 rounded-full border border-line/70 transition-transform hover:scale-110"
                    style={{ backgroundColor: c.value }}
                  />
                ))}
              </div>
            </ToolbarDropdown>

            <Divider />

            <ToolButton label={t("Align left")} onAction={() => exec("justifyLeft")}>
              <TextAlignLeft size={16} />
            </ToolButton>
            <ToolButton label={t("Align centre")} onAction={() => exec("justifyCenter")}>
              <TextAlignCenter size={16} />
            </ToolButton>
            <ToolButton label={t("Align right")} onAction={() => exec("justifyRight")}>
              <TextAlignRight size={16} />
            </ToolButton>
            <ToolButton label={t("Justify")} onAction={() => exec("justifyFull")}>
              <TextAlignJustify size={16} />
            </ToolButton>

            <Divider />

            <ToolButton label={t("Bulleted list")} onAction={() => exec("insertUnorderedList")}>
              <ListBullets size={16} />
            </ToolButton>
            <ToolButton label={t("Numbered list")} onAction={() => exec("insertOrderedList")}>
              <ListNumbers size={16} />
            </ToolButton>

            <Divider />

            <ToolButton label={t("Insert link")} onAction={toggleLink}>
              <LinkSimple size={16} />
            </ToolButton>
            <ToolButton label={t("Clear formatting")} onAction={() => exec("removeFormat")}>
              <Eraser size={16} />
            </ToolButton>

            <Divider />

            <ToolButton label={t("Insert table")} onAction={onInsertTable}>
              <Table size={16} />
            </ToolButton>
          </>
        )}
      </div>
    </div>
  );
}
