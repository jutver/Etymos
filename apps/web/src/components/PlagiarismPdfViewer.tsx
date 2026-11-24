import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import {
  ArrowsOutLineHorizontal,
  FrameCorners,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  SidebarSimple,
} from "@phosphor-icons/react";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import type { MatchedSource } from "../lib/types";
import type { PdfRect } from "@etymos/shared";
import { cn } from "@etymos/shared";
import { dedupeOverlappingPdfOverlays, pdfRectPages, pdfRectsOnPage } from "../lib/pdfRects";
import { computeCanvasDpr, computeMountedPagesWindow, diffEvictedPages, sameNumberSet } from "../lib/pdfViewerMemory";
import { extractWordTokens, findFuzzyMatch, normalize, normalizeWithMap } from "../lib/textMatch";
import { AI_PDF_HIGHLIGHT, colorForMatch, matchTone } from "../screens/Report/highlights";
import type { MatchColorIndex } from "../screens/Report/blocks";
import { PdfThumbnailRail } from "./PdfThumbnailRail";
import { t, tr } from "../lib/i18n";

pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

type FitMode = "width" | "page";

export interface PdfPageRenderTask {
  promise: Promise<void>;
  cancel?: () => void;
}

export interface PdfPageProxyLike {
  getViewport: (opts: { scale: number }) => { width: number; height: number };
  getTextContent: () => Promise<{ items: any[] }>;
  render?: (params: {
    canvas: HTMLCanvasElement;
    canvasContext: CanvasRenderingContext2D;
    viewport: { width: number; height: number };
  }) => PdfPageRenderTask;
  cleanup?: () => void;
}

export interface PdfProxy {
  numPages: number;
  getPage: (n: number) => Promise<PdfPageProxyLike>;
}

export type PlagiarismPdfViewerProps = {
  pdfUrl: File | string;
  matches: MatchedSource[];
  /** Shared source-identity color index map matching SourcesSidebar & DocumentCanvas. */
  colorIndexByMatch?: MatchColorIndex;
  activeMatchId?: string | null;
  onMatchClick?: (matchId: string) => void;
  /** Respects FormatToolbar's highlight visibility toggle on Original PDF view too. */
  showHighlights?: boolean;
  /** Controls visibility of AI-flagged paragraph overlays independently of array identity. */
  showAiHighlights?: boolean;
  unavailableMessage?: string;
  isLoadingUrl?: boolean;
  onRefreshUrl?: () => Promise<boolean>;
  onPageChange?: (page: number, pageCount: number) => void;
  overLimitOffset?: number;
  aiSegments?: { id: string; excerpt: string; score: number; pdfRects?: PdfRect[] }[];
  activeAiSegmentId?: string | null;
  onAiSegmentClick?: (segmentId: string) => void;
  defaultFit?: FitMode;
  onReady?: () => void;
};

const NO_AI_SEGMENTS: NonNullable<PlagiarismPdfViewerProps["aiSegments"]> = [];
const EMPTY_COLOR_INDEX: MatchColorIndex = new Map();

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.15;
const MAX_FIT_SCALE = 1.75;
const PIXEL_RATIO = Math.min(2, typeof window === "undefined" ? 1 : window.devicePixelRatio || 1);
const DEFAULT_PAGE_SIZE = { width: 595, height: 842 };

interface HighlightBox {
  matchId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  priority: number;
}

interface AiHighlightBox {
  segmentId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const EMPTY_HIGHLIGHTS: HighlightBox[] = [];
const EMPTY_AI_HIGHLIGHTS: AiHighlightBox[] = [];

interface MatchLocation {
  id: string;
  itemStart: number;
  startOffsetInItem: number;
  itemEnd: number;
  endOffsetInItem: number;
}

interface AiSegmentLocation {
  id: string;
  itemStart: number;
  startOffsetInItem: number;
  itemEnd: number;
  endOffsetInItem: number;
}

function getLeafTextSpans(pageEl: HTMLElement): HTMLElement[] {
  const layer = pageEl.querySelector<HTMLElement>(".react-pdf__Page__textContent") ?? pageEl;
  return Array.from(layer.querySelectorAll<HTMLElement>("span")).filter(
    (span) => span.childElementCount === 0 && (span.textContent?.length ?? 0) > 0,
  );
}

function sameHighlightBoxes(a: HighlightBox[] | undefined, b: HighlightBox[]): boolean {
  if (!a) return b.length === 0;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.matchId !== y.matchId ||
      Math.abs(x.x - y.x) > 0.25 ||
      Math.abs(x.y - y.y) > 0.25 ||
      Math.abs(x.width - y.width) > 0.25 ||
      Math.abs(x.height - y.height) > 0.25
    ) {
      return false;
    }
  }
  return true;
}

function sameAiBoxes(a: AiHighlightBox[] | undefined, b: AiHighlightBox[]): boolean {
  if (!a) return b.length === 0;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.segmentId !== y.segmentId ||
      Math.abs(x.x - y.x) > 0.25 ||
      Math.abs(x.y - y.y) > 0.25 ||
      Math.abs(x.width - y.width) > 0.25 ||
      Math.abs(x.height - y.height) > 0.25
    ) {
      return false;
    }
  }
  return true;
}

interface MemoPdfPageProps {
  pageNumber: number;
  scale: number;
  devicePixelRatio: number;
  renderTextLayer: boolean;
  needsLegacySearch: boolean;
  onPageLoadSuccessRef: React.RefObject<(pageNumber: number, width: number, height: number) => void>;
  onPageRenderReadyRef: React.RefObject<(pageNumber: number) => void>;
  onTextLayerReadyRef: React.RefObject<(pageNumber: number) => void>;
}

/**
 * Memoized wrapper around `react-pdf`'s `<Page>` keeping callback identities
 * invariant across renders so `TextLayer`'s `renderTextLayer` layout effect
 * never tears down and re-runs in a CPU loop on parent state changes.
 */
const MemoPdfPage = memo(function MemoPdfPage({
  pageNumber,
  scale,
  devicePixelRatio,
  renderTextLayer,
  needsLegacySearch,
  onPageLoadSuccessRef,
  onPageRenderReadyRef,
  onTextLayerReadyRef,
}: MemoPdfPageProps) {
  const handleLoadSuccess = useCallback(
    (page: { originalWidth?: number; originalHeight?: number; width?: number; height?: number }) => {
      const w = page.originalWidth ?? page.width;
      const h = page.originalHeight ?? page.height;
      if (w && h) onPageLoadSuccessRef.current(pageNumber, w, h);
    },
    [pageNumber, onPageLoadSuccessRef],
  );

  const handleRenderSuccess = useCallback(() => {
    onPageRenderReadyRef.current(pageNumber);
  }, [pageNumber, onPageRenderReadyRef]);

  const handleTextLayerSuccess = useCallback(() => {
    onTextLayerReadyRef.current(pageNumber);
  }, [pageNumber, onTextLayerReadyRef]);

  return (
    <Page
      pageNumber={pageNumber}
      scale={scale}
      devicePixelRatio={devicePixelRatio}
      renderAnnotationLayer={false}
      renderTextLayer={renderTextLayer}
      loading={null}
      onLoadSuccess={handleLoadSuccess}
      onRenderSuccess={pageNumber === 1 ? handleRenderSuccess : undefined}
      onRenderTextLayerSuccess={needsLegacySearch ? handleTextLayerSuccess : undefined}
    />
  );
});

