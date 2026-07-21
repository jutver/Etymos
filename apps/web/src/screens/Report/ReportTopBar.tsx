import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowsClockwise,
  ClockCounterClockwise,
  DownloadSimple,
  FloppyDisk,
  House,
  LockSimple,
  LockSimpleOpen,
} from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import { LogoMark } from "../../components/layout/Logo";
import { Button } from "../../components/ui/Button";
import { VersionHistoryMenu, type DocumentVersion } from "./VersionHistoryMenu";

/** Icon-only control used across the right-hand side of the bar. */
function BarIconButton({
  label,
  active = false,
  onClick,
  children,
  ...rest
}: {
  label: string;
  active?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "children">) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "flex size-9 items-center justify-center rounded-[var(--radius-input)] transition-colors",
        active
          ? "bg-brand-100 text-brand-600"
          : "text-ink-500 hover:bg-surface-muted hover:text-ink-900",
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/**
 * Logo that morphs into a house on hover/focus and takes the user back to
 * Upload — the "leave the document" affordance, exactly where Word and
 * Grammarly put it.
 */
function HomeLogoButton({ onGoHome }: { onGoHome: () => void }) {
  const [hovered, setHovered] = useState(false);

  return (
    <button
      type="button"
      onClick={onGoHome}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      aria-label="Back to Upload"
      title="Back to Upload"
      className="group flex shrink-0 items-center gap-2 rounded-[var(--radius-input)] p-1 transition-colors hover:bg-surface-muted"
    >
      <span className="relative flex size-8 items-center justify-center">
        <span
          className={cn(
            "absolute inset-0 flex items-center justify-center transition-opacity duration-150",
            hovered ? "opacity-0" : "opacity-100",
          )}
        >
          <LogoMark size={32} />
        </span>
        <span
          aria-hidden="true"
          className={cn(
            "absolute inset-0 flex items-center justify-center rounded-[10px] bg-navy-900 text-white transition-opacity duration-150",
            hovered ? "opacity-100" : "opacity-0",
          )}
        >
          <House size={17} weight="fill" />
        </span>
      </span>
    </button>
  );
}

/** Click-to-rename document title. Enter commits, Escape reverts. */
function FileNameField({
  value,
  onCommit,
  disabled,
}: {
  value: string;
  onCommit: (next: string) => void;
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useLayoutEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  function commit() {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== value) onCommit(next);
    else setDraft(value);
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        aria-label="Document name"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setDraft(value);
            setEditing(false);
          }
        }}
        className="min-w-0 max-w-[22rem] flex-1 rounded-[var(--radius-input)] border border-brand-400 bg-white px-2 py-1 text-sm font-semibold text-ink-900 outline-none"
      />
    );
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => setEditing(true)}
      title="Rename document"
      className="min-w-0 truncate rounded-[var(--radius-input)] px-2 py-1 text-sm font-semibold text-ink-900 transition-colors hover:bg-surface-muted disabled:pointer-events-none"
    >
      {value}
      <span className="sr-only"> — click to rename</span>
    </button>
  );
}

export interface ReportTopBarProps {
  fileName: string;
  onRename: (next: string) => void;
  onGoHome: () => void;
  locked: boolean;
  onToggleLock: () => void;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  versions: DocumentVersion[];
  onRestoreVersion: (version: DocumentVersion) => void;
  rechecking: boolean;
  onRecheck: () => void;
  exporting: boolean;
  onExport: () => void;
  exportLocked: boolean;
  /** Rendered at the far left of the right-hand cluster (similarity chip). */
  scoreSlot?: React.ReactNode;
}

export function ReportTopBar({
  fileName,
  onRename,
  onGoHome,
  locked,
  onToggleLock,
  dirty,
  saving,
  onSave,
  versions,
  onRestoreVersion,
  rechecking,
  onRecheck,
  exporting,
  onExport,
  exportLocked,
  scoreSlot,
}: ReportTopBarProps) {
  return (
    <header className="z-20 shrink-0 border-b border-line/70 bg-white/85 backdrop-blur-md">
      <div className="flex h-14 items-center gap-1 px-3 sm:px-4">
        <HomeLogoButton onGoHome={onGoHome} />
        <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-line" />
        <FileNameField value={fileName} onCommit={onRename} />

        <div className="ml-auto flex shrink-0 items-center gap-1">
          {scoreSlot}

          <span aria-hidden="true" className="mx-1 hidden h-5 w-px bg-line sm:block" />

          <VersionHistoryMenu versions={versions} onRestore={onRestoreVersion}>
            {(toggle, open) => (
              <BarIconButton
                label="Version history"
                active={open}
                onClick={toggle}
                aria-haspopup="menu"
                aria-expanded={open}
              >
                <ClockCounterClockwise size={18} />
              </BarIconButton>
            )}
          </VersionHistoryMenu>

          <BarIconButton
            label={locked ? "Unlock editing" : "Lock editing"}
            active={!locked}
            onClick={onToggleLock}
            aria-pressed={!locked}
          >
            {locked ? <LockSimple size={18} weight="fill" /> : <LockSimpleOpen size={18} />}
          </BarIconButton>

          <BarIconButton label={rechecking ? "Rechecking…" : "Recheck document"} onClick={onRecheck}>
            <ArrowsClockwise size={18} className={cn(rechecking && "animate-spin motion-reduce:animate-none")} />
          </BarIconButton>

          <BarIconButton
            label={exportLocked ? "Export PDF (upgrade required)" : "Export PDF"}
            onClick={onExport}
          >
            {exporting ? (
              <DownloadSimple size={18} className="animate-pulse motion-reduce:animate-none" />
            ) : exportLocked ? (
              <LockSimple size={17} weight="fill" />
            ) : (
              <DownloadSimple size={18} />
            )}
          </BarIconButton>

          <Button
            size="sm"
            variant={dirty ? "primary" : "outline"}
            loading={saving}
            onClick={onSave}
            disabled={!dirty && !saving}
            iconLeft={<FloppyDisk size={15} weight={dirty ? "fill" : "regular"} />}
            className="ml-1"
          >
            {dirty ? "Save" : "Saved"}
          </Button>
        </div>
      </div>
    </header>
  );
}
