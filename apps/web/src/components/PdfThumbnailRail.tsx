import { memo, useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, MotionConfig, m } from "motion/react";
import { cn } from "@etymos/shared";
import type { PdfProxy } from "./PlagiarismPdfViewer";
import { PillIndicator, usePill } from "./ui/PillIndicator";
import { t } from "../lib/i18n";

const THUMB_WIDTH = 112;
const RAIL_WIDTH = 160;
const MAX_THUMB_CACHE = 40;
const EMPTY_DOTS: string[] = [];
const OPEN_EASE = [0.22, 1, 0.36, 1] as const;
const CLOSE_EASE = [0.4, 0, 0.2, 1] as const;
const THUMB_REVEAL_TRANSITION = { duration: 0.22, ease: OPEN_EASE } as const;

export interface PdfThumbnailRailProps {
  pdf: PdfProxy | null;
  numPages: number;
  currentPage: number;
  open: boolean;
  onSelectPage: (page: number) => void;
  /** Tailwind swatch class names (up to 3) per 1-based page number. */
  pageIndicatorClasses?: Map<number, string[]>;
  /** Pages flagged by AI detection when viewing the AI sidebar tab. */
  aiPages?: Set<number>;
  pageSizes?: Map<number, { width: number; height: number }>;
  defaultPageAspect?: number;
  pixelRatio?: number;
}

const ThumbnailTile = memo(function ThumbnailTile({
  pageNumber,
  aspect,
  isActive,
  thumbUrl,
  dots,
  hasAi,
  enterDelay,
  onSelectPage,
  setTileRef,
}: {
  pageNumber: number;
  aspect: number;
  isActive: boolean;
  thumbUrl: string | undefined;
  dots: string[];
  hasAi: boolean;
  enterDelay: number;
  onSelectPage: (page: number) => void;
  setTileRef: (page: number, el: HTMLButtonElement | null) => void;
}) {
  const thumbHeight = Math.round(THUMB_WIDTH * aspect);
  return (
    <m.button
      ref={(el) => setTileRef(pageNumber, el)}
      data-thumb-page={pageNumber}
      data-pill-active={isActive ? "true" : undefined}
      type="button"
      onClick={() => onSelectPage(pageNumber)}
      aria-current={isActive ? "page" : undefined}
      aria-label={t("Page {{page}}", { page: pageNumber })}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, delay: enterDelay, ease: OPEN_EASE }}
      className={cn(
        "group relative z-10 flex w-full flex-col items-center gap-1.5 rounded-[var(--radius-control)] p-1.5 transition-colors duration-200",
        !isActive && "hover:bg-surface-muted/80",
      )}
    >
      <div
        className={cn(
          "relative overflow-hidden rounded-[3px] border bg-white shadow-xs transition-[transform,border-color,box-shadow] duration-200 ease-out group-hover:-translate-y-0.5 group-hover:shadow-sm group-active:scale-[0.97] motion-reduce:transition-none motion-reduce:transform-none",
          isActive
            ? "border-brand-500 ring-2 ring-brand-500/30 shadow-sm"
            : "border-line group-hover:border-ink-300",
        )}
        style={{ width: THUMB_WIDTH, height: thumbHeight }}
      >
        {thumbUrl ? (
          <m.img
            key={thumbUrl}
            src={thumbUrl}
            alt=""
            width={THUMB_WIDTH}
            height={thumbHeight}
            decoding="async"
            initial={{ opacity: 0, scale: 0.985 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={THUMB_REVEAL_TRANSITION}
            className="block size-full object-contain"
          />
        ) : (
          <div
            aria-hidden="true"
            data-thumb-skeleton=""
            className="flex size-full flex-col gap-1.5 bg-surface-muted/70 p-2.5 animate-pulse motion-reduce:animate-none"
          >
            <div className="h-2 w-3/4 rounded-xs bg-line/70" />
            <div className="h-1.5 w-full rounded-xs bg-line/70" />
            <div className="h-1.5 w-5/6 rounded-xs bg-line/70" />
            <div className="mt-1 h-1.5 w-2/3 rounded-xs bg-line/70" />
          </div>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            "text-[11px] font-medium tabular-nums transition-colors duration-200",
            isActive ? "font-semibold text-brand-700" : "text-ink-500",
          )}
        >
          {pageNumber}
        </span>
        {(dots.length > 0 || hasAi) && (
          <span className="flex items-center gap-0.5" aria-hidden="true">
            {dots.slice(0, 3).map((chipClass, idx) => (
              <span key={idx} className={cn("inline-block size-1.5 rounded-full", chipClass)} />
            ))}
            {hasAi && dots.length === 0 && (
              <span className="inline-block size-1.5 rounded-full bg-ai-flag" />
            )}
          </span>
        )}
      </div>
    </m.button>
  );
});