interface PdfPageOverlaysProps {
  slotW: number;
  combinedRects: HighlightBox[];
  aiRects: AiHighlightBox[];
  matchById: Map<string, MatchedSource>;
  colorIndexByMatch: MatchColorIndex;
  activeMatchId?: string | null;
  activeAiSegmentId?: string | null;
  onMatchClick?: (matchId: string) => void;
  onAiSegmentClick?: (segmentId: string) => void;
}

/**
 * Owns per-page hover state locally so moving the cursor across highlights
 * only re-renders that page's overlay container, never the PDF canvases.
 */
const PdfPageOverlays = memo(function PdfPageOverlays({
  slotW,
  combinedRects,
  aiRects,
  matchById,
  colorIndexByMatch,
  activeMatchId,
  activeAiSegmentId,
  onMatchClick,
  onAiSegmentClick,
}: PdfPageOverlaysProps) {
  const [hoveredMatchId, setHoveredMatchId] = useState<string | null>(null);

  const hoveredMatch = hoveredMatchId ? matchById.get(hoveredMatchId) : null;
  const hoveredRect = hoveredMatchId ? combinedRects.find((r) => r.matchId === hoveredMatchId) : undefined;

  return (
    <>
      {aiRects.length > 0 && (
        <div className="pointer-events-none absolute inset-0">
          {aiRects.map((r, i) => {
            const isActive = activeAiSegmentId === r.segmentId;
            return (
              <div
                key={`ai-${r.segmentId}-${i}`}
                onClick={() => onAiSegmentClick?.(r.segmentId)}
                className="pointer-events-auto absolute cursor-pointer rounded-[2px] transition-colors"
                style={{
                  left: r.x,
                  top: r.y,
                  width: r.width,
                  height: r.height,
                  backgroundColor: isActive ? AI_PDF_HIGHLIGHT.fillActive : AI_PDF_HIGHLIGHT.fill,
                  borderBottom: `1.5px solid ${AI_PDF_HIGHLIGHT.accent}`,
                  boxShadow: isActive ? `inset 0 0 0 1.5px ${AI_PDF_HIGHLIGHT.accent}` : undefined,
                }}
              />
            );
          })}
        </div>
      )}

      {combinedRects.length > 0 && (
        <div className="pointer-events-none absolute inset-0">
          {combinedRects.map((r, i) => {
            const match = matchById.get(r.matchId);
            const colorIdx = colorIndexByMatch.get(r.matchId) ?? 0;
            const palette = match ? colorForMatch(match, colorIdx) : colorForMatch({ matchPercent: 95 }, colorIdx);
            const isActive = activeMatchId === r.matchId;
            const isHovered = hoveredMatchId === r.matchId;
            const dimmed = Boolean(activeMatchId && !isActive);
            return (
              <div
                key={`${r.matchId}-${i}`}
                data-match-overlay={r.matchId}
                onClick={() => onMatchClick?.(r.matchId)}
                onMouseEnter={() => setHoveredMatchId(r.matchId)}
                onMouseLeave={() => setHoveredMatchId((cur) => (cur === r.matchId ? null : cur))}
                className={cn(
                  "pointer-events-auto absolute cursor-pointer rounded-[2px] transition-[background-color,opacity,box-shadow]",
                  dimmed && "opacity-30",
                )}
                style={{
                  left: r.x,
                  top: r.y,
                  width: r.width,
                  height: r.height,
                  backgroundColor: isActive || isHovered ? palette.pdf.fillActive : palette.pdf.fill,
                  borderBottom: `1.5px solid ${palette.pdf.accent}`,
                  boxShadow: isActive || isHovered ? `inset 0 0 0 1.5px ${palette.pdf.accent}` : undefined,
                }}
              />
            );
          })}
        </div>
      )}

      {hoveredMatch && hoveredRect && (
        <div
          className="pointer-events-none absolute z-30 max-w-xs rounded-lg border border-line bg-navy-900 px-3 py-2 text-xs text-white shadow-[var(--shadow-pop)]"
          style={{
            left: Math.min(hoveredRect.x, Math.max(8, slotW - 240)),
            top: Math.max(8, hoveredRect.y - 8),
            transform: "translateY(-100%)",
          }}
        >
          <div className="flex items-center gap-1.5 font-semibold text-white">
            <span
              className={cn(
                "inline-block size-2 shrink-0 rounded-full",
                colorForMatch(hoveredMatch, colorIndexByMatch.get(hoveredMatch.id) ?? 0).chip,
              )}
            />
            <span>
              #{(colorIndexByMatch.get(hoveredMatch.id) ?? 0) + 1} · {hoveredMatch.matchPercent}%
            </span>
          </div>
          <p className="mt-0.5 truncate text-ink-300">{hoveredMatch.sourceTitle}</p>
        </div>
      )}
    </>
  );
});

