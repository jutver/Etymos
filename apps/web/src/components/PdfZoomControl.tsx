import { useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, MotionConfig, m } from "motion/react";
import { CaretUp, Check } from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import { t } from "../lib/i18n";

export const PDF_ZOOM_PRESETS = [50, 75, 100, 125, 150, 175, 200] as const;
export const PDF_ZOOM_MIN_PERCENT = 25;
export const PDF_ZOOM_MAX_PERCENT = 300;
const PDF_ZOOM_STOPS = [25, 50, 75, 100, 125, 150, 175, 200, 225, 250, 275, 300] as const;

export function clampZoomPercent(value: number): number {
  return Math.max(PDF_ZOOM_MIN_PERCENT, Math.min(PDF_ZOOM_MAX_PERCENT, Math.round(value)));
}

export function parseZoomPercent(raw: string): number | null {
  const cleaned = raw.trim().replace(/%+$/g, "").trim();
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return clampZoomPercent(parsed);
}

export function stepZoomPercent(currentPercent: number, direction: "in" | "out"): number {
  if (direction === "in") {
    for (const stop of PDF_ZOOM_STOPS) {
      if (stop > currentPercent) return stop;
    }
    return PDF_ZOOM_MAX_PERCENT;
  }
  for (let i = PDF_ZOOM_STOPS.length - 1; i >= 0; i -= 1) {
    if (PDF_ZOOM_STOPS[i]! < currentPercent) return PDF_ZOOM_STOPS[i]!;
  }
  return PDF_ZOOM_MIN_PERCENT;
}

export interface PdfZoomControlProps {
  percent: number;
  onChangePercent: (nextPercent: number) => void;
  defaultOpen?: boolean;
}

export function PdfZoomControl({
  percent,
  onChangePercent,
  defaultOpen = false,
}: PdfZoomControlProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [focused, setFocused] = useState(false);
  const [inputValue, setInputValue] = useState(() => String(percent));
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const skipNextBlurCommitRef = useRef(false);
  const listboxId = useId();

  useEffect(() => {
    if (!focused) setInputValue(String(percent));
  }, [percent, focused]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setInputValue(String(percent));
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, percent]);

  function commitInput() {
    const parsed = parseZoomPercent(inputValue);
    if (parsed !== null) {
      setInputValue(String(parsed));
      onChangePercent(parsed);
    } else {
      setInputValue(String(percent));
    }
  }

  function applyPreset(preset: number) {
    skipNextBlurCommitRef.current = true;
    setInputValue(String(preset));
    onChangePercent(preset);
    setOpen(false);
    inputRef.current?.blur();
  }

  return (
    <div ref={wrapRef} className="relative inline-flex items-center">
      <div
        className={cn(
          "flex h-6 items-center rounded-md border bg-surface-tint pl-1 pr-0.5 text-xs font-semibold tabular-nums text-ink-800 transition-colors",
          focused || open ? "border-brand-400" : "border-line/80",
        )}
      >
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          role="combobox"
          value={inputValue}
          aria-label={t("Zoom level")}
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          aria-autocomplete="list"
          onFocus={(e) => {
            setFocused(true);
            setOpen(true);
            setInputValue(String(percent));
            e.currentTarget.select();
          }}
          onChange={(e) => {
            setInputValue(e.target.value.replace(/\D/g, "").slice(0, 3));
          }}
          onBlur={() => {
            setFocused(false);
            if (skipNextBlurCommitRef.current) {
              skipNextBlurCommitRef.current = false;
            } else {
              commitInput();
            }
            setOpen(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              skipNextBlurCommitRef.current = true;
              commitInput();
              setOpen(false);
              inputRef.current?.blur();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              skipNextBlurCommitRef.current = true;
              setInputValue(String(percent));
              setOpen(false);
              inputRef.current?.blur();
            }
          }}
          className="w-7 bg-transparent text-right text-xs font-semibold tabular-nums text-ink-800 outline-none"
        />
        <span aria-hidden="true" className="text-[11px] font-semibold text-ink-500">
          %
        </span>
        <button
          type="button"
          tabIndex={-1}
          aria-label={t("Zoom presets")}
          aria-expanded={open}
          onMouseDown={(e) => {
            e.preventDefault();
            setOpen((v) => !v);
          }}
          className="ml-0.5 flex size-4 items-center justify-center rounded text-ink-500 transition-colors hover:bg-surface-muted hover:text-ink-900"
        >
          <CaretUp
            size={10}
            weight="bold"
            aria-hidden="true"
            className={cn("transition-transform duration-150", !open && "rotate-180")}
          />
        </button>
      </div>

      <MotionConfig reducedMotion="user">
        <div className="pointer-events-none absolute bottom-[calc(100%+8px)] left-1/2 z-30 -translate-x-1/2">
          <AnimatePresence>
            {open && (
              <m.div
                id={listboxId}
                role="listbox"
                aria-label={t("Zoom presets")}
                initial={{ opacity: 0, scale: 0.96, y: 6 }}
                animate={{ opacity: 1, scale: 1, y: 0, transition: { duration: 0.16, ease: [0.22, 1, 0.36, 1] } }}
                exit={{ opacity: 0, scale: 0.97, y: 4, transition: { duration: 0.12, ease: "easeIn" } }}
                style={{ transformOrigin: "bottom center" }}
                className="pointer-events-auto w-28 rounded-[var(--radius-card)] border border-line bg-white p-1 shadow-[var(--shadow-pop)]"
              >
                {PDF_ZOOM_PRESETS.map((preset) => {
                  const selected = percent === preset;
                  return (
                    <button
                      key={preset}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => applyPreset(preset)}
                      className={cn(
                        "flex w-full items-center justify-between rounded-[var(--radius-input)] px-2.5 py-1.5 text-left text-xs tabular-nums transition-colors",
                        selected
                          ? "bg-brand-100 font-semibold text-brand-700"
                          : "font-medium text-ink-700 hover:bg-surface-muted hover:text-ink-900",
                      )}
                    >
                      <span>{preset}%</span>
                      {selected && <Check size={12} weight="bold" aria-hidden="true" />}
                    </button>
                  );
                })}
              </m.div>
            )}
          </AnimatePresence>
        </div>
      </MotionConfig>
    </div>
  );
}