/**
 * Collapsible left page-thumbnail rail rendered inside `<Document>`.
 * Renders visible thumbnails sequentially onto a single reused offscreen canvas
 * encoded as compressed JPEG `<img>` data URLs (bounded cache <= 40 pages),
 * avoiding N simultaneous live `<Page>` canvas backings and `page.cleanup()`
 * contention with the main viewer.
 */
export const PdfThumbnailRail = memo(function PdfThumbnailRail({
  pdf,
  numPages,
  currentPage,
  open,
  onSelectPage,
  pageIndicatorClasses,
  aiPages,
  pageSizes,
  defaultPageAspect = 842 / 595,
}: PdfThumbnailRailProps) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  const currentPageRef = useRef(currentPage);
  currentPageRef.current = currentPage;
  const openedAtPageRef = useRef(currentPage);
  if (!open) {
    openedAtPageRef.current = currentPage;
  }
  const activePill = usePill<HTMLDivElement>(`${currentPage}-${numPages}`);

  const [visibleThumbs, setVisibleThumbs] = useState<Set<number>>(() => new Set([1, 2, 3, 4]));
  const [thumbUrls, setThumbUrls] = useState<Map<number, string>>(() => new Map());
  const thumbUrlsRef = useRef(thumbUrls);
  thumbUrlsRef.current = thumbUrls;

  const setTileRef = useCallback((page: number, el: HTMLButtonElement | null) => {
    if (el) itemRefs.current.set(page, el);
    else itemRefs.current.delete(page);
  }, []);

  useEffect(() => {
    setThumbUrls(new Map());
    setVisibleThumbs(new Set([1, 2, 3, 4]));
  }, [pdf]);

  useEffect(() => {
    const root = railRef.current;
    if (!open || !root || numPages <= 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        setVisibleThumbs((prev) => {
          let changed = false;
          const next = new Set(prev);
          for (const entry of entries) {
            const p = Number((entry.target as HTMLElement).dataset.thumbPage);
            if (!Number.isFinite(p)) continue;
            if (entry.isIntersecting) {
              if (!next.has(p)) {
                next.add(p);
                changed = true;
              }
            } else if (next.delete(p)) {
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      },
      { root, rootMargin: "120px 0px" },
    );

    itemRefs.current.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [open, numPages, pdf]);

  useEffect(() => {
    if (!open) return;
    setVisibleThumbs((prev) => {
      if (prev.has(currentPage)) return prev;
      const next = new Set(prev);
      next.add(currentPage);
      return next;
    });
    const el = itemRefs.current.get(currentPage);
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [currentPage, open]);

  useEffect(() => {
    if (!open || !pdf || numPages <= 1) return;

    const needed = [...visibleThumbs]
      .filter((p) => p >= 1 && p <= numPages && !thumbUrlsRef.current.has(p))
      .sort((a, b) => Math.abs(a - currentPageRef.current) - Math.abs(b - currentPageRef.current));
    if (needed.length === 0) return;

    let cancelled = false;
    let activeTask: { promise: Promise<void>; cancel?: () => void } | null = null;
    const canvas = document.createElement("canvas");
    const delayMs = thumbUrlsRef.current.size === 0 ? 180 : 24;

    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          for (const pageNumber of needed) {
            if (cancelled) return;
            if (thumbUrlsRef.current.has(pageNumber)) continue;

            const page = await pdf.getPage(pageNumber);
            if (cancelled || !page.render) return;

            const baseVp = page.getViewport({ scale: 1 });
            const scale = baseVp.width > 0 ? THUMB_WIDTH / baseVp.width : 1;
            const viewport = page.getViewport({ scale });
            canvas.width = Math.max(1, Math.round(viewport.width));
            canvas.height = Math.max(1, Math.round(viewport.height));

            const ctx = canvas.getContext("2d", { alpha: false });
            if (!ctx) continue;
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            activeTask = page.render({ canvas, canvasContext: ctx, viewport });
            try {
              await activeTask.promise;
            } catch {
              activeTask = null;
              if (cancelled) return;
              continue;
            }
            activeTask = null;
            if (cancelled) return;

            const dataUrl = canvas.toDataURL("image/jpeg", 0.72);

            // Never clean up pages near the active viewport page, or the main
            // viewer would lose decoded resources for the current page.
            if (Math.abs(pageNumber - currentPageRef.current) > 2) {
              page.cleanup?.();
            }

            setThumbUrls((prev) => {
              const next = new Map(prev);
              next.set(pageNumber, dataUrl);
              while (next.size > MAX_THUMB_CACHE) {
                let farthestKey: number | null = null;
                let farthestDist = -1;
                for (const key of next.keys()) {
                  if (key === pageNumber) continue;
                  const dist = Math.abs(key - currentPageRef.current);
                  if (dist > farthestDist) {
                    farthestDist = dist;
                    farthestKey = key;
                  }
                }
                if (farthestKey === null) break;
                next.delete(farthestKey);
              }
              return next;
            });

            await new Promise<void>((resolve) => window.setTimeout(resolve, 16));
          }
        } finally {
          canvas.width = 0;
          canvas.height = 0;
        }
      })();
    }, delayMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (activeTask) {
        try {
          activeTask.cancel?.();
        } catch {
          // Ignore cancellation error
        }
        activeTask = null;
      }
      canvas.width = 0;
      canvas.height = 0;
    };
  }, [open, pdf, numPages, visibleThumbs]);

  return (
    <MotionConfig reducedMotion="user">
      <AnimatePresence initial={false}>
        {open && numPages > 1 && (
          <m.aside
            key="pdf-thumbnail-rail"
            aria-label={t("Page thumbnails")}
            initial={{ width: 0, opacity: 0 }}
            animate={{
              width: RAIL_WIDTH,
              opacity: 1,
              transition: {
                width: { duration: 0.3, ease: OPEN_EASE },
                opacity: { duration: 0.2, delay: 0.04 },
              },
            }}
            exit={{
              width: 0,
              opacity: 0,
              transition: {
                width: { duration: 0.24, ease: CLOSE_EASE },
                opacity: { duration: 0.14 },
              },
            }}
            className="flex h-full shrink-0 flex-col overflow-hidden border-r border-line bg-white"
          >
            <m.div
              initial={{ x: -12 }}
              animate={{ x: 0, transition: { duration: 0.26, ease: OPEN_EASE } }}
              exit={{ x: -12, transition: { duration: 0.2, ease: CLOSE_EASE } }}
              className="flex h-full w-40 flex-col"
            >
              <div ref={railRef} className="flex-1 overflow-y-auto px-3 py-4 scrollbar-thin">
                <div ref={activePill.ref} className="relative space-y-3">
                  <PillIndicator
                    box={activePill.box}
                    rounded="rounded-[var(--radius-control)]"
                    className="bg-brand-100/70"
                  />
                  {Array.from({ length: numPages }, (_, i) => i + 1).map((pageNumber) => {
                    const isActive = pageNumber === currentPage;
                    const size = pageSizes?.get(pageNumber);
                    const aspect = size && size.width > 0 ? size.height / size.width : defaultPageAspect;
                    const dots = pageIndicatorClasses?.get(pageNumber) ?? EMPTY_DOTS;
                    const hasAi = aiPages?.has(pageNumber) ?? false;
                    const enterDelay = Math.min(Math.abs(pageNumber - openedAtPageRef.current), 5) * 0.022;

                    return (
                      <ThumbnailTile
                        key={pageNumber}
                        pageNumber={pageNumber}
                        aspect={aspect}
                        isActive={isActive}
                        thumbUrl={thumbUrls.get(pageNumber)}
                        dots={dots}
                        hasAi={hasAi}
                        enterDelay={enterDelay}
                        onSelectPage={onSelectPage}
                        setTileRef={setTileRef}
                      />
                    );
                  })}
                </div>
              </div>
            </m.div>
          </m.aside>
        )}
      </AnimatePresence>
    </MotionConfig>
  );
});