export function PlagiarismPdfViewer({
  pdfUrl,
  matches,
  colorIndexByMatch = EMPTY_COLOR_INDEX,
  activeMatchId,
  onMatchClick,
  showHighlights = true,
  showAiHighlights = true,
  unavailableMessage,
  isLoadingUrl = false,
  onRefreshUrl,
  onPageChange,
  overLimitOffset = Infinity,
  aiSegments = NO_AI_SEGMENTS,
  activeAiSegmentId = null,
  onAiSegmentClick,
  defaultFit = "width",
  onReady,
}: PlagiarismPdfViewerProps) {
  const [loadedPdf, setLoadedPdf] = useState<PdfProxy | null>(null);
  const [numPages, setNumPages] = useState<number | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [fit, setFit] = useState<FitMode>(defaultFit);
  const [zoom, setZoom] = useState(1);
  const [pageSizes, setPageSizes] = useState<Map<number, { width: number; height: number }>>(() => new Map());
  const [viewport, setViewport] = useState<{ width: number; height: number } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryingRefresh, setRetryingRefresh] = useState(false);
  const [fileBuffer, setFileBuffer] = useState<ArrayBuffer | null>(null);
  const [bufferError, setBufferError] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useState(
    () => typeof window !== "undefined" && window.innerWidth >= 1280 && defaultFit !== "page",
  );
  const [mountedPages, setMountedPages] = useState<Set<number>>(() => new Set([1, 2]));
  const [intersectingPages, setIntersectingPages] = useState<Set<number>>(() => new Set([1]));
  const [analysisTick, setAnalysisTick] = useState(0);

  // Legacy text-layer fallback measurements (only used for old reports without `pdfRects`).
  const [legacyByPage, setLegacyByPage] = useState<Record<number, string[]>>({});
  const [rawLegacyRectsByPage, setRawLegacyRectsByPage] = useState<Record<number, HighlightBox[]>>({});
  const [legacyAiByPage, setLegacyAiByPage] = useState<Record<number, string[]>>({});
  const [rawLegacyAiRectsByPage, setRawLegacyAiRectsByPage] = useState<Record<number, AiHighlightBox[]>>({});
  const matchLocationsCache = useRef<Record<number, MatchLocation[]>>({});
  const aiLocationsCache = useRef<Record<number, AiSegmentLocation[]>>({});

  const pageSlotRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const [viewerEl, setViewerEl] = useState<HTMLDivElement | null>(null);
  const setViewerNode = useCallback((el: HTMLDivElement | null) => {
    viewerRef.current = el;
    setViewerEl((prev) => (prev === el ? prev : el));
  }, []);

  const programmaticScrollRef = useRef(false);
  const currentPageRef = useRef(currentPage);
  currentPageRef.current = currentPage;
  const mountedPagesRef = useRef(mountedPages);
  mountedPagesRef.current = mountedPages;
  const intersectingPagesRef = useRef<Set<number>>(new Set([1]));
  const loadedPdfRef = useRef<PdfProxy | null>(null);
  loadedPdfRef.current = loadedPdf;
  const docLoadGenRef = useRef(0);
  const lastScrolledMatchRef = useRef<string | null>(null);
  const lastScrolledAiRef = useRef<string | null>(null);
  const hasAutoRetriedRef = useRef(false);
  const awaitingRetryLoadRef = useRef(false);
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);
  const onRefreshUrlRef = useRef(onRefreshUrl);
  onRefreshUrlRef.current = onRefreshUrl;
  const pdfUrlRef = useRef(pdfUrl);
  pdfUrlRef.current = pdfUrl;

  const matchById = useMemo(() => {
    const map = new Map<string, MatchedSource>();
    matches.forEach((m) => map.set(m.id, m));
    return map;
  }, [matches]);

  // --- Read File inputs into a clean ArrayBuffer ---
  useEffect(() => {
    if (typeof pdfUrl === "string") {
      setFileBuffer(null);
      setBufferError(null);
      return;
    }
    let cancelled = false;
    setFileBuffer(null);
    setBufferError(null);
    pdfUrl
      .arrayBuffer()
      .then((buf) => {
        if (!cancelled) setFileBuffer(buf);
      })
      .catch((err) => {
        console.error("Failed to read file as ArrayBuffer:", err);
        if (!cancelled) setBufferError(tr("Could not read this file."));
      });
    return () => {
      cancelled = true;
    };
  }, [pdfUrl]);

  const fileSource = useMemo(() => {
    if (typeof pdfUrl === "string") return pdfUrl;
    return fileBuffer;
  }, [pdfUrl, fileBuffer]);

  const readyFiredRef = useRef(false);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const fireReadyOnce = useCallback(() => {
    if (readyFiredRef.current) return;
    readyFiredRef.current = true;
    onReadyRef.current?.();
  }, []);

  useEffect(() => {
    docLoadGenRef.current += 1;
    readyFiredRef.current = false;
    lastScrolledMatchRef.current = null;
    lastScrolledAiRef.current = null;
    pageSlotRefs.current.clear();
    if (fileSource) {
      if (awaitingRetryLoadRef.current) {
        awaitingRetryLoadRef.current = false;
      } else {
        hasAutoRetriedRef.current = false;
      }
    }
    setLoadedPdf(null);
    setNumPages(null);
    setCurrentPage(1);
    setLoadError(null);
    setRetryingRefresh(false);
    setPageSizes(new Map());
    const initialMounted = new Set([1, 2]);
    mountedPagesRef.current = initialMounted;
    setMountedPages(initialMounted);
    const initialIntersecting = new Set([1]);
    intersectingPagesRef.current = initialIntersecting;
    setIntersectingPages(initialIntersecting);
    setLegacyByPage({});
    setRawLegacyRectsByPage({});
    setLegacyAiByPage({});
    setRawLegacyAiRectsByPage({});
    matchLocationsCache.current = {};
    aiLocationsCache.current = {};
  }, [fileSource]);

  useEffect(() => {
    if (bufferError || loadError) fireReadyOnce();
  }, [bufferError, loadError, fireReadyOnce]);

  // Track inner viewport dimensions via ResizeObserver (callback ref ensures it attaches once <Document> loads).
  useEffect(() => {
    if (!viewerEl) return;
    let raf = 0;
    const updateSize = (w: number, h: number) => {
      const width = Math.max(0, Math.floor(w) - 32);
      const height = Math.max(0, Math.floor(h) - 32);
      setViewport((prev) => (prev && prev.width === width && prev.height === height ? prev : { width, height }));
    };
    const rect = viewerEl.getBoundingClientRect();
    if (rect.width > 0 || rect.height > 0) updateSize(rect.width, rect.height);

    const observer = new ResizeObserver(([entry]) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        updateSize(entry.contentRect.width, entry.contentRect.height);
      });
    });
    observer.observe(viewerEl);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [viewerEl]);

  const primaryPageSize = pageSizes.get(1) ?? DEFAULT_PAGE_SIZE;

  const scale = useMemo(() => {
    if (!viewport || viewport.width <= 0) return 1;
    const byWidth = viewport.width / primaryPageSize.width;
    const fitScale = Math.min(
      MAX_FIT_SCALE,
      fit === "width" ? byWidth : Math.min(byWidth, viewport.height / primaryPageSize.height),
    );
    return Math.max(0.1, Math.floor(fitScale * zoom * 100) / 100);
  }, [fit, zoom, primaryPageSize, viewport]);

  const canvasDpr = useMemo(
    () => computeCanvasDpr(primaryPageSize.width, primaryPageSize.height, scale, PIXEL_RATIO),
    [primaryPageSize.width, primaryPageSize.height, scale],
  );

  // --- Declarative live-scale `pdfRects` projection (zero stale closures; works on flattened PDFs) ---
  const placedRectsByPage = useMemo(() => {
    const map = new Map<number, HighlightBox[]>();
    for (const m of matches) {
      if (!m.pdfRects?.length) continue;
      if (m.startOffset != null && m.startOffset >= overLimitOffset) continue;
      const priority = (matchTone(m) === "heavy" ? 1000 : 0) + m.matchPercent;
      for (const page of pdfRectPages(m.pdfRects)) {
        const bounds = pageSizes.get(page);
        const list = map.get(page) ?? [];
        for (const box of pdfRectsOnPage(m.pdfRects, page, scale, bounds)) {
          list.push({ matchId: m.id, priority, ...box });
        }
        map.set(page, list);
      }
    }
    for (const [page, list] of map.entries()) {
      map.set(page, dedupeOverlappingPdfOverlays(list, activeMatchId));
    }
    return map;
  }, [matches, overLimitOffset, pageSizes, scale, activeMatchId]);

  const placedAiRectsByPage = useMemo(() => {
    const map = new Map<number, AiHighlightBox[]>();
    for (const seg of aiSegments) {
      if (!seg.pdfRects?.length) continue;
      for (const page of pdfRectPages(seg.pdfRects)) {
        const bounds = pageSizes.get(page);
        const list = map.get(page) ?? [];
        for (const box of pdfRectsOnPage(seg.pdfRects, page, scale, bounds)) {
          list.push({ segmentId: seg.id, ...box });
        }
        map.set(page, list);
      }
    }
    return map;
  }, [aiSegments, pageSizes, scale]);

  // --- Legacy text-layer fallback search (reuses already-loaded PDF proxy — no duplicate getDocument) ---
  const needsLegacySearch = useMemo(
    () =>
      matches.some((m) => !m.pdfRects?.length && Boolean(m.userSnippet?.trim())) ||
      aiSegments.some((s) => !s.pdfRects?.length && s.excerpt.trim().length >= 8),
    [matches, aiSegments],
  );

  useEffect(() => {
    if (!loadedPdf || !needsLegacySearch) {
      matchLocationsCache.current = {};
      aiLocationsCache.current = {};
      setLegacyByPage({});
      setLegacyAiByPage({});
      setRawLegacyRectsByPage({});
      setRawLegacyAiRectsByPage({});
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const byPage: Record<number, string[]> = {};
        const locCache: Record<number, MatchLocation[]> = {};
        const aiByPage: Record<number, string[]> = {};
        const aiLocCache: Record<number, AiSegmentLocation[]> = {};

        const normalizedSnippets = matches
          .filter((m) => !m.pdfRects?.length && Boolean(m.userSnippet?.trim()))
          .map((m) => {
            const snippet = normalize(m.userSnippet);
            return { id: m.id, snippet, words: snippet.split(" ").filter(Boolean) };
          });

        const normalizedAi = aiSegments
          .filter((s) => !s.pdfRects?.length)
          .map((s) => {
            const snippet = normalize(s.excerpt.replace(/…$/, "").trim());
            return { id: s.id, snippet, words: snippet.split(" ").filter(Boolean) };
          })
          .filter((s) => s.snippet.length >= 8);

        for (let pageIdx = 1; pageIdx <= loadedPdf.numPages; pageIdx++) {
          if (cancelled) return;
          const page = await loadedPdf.getPage(pageIdx);
          if (cancelled) return;
          const textContent = await page.getTextContent();
          if (cancelled) return;

          let pageText = "";
          const charToItem: number[] = [];
          const charOffsetInItem: number[] = [];
          let spanIdx = -1;
          let spanLen = 0;

          textContent.items.forEach((item: any) => {
            const str = item.str ?? "";
            const tx = Array.isArray(item.transform) ? item.transform : null;
            const isVertical = tx ? Math.abs(Math.atan2(tx[1], tx[0])) > Math.PI / 4 : false;
            if (str.length > 0) {
              spanIdx++;
              spanLen = str.length;
            }
            if (isVertical) {
              // Advance span index to keep sync with DOM spans, but exclude vertical stamp text from search.
              return;
            }
            for (let c = 0; c < str.length; c++) {
              charToItem.push(spanIdx);
              charOffsetInItem.push(c);
            }
            pageText += str;
            if (item.hasEOL || !str.endsWith(" ")) {
              pageText += " ";
              charToItem.push(Math.max(0, spanIdx));
              charOffsetInItem.push(spanLen);
            }
          });

          const { normalized: normalizedPageText, map: rawIndexMap } = normalizeWithMap(pageText);
          let pageTokensCache: ReturnType<typeof extractWordTokens> | null = null;
          let pageWordSet: Set<string> | null = null;
          const getPageTokens = () => (pageTokensCache ??= extractWordTokens(normalizedPageText));
          const getPageWordSet = () => (pageWordSet ??= new Set(getPageTokens().map((t) => t.word)));

          for (const { id, snippet, words } of normalizedSnippets) {
            if (!snippet || snippet.length < 8) continue;
            let matchStart: number;
            let matchEndInclusive: number;
            const idx = normalizedPageText.indexOf(snippet);
            if (idx !== -1) {
              matchStart = idx;
              matchEndInclusive = idx + snippet.length - 1;
            } else {
              if (words.length < 3) continue;
              const wordSet = getPageWordSet();
              const minNeeded = Math.ceil(words.length * 0.7);
              let hits = 0;
              for (const w of words) {
                if (wordSet.has(w)) hits++;
              }
              if (hits < minNeeded) continue;
              const fuzzy = findFuzzyMatch(getPageTokens(), words);
              if (!fuzzy) continue;
              matchStart = fuzzy.start;
              matchEndInclusive = fuzzy.end;
            }
            const rawStart = rawIndexMap[matchStart] ?? 0;
            const rawEnd = rawIndexMap[Math.min(matchEndInclusive, rawIndexMap.length - 1)] ?? rawStart;
            (byPage[pageIdx] ??= []).push(id);
            (locCache[pageIdx] ??= []).push({
              id,
              itemStart: charToItem[rawStart] ?? 0,
              startOffsetInItem: charOffsetInItem[rawStart] ?? 0,
              itemEnd: charToItem[rawEnd] ?? charToItem[charToItem.length - 1] ?? 0,
              endOffsetInItem: charOffsetInItem[rawEnd] ?? 0,
            });
          }

          for (const { id, snippet, words } of normalizedAi) {
            let matchStart: number;
            let matchEndInclusive: number;
            const idx = normalizedPageText.indexOf(snippet);
            if (idx !== -1) {
              matchStart = idx;
              matchEndInclusive = idx + snippet.length - 1;
            } else {
              if (words.length < 3) continue;
              const wordSet = getPageWordSet();
              const minNeeded = Math.ceil(words.length * 0.7);
              let hits = 0;
              for (const w of words) {
                if (wordSet.has(w)) hits++;
              }
              if (hits < minNeeded) continue;
              const fuzzy = findFuzzyMatch(getPageTokens(), words);
              if (!fuzzy) continue;
              matchStart = fuzzy.start;
              matchEndInclusive = fuzzy.end;
            }
            const rawStart = rawIndexMap[matchStart] ?? 0;
            const rawEnd = rawIndexMap[Math.min(matchEndInclusive, rawIndexMap.length - 1)] ?? rawStart;
            (aiByPage[pageIdx] ??= []).push(id);
            (aiLocCache[pageIdx] ??= []).push({
              id,
              itemStart: charToItem[rawStart] ?? 0,
              startOffsetInItem: charOffsetInItem[rawStart] ?? 0,
              itemEnd: charToItem[rawEnd] ?? charToItem[charToItem.length - 1] ?? 0,
              endOffsetInItem: charOffsetInItem[rawEnd] ?? 0,
            });
          }

          if (!mountedPagesRef.current.has(pageIdx)) {
            page.cleanup?.();
          }

          // Yield between pages so main-thread scrolling stays fluid on large PDFs.
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        }

        if (!cancelled) {
          matchLocationsCache.current = locCache;
          aiLocationsCache.current = aiLocCache;
          setLegacyByPage(byPage);
          setLegacyAiByPage(aiByPage);
          setAnalysisTick((t0) => t0 + 1);
        }
      } catch (err) {
        if (!cancelled) console.error("PDF legacy fallback text analysis error:", err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loadedPdf, needsLegacySearch, matches, aiSegments]);

  const measureLegacyPage = useCallback(
    (page: number) => {
      const container = pageSlotRefs.current.get(page);
      const locs = matchLocationsCache.current[page] ?? [];
      const aiLocs = aiLocationsCache.current[page] ?? [];
      if (!container || (locs.length === 0 && aiLocs.length === 0)) {
        setRawLegacyRectsByPage((prev) => {
          if (!(page in prev) || prev[page].length === 0) return prev;
          return { ...prev, [page]: EMPTY_HIGHLIGHTS };
        });
        setRawLegacyAiRectsByPage((prev) => {
          if (!(page in prev) || prev[page].length === 0) return prev;
          return { ...prev, [page]: EMPTY_AI_HIGHLIGHTS };
        });
        return;
      }
      const spans = getLeafTextSpans(container);
      if (spans.length === 0) return;

      const containerRect = container.getBoundingClientRect();
      const maxSpanRatio = containerRect.width > 0 ? containerRect.width * 0.85 : Infinity;

      const measured: HighlightBox[] = [];
      for (const loc of locs) {
        const src = matchById.get(loc.id);
        if (!src || (src.startOffset != null && src.startOffset >= overLimitOffset)) continue;
        const startNode = spans[loc.itemStart]?.firstChild;
        const endNode = spans[loc.itemEnd]?.firstChild;
        if (!startNode || !endNode) continue;
        try {
          const range = document.createRange();
          const startLen = startNode.textContent?.length ?? 0;
          const endLen = endNode.textContent?.length ?? 0;
          range.setStart(startNode, Math.min(loc.startOffsetInItem, startLen));
          range.setEnd(endNode, Math.min(loc.endOffsetInItem + 1, endLen));
          const priority = (matchTone(src) === "heavy" ? 1000 : 0) + src.matchPercent;
          for (const cr of Array.from(range.getClientRects())) {
            if (cr.width <= 0 || cr.height <= 0) continue;
            if (cr.height > cr.width * 2.2) continue; // skip sideways stamps
            if (cr.width > maxSpanRatio && loc.itemEnd - loc.itemStart > 8) continue; // cross-column artifact
            measured.push({
              matchId: loc.id,
              priority,
              x: cr.left - containerRect.left,
              y: cr.top - containerRect.top,
              width: cr.width,
              height: cr.height,
            });
          }
        } catch {
          // Ignore invalid range
        }
      }

      const measuredAi: AiHighlightBox[] = [];
      for (const loc of aiLocs) {
        const startNode = spans[loc.itemStart]?.firstChild;
        const endNode = spans[loc.itemEnd]?.firstChild;
        if (!startNode || !endNode) continue;
        try {
          const range = document.createRange();
          const startLen = startNode.textContent?.length ?? 0;
          const endLen = endNode.textContent?.length ?? 0;
          range.setStart(startNode, Math.min(loc.startOffsetInItem, startLen));
          range.setEnd(endNode, Math.min(loc.endOffsetInItem + 1, endLen));
          for (const cr of Array.from(range.getClientRects())) {
            if (cr.width <= 0 || cr.height <= 0 || cr.height > cr.width * 2.2) continue;
            measuredAi.push({
              segmentId: loc.id,
              x: cr.left - containerRect.left,
              y: cr.top - containerRect.top,
              width: cr.width,
              height: cr.height,
            });
          }
        } catch {
          // Ignore invalid range
        }
      }

      setRawLegacyRectsByPage((prev) =>
        sameHighlightBoxes(prev[page], measured) ? prev : { ...prev, [page]: measured },
      );
      setRawLegacyAiRectsByPage((prev) =>
        sameAiBoxes(prev[page], measuredAi) ? prev : { ...prev, [page]: measuredAi },
      );
    },
    [matchById, overLimitOffset],
  );

  // Dedupe legacy measurements declaratively on activeMatchId change (never re-runs DOM Range queries).
  const legacyRectsByPage = useMemo(() => {
    const out: Record<number, HighlightBox[]> = {};
    for (const [pageKey, list] of Object.entries(rawLegacyRectsByPage)) {
      if (list.length > 0) out[Number(pageKey)] = dedupeOverlappingPdfOverlays(list, activeMatchId);
    }
    return out;
  }, [rawLegacyRectsByPage, activeMatchId]);

  const legacyAiRectsByPage = rawLegacyAiRectsByPage;

  const visibleRectsByPage = useMemo(() => {
    const map = new Map<number, HighlightBox[]>();
    const pages = new Set<number>([
      ...placedRectsByPage.keys(),
      ...Object.keys(legacyRectsByPage).map(Number),
    ]);
    for (const page of pages) {
      const merged = [...(placedRectsByPage.get(page) ?? []), ...(legacyRectsByPage[page] ?? [])].filter(
        (r) => showHighlights || r.matchId === activeMatchId,
      );
      if (merged.length > 0) map.set(page, merged);
    }
    return map;
  }, [placedRectsByPage, legacyRectsByPage, showHighlights, activeMatchId]);

  const visibleAiRectsByPage = useMemo(() => {
    const map = new Map<number, AiHighlightBox[]>();
    const pages = new Set<number>([
      ...placedAiRectsByPage.keys(),
      ...Object.keys(legacyAiRectsByPage).map(Number),
    ]);
    for (const page of pages) {
      const merged = [...(placedAiRectsByPage.get(page) ?? []), ...(legacyAiRectsByPage[page] ?? [])].filter(
        (r) => showAiHighlights || r.segmentId === activeAiSegmentId,
      );
      if (merged.length > 0) map.set(page, merged);
    }
    return map;
  }, [placedAiRectsByPage, legacyAiRectsByPage, showAiHighlights, activeAiSegmentId]);

  const onPageRenderReadyRef = useRef((pageNumber: number) => {
    if (pageNumber === 1) fireReadyOnce();
  });
  onPageRenderReadyRef.current = (pageNumber: number) => {
    if (pageNumber === 1) fireReadyOnce();
  };

  const onTextLayerReadyRef = useRef((pageNumber: number) => {
    if (needsLegacySearch) measureLegacyPage(pageNumber);
  });
  onTextLayerReadyRef.current = (pageNumber: number) => {
    if (needsLegacySearch) measureLegacyPage(pageNumber);
  };

  const onPageLoadSuccessRef = useRef((pageNumber: number, w: number, h: number) => {
    if (w <= 0 || h <= 0) return;
    setPageSizes((prev) => {
      const cur = prev.get(pageNumber);
      if (cur && Math.abs(cur.width - w) <= 0.5 && Math.abs(cur.height - h) <= 0.5) return prev;
      const primary = prev.get(1);
      if (
        pageNumber !== 1 &&
        !cur &&
        primary &&
        Math.abs(primary.width - w) <= 0.5 &&
        Math.abs(primary.height - h) <= 0.5
      ) {
        return prev;
      }
      const next = new Map(prev);
      next.set(pageNumber, { width: w, height: h });
      return next;
    });
  });

  const cleanupEvictedPages = useCallback((pages: number[]) => {
    const pdf = loadedPdfRef.current;
    if (!pdf || pages.length === 0) return;
    for (const p of pages) {
      void pdf
        .getPage(p)
        .then((pg) => {
          if (!mountedPagesRef.current.has(p)) pg.cleanup?.();
        })
        .catch(() => {});
    }
  }, []);

  const syncMountedWindow = useCallback(
    (page: number, total: number) => {
      if (total <= 0) return;
      const next = computeMountedPagesWindow(page, total, intersectingPagesRef.current, 1);
      const prev = mountedPagesRef.current;
      if (sameNumberSet(prev, next)) return;
      const evicted = diffEvictedPages(prev, next);
      mountedPagesRef.current = next;
      setMountedPages(next);
      cleanupEvictedPages(evicted);
    },
    [cleanupEvictedPages],
  );

  // Clear legacy coords on scale change, and re-measure mounted pages when scale or legacy search updates.
  useEffect(() => {
    if (!needsLegacySearch) return;
    setRawLegacyRectsByPage({});
    setRawLegacyAiRectsByPage({});
    const frame = requestAnimationFrame(() => {
      mountedPagesRef.current.forEach((p) => measureLegacyPage(p));
    });
    return () => cancelAnimationFrame(frame);
  }, [scale, analysisTick, needsLegacySearch, measureLegacyPage]);

  // --- Strictly bounded virtualized page mounting via IntersectionObserver ---
  useEffect(() => {
    if (!viewerEl || !numPages) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const nextIntersecting = new Set(intersectingPagesRef.current);
        let changed = false;
        for (const entry of entries) {
          const p = Number((entry.target as HTMLElement).dataset.pageNumber);
          if (!Number.isFinite(p)) continue;
          if (entry.isIntersecting) {
            if (!nextIntersecting.has(p)) {
              nextIntersecting.add(p);
              changed = true;
            }
          } else if (nextIntersecting.delete(p)) {
            changed = true;
          }
        }
        if (!changed) return;
        intersectingPagesRef.current = nextIntersecting;
        setIntersectingPages((prev) => (sameNumberSet(prev, nextIntersecting) ? prev : nextIntersecting));
        syncMountedWindow(currentPageRef.current, numPages);
      },
      { root: viewerEl, rootMargin: "160px 0px" },
    );

    pageSlotRefs.current.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [viewerEl, numPages, syncMountedWindow]);

  useEffect(() => {
    if (numPages) syncMountedWindow(currentPage, numPages);
  }, [currentPage, numPages, syncMountedWindow]);

  // Keep currentPage synchronized as user scrolls continuously without rebinding on page change.
  useEffect(() => {
    if (!viewerEl || !numPages) return;
    let raf = 0;

    const handleScroll = () => {
      if (programmaticScrollRef.current) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const mid = viewerEl.scrollTop + viewerEl.clientHeight * 0.4;
        const cur = currentPageRef.current;
        let bestPage = cur;
        let bestDist = Infinity;
        for (let p = 1; p <= numPages; p++) {
          const el = pageSlotRefs.current.get(p);
          if (!el) continue;
          const center = el.offsetTop + el.offsetHeight / 2;
          const dist = Math.abs(center - mid);
          if (dist < bestDist) {
            bestDist = dist;
            bestPage = p;
          }
        }
        if (bestPage !== cur) setCurrentPage(bestPage);
      });
    };

    viewerEl.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      viewerEl.removeEventListener("scroll", handleScroll);
    };
  }, [viewerEl, numPages]);

  useEffect(() => {
    if (numPages) onPageChange?.(currentPage, numPages);
  }, [currentPage, numPages, onPageChange]);

  const scrollToPage = useCallback(
    (page: number, targetYRatio?: number) => {
      if (!numPages) return;
      const next = Math.min(Math.max(1, page), numPages);
      setCurrentPage(next);
      syncMountedWindow(next, numPages);
      const viewer = viewerRef.current;
      const slot = pageSlotRefs.current.get(next);
      if (!viewer || !slot) return;
      programmaticScrollRef.current = true;
      const extraY = targetYRatio !== undefined ? targetYRatio : -20;
      const top = Math.max(0, slot.offsetTop + extraY);
      viewer.scrollTo({ top, behavior: "smooth" });
      window.setTimeout(() => {
        programmaticScrollRef.current = false;
      }, 450);
    },
    [numPages, syncMountedWindow],
  );

  // Scroll to active match when selected from sidebar (guarded so scale changes don't hijack scroll).
  useEffect(() => {
    if (!activeMatchId) {
      lastScrolledMatchRef.current = null;
      return;
    }
    if (lastScrolledMatchRef.current === activeMatchId) return;
    const match = matchById.get(activeMatchId);
    let targetPage: number | undefined;
    if (match?.pdfRects?.length) {
      targetPage = pdfRectPages(match.pdfRects)[0];
    } else {
      const entry = Object.entries(legacyByPage).find(([, ids]) => ids.includes(activeMatchId));
      if (entry) targetPage = Number(entry[0]);
    }
    if (!targetPage) return;
    lastScrolledMatchRef.current = activeMatchId;

    const viewer = viewerRef.current;
    const rect =
      placedRectsByPage.get(targetPage)?.find((r) => r.matchId === activeMatchId) ??
      legacyRectsByPage[targetPage]?.find((r) => r.matchId === activeMatchId);
    const yOffset = rect && viewer ? rect.y - viewer.clientHeight / 3 : undefined;
    scrollToPage(targetPage, yOffset);
  }, [activeMatchId, matchById, placedRectsByPage, legacyByPage, legacyRectsByPage, scrollToPage]);

  useEffect(() => {
    if (!activeAiSegmentId) {
      lastScrolledAiRef.current = null;
      return;
    }
    if (lastScrolledAiRef.current === activeAiSegmentId) return;
    const seg = aiSegments.find((s) => s.id === activeAiSegmentId);
    let targetPage: number | undefined;
    if (seg?.pdfRects?.length) {
      targetPage = pdfRectPages(seg.pdfRects)[0];
    } else {
      const entry = Object.entries(legacyAiByPage).find(([, ids]) => ids.includes(activeAiSegmentId));
      if (entry) targetPage = Number(entry[0]);
    }
    if (!targetPage) return;
    lastScrolledAiRef.current = activeAiSegmentId;

    const viewer = viewerRef.current;
    const rect =
      placedAiRectsByPage.get(targetPage)?.find((r) => r.segmentId === activeAiSegmentId) ??
      legacyAiRectsByPage[targetPage]?.find((r) => r.segmentId === activeAiSegmentId);
    const yOffset = rect && viewer ? rect.y - viewer.clientHeight / 3 : undefined;
    scrollToPage(targetPage, yOffset);
  }, [activeAiSegmentId, aiSegments, placedAiRectsByPage, legacyAiByPage, legacyAiRectsByPage, scrollToPage]);

  // Indicator badges for thumbnail rail (source chip colors & AI pages).
  const { pageIndicatorClasses, aiPages } = useMemo(() => {
    const classMap = new Map<number, string[]>();
    const aiSet = new Set<number>();
    const seenPerPage = new Map<number, Set<string>>();

    if (showHighlights || activeMatchId) {
      for (const m of matches) {
        if (!showHighlights && m.id !== activeMatchId) continue;
        if (m.startOffset != null && m.startOffset >= overLimitOffset) continue;
        const pages = m.pdfRects?.length
          ? pdfRectPages(m.pdfRects)
          : Object.entries(legacyByPage)
              .filter(([, ids]) => ids.includes(m.id))
              .map(([p]) => Number(p));
        const color = colorForMatch(m, colorIndexByMatch.get(m.id) ?? 0);
        for (const p of pages) {
          const seen = seenPerPage.get(p) ?? new Set<string>();
          if (seen.has(color.key)) continue;
          seen.add(color.key);
          seenPerPage.set(p, seen);
          const list = classMap.get(p) ?? [];
          if (list.length < 3) {
            list.push(color.chip);
            classMap.set(p, list);
          }
        }
      }
    }

    if (showAiHighlights || activeAiSegmentId) {
      for (const seg of aiSegments) {
        if (!showAiHighlights && seg.id !== activeAiSegmentId) continue;
        const pages = seg.pdfRects?.length
          ? pdfRectPages(seg.pdfRects)
          : Object.entries(legacyAiByPage)
              .filter(([, ids]) => ids.includes(seg.id))
              .map(([p]) => Number(p));
        pages.forEach((p) => aiSet.add(p));
      }
    }

    return { pageIndicatorClasses: classMap, aiPages: aiSet };
  }, [
    matches,
    overLimitOffset,
    legacyByPage,
    colorIndexByMatch,
    aiSegments,
    legacyAiByPage,
    showHighlights,
    showAiHighlights,
    activeMatchId,
    activeAiSegmentId,
  ]);

  const handleDocumentLoadSuccess = useCallback((pdf: PdfProxy) => {
    const gen = ++docLoadGenRef.current;
    hasAutoRetriedRef.current = false;
    awaitingRetryLoadRef.current = false;
    setLoadedPdf(pdf);
    setNumPages(pdf.numPages);
    setCurrentPage(1);
    setLoadError(null);
    setRetryingRefresh(false);

    if (pdf.numPages <= 0) return;

    void pdf.getPage(1).then((p1) => {
      if (docLoadGenRef.current !== gen) return;
      const vp1 = p1.getViewport({ scale: 1 });
      const size1 = { width: vp1.width, height: vp1.height };
      setPageSizes((prev) => {
        const cur = prev.get(1);
        if (cur && cur.width === size1.width && cur.height === size1.height) return prev;
        const next = new Map(prev);
        next.set(1, size1);
        return next;
      });
    });
  }, []);

  const handleDocumentLoadError = useCallback((err: Error) => {
    console.error("PDF load error:", err);
    if (
      typeof pdfUrlRef.current === "string" &&
      pdfUrlRef.current.length > 0 &&
      onRefreshUrlRef.current &&
      !hasAutoRetriedRef.current
    ) {
      hasAutoRetriedRef.current = true;
      awaitingRetryLoadRef.current = true;
      setRetryingRefresh(true);
      void onRefreshUrlRef
        .current()
        .then((refreshed) => {
          if (!isMountedRef.current) return;
          setRetryingRefresh(false);
          if (!refreshed) {
            awaitingRetryLoadRef.current = false;
            setLoadError(tr("Could not load the PDF. The file may be corrupted or unsupported."));
          }
        })
        .catch(() => {
          if (!isMountedRef.current) return;
          awaitingRetryLoadRef.current = false;
          setRetryingRefresh(false);
          setLoadError(tr("Could not load the PDF. The file may be corrupted or unsupported."));
        });
      return;
    }
    setLoadError(tr("Could not load the PDF. The file may be corrupted or unsupported."));
  }, []);

  function onViewerKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === "PageDown") {
      e.preventDefault();
      scrollToPage(currentPage + 1);
    } else if (e.key === "PageUp") {
      e.preventDefault();
      scrollToPage(currentPage - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      scrollToPage(1);
    } else if (e.key === "End" && numPages) {
      e.preventDefault();
      scrollToPage(numPages);
    }
  }

  const [pageInput, setPageInput] = useState("1");
  useEffect(() => setPageInput(String(currentPage)), [currentPage]);
  function commitPageInput() {
    const n = Number.parseInt(pageInput, 10);
    if (Number.isFinite(n)) scrollToPage(n);
    else setPageInput(String(currentPage));
  }

  const isPreparingFile = typeof pdfUrl !== "string" && !fileBuffer && !bufferError;
  const pillBtn =
    "flex size-7 items-center justify-center rounded-full text-ink-600 transition-colors hover:bg-surface-muted hover:text-ink-900 disabled:pointer-events-none disabled:opacity-40";

  return (
    <div className="relative flex h-full min-h-0 flex-1 bg-surface-muted/60">
      {isLoadingUrl || retryingRefresh ? (
        <div className="flex flex-1 items-center justify-center px-6">
          <p className="py-12 text-center text-sm text-ink-400">{t("Loading PDF...")}</p>
        </div>
      ) : !pdfUrl ? (
        <div className="flex flex-1 items-center justify-center px-6">
          <p className={`py-12 text-center text-sm ${unavailableMessage ? "font-medium text-severity-high" : "text-ink-400"}`}>
            {unavailableMessage ?? t("No original PDF available to preview.")}
          </p>
        </div>
      ) : bufferError ? (
        <div className="flex flex-1 items-center justify-center px-6">
          <p className="py-12 text-center text-sm font-medium text-severity-high">{t(bufferError)}</p>
        </div>
      ) : loadError ? (
        <div className="flex flex-1 items-center justify-center px-6">
          <p className="py-12 text-center text-sm font-medium text-severity-high">{t(loadError)}</p>
        </div>
      ) : isPreparingFile ? (
        <div className="flex flex-1 items-center justify-center px-6">
          <p className="py-12 text-center text-sm text-ink-400">{t("Preparing file...")}</p>
        </div>
      ) : fileSource ? (
        <Document
          file={fileSource}
          onLoadSuccess={handleDocumentLoadSuccess as any}
          onLoadError={handleDocumentLoadError}
          loading={
            <div className="flex flex-1 items-center justify-center px-6">
              <p className="py-12 text-center text-sm text-ink-400">{t("Loading PDF...")}</p>
            </div>
          }
          className="flex min-h-0 flex-1 overflow-hidden"
        >
          {numPages && (
            <PdfThumbnailRail
              pdf={loadedPdf}
              numPages={numPages}
              currentPage={currentPage}
              open={railOpen}
              onSelectPage={scrollToPage}
              pageIndicatorClasses={pageIndicatorClasses}
              aiPages={aiPages}
              pageSizes={pageSizes}
              defaultPageAspect={primaryPageSize.height / primaryPageSize.width}
            />
          )}

          <div
            ref={setViewerNode}
            tabIndex={0}
            onKeyDown={onViewerKeyDown}
            aria-label={t("Document preview")}
            className="relative min-h-0 flex-1 overflow-auto outline-none scrollbar-thin [scrollbar-gutter:stable] focus-visible:ring-2 focus-visible:ring-brand-300"
          >
            {numPages && (
              <div className="mx-auto flex w-max min-w-full flex-col items-center gap-5 px-4 py-6 pb-20">
                {Array.from({ length: numPages }, (_, idx) => idx + 1).map((pageNumber) => {
                  const baseSize = pageSizes.get(pageNumber) ?? primaryPageSize;
                  const slotW = Math.round(baseSize.width * scale);
                  const slotH = Math.round(baseSize.height * scale);
                  const isMounted = mountedPages.has(pageNumber);
                  const renderTextLayer =
                    needsLegacySearch || pageNumber === currentPage || intersectingPages.has(pageNumber);

                  const combinedRects = visibleRectsByPage.get(pageNumber) ?? EMPTY_HIGHLIGHTS;
                  const aiRects = visibleAiRectsByPage.get(pageNumber) ?? EMPTY_AI_HIGHLIGHTS;

                  return (
                    <div
                      key={pageNumber}
                      ref={(el) => {
                        if (el) pageSlotRefs.current.set(pageNumber, el);
                        else pageSlotRefs.current.delete(pageNumber);
                      }}
                      data-page-number={pageNumber}
                      data-keep-light=""
                      className="relative shrink-0 bg-white shadow-[var(--shadow-card)]"
                      style={{ width: slotW, height: slotH }}
                    >
                      {isMounted && (
                        <MemoPdfPage
                          pageNumber={pageNumber}
                          scale={scale}
                          devicePixelRatio={canvasDpr}
                          renderTextLayer={renderTextLayer}
                          needsLegacySearch={needsLegacySearch}
                          onPageLoadSuccessRef={onPageLoadSuccessRef}
                          onPageRenderReadyRef={onPageRenderReadyRef}
                          onTextLayerReadyRef={onTextLayerReadyRef}
                        />
                      )}

                      {(combinedRects.length > 0 || aiRects.length > 0) && (
                        <PdfPageOverlays
                          slotW={slotW}
                          combinedRects={combinedRects}
                          aiRects={aiRects}
                          matchById={matchById}
                          colorIndexByMatch={colorIndexByMatch}
                          activeMatchId={activeMatchId}
                          activeAiSegmentId={activeAiSegmentId}
                          onMatchClick={onMatchClick}
                          onAiSegmentClick={onAiSegmentClick}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Document>
      ) : null}

      {/* Minimal integrated floating control pill (bottom-right, mirrors WordCountPill) */}
      {numPages && (
        <div
          role="region"
          aria-label={t("PDF viewer controls")}
          className="pointer-events-auto absolute bottom-4 right-4 z-20 flex items-center gap-1 rounded-full border border-line/80 bg-white/95 px-2 py-1 text-xs shadow-[var(--shadow-card)]"
        >
          {numPages > 1 && (
            <>
              <button
                type="button"
                onClick={() => setRailOpen((v) => !v)}
                className={cn(pillBtn, railOpen && "bg-brand-100 text-brand-700")}
                aria-label={railOpen ? t("Hide page thumbnails") : t("Show page thumbnails")}
                title={railOpen ? t("Hide page thumbnails") : t("Show page thumbnails")}
                aria-pressed={railOpen}
              >
                <SidebarSimple size={15} />
              </button>
              <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-line" />
            </>
          )}

          <label className="flex items-center gap-1 px-1 text-xs font-medium text-ink-600">
            <span className="sr-only">{t("Go to page")}</span>
            <input
              value={pageInput}
              onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ""))}
              onBlur={commitPageInput}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitPageInput();
              }}
              inputMode="numeric"
              className="h-6 w-8 rounded-md border border-line/80 bg-surface-tint text-center text-xs font-semibold tabular-nums text-ink-800 outline-none focus:border-brand-400"
            />
            <span className="tabular-nums text-ink-400">/ {numPages}</span>
          </label>

          <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-line" />

          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(ZOOM_MIN, +(z - ZOOM_STEP).toFixed(2)))}
            disabled={zoom <= ZOOM_MIN}
            className={pillBtn}
            aria-label={t("Zoom out")}
            title={t("Zoom out")}
          >
            <MagnifyingGlassMinus size={15} />
          </button>
          <span className="w-10 text-center text-[11px] font-semibold tabular-nums text-ink-600">
            {Math.round(scale * 100)}%
          </span>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(ZOOM_MAX, +(z + ZOOM_STEP).toFixed(2)))}
            disabled={zoom >= ZOOM_MAX}
            className={pillBtn}
            aria-label={t("Zoom in")}
            title={t("Zoom in")}
          >
            <MagnifyingGlassPlus size={15} />
          </button>

          <button
            type="button"
            onClick={() => {
              setFit((f) => (f === "width" ? "page" : "width"));
              setZoom(1);
            }}
            className={pillBtn}
            aria-label={fit === "width" ? t("Fit page") : t("Fit width")}
            title={fit === "width" ? t("Fit page") : t("Fit width")}
          >
            {fit === "width" ? <FrameCorners size={15} /> : <ArrowsOutLineHorizontal size={15} />}
          </button>
        </div>
      )}
    </div>
  );
}
