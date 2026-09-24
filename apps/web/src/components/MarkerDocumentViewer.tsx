import { useEffect, useMemo, useRef, useState } from "react";
import { CircleNotch, DownloadSimple, WarningCircle } from "@phosphor-icons/react";
import type { MatchedSource, Severity } from "../lib/types";
import { downloadMarkerPreviewDocx, pollMarkerPreview, type MarkerPreview } from "../lib/api";
import { locateSnippetRaw, wordOverlapRecall } from "../lib/textMatch";
import { t, tr } from "../lib/i18n";

/**
 * Replaces the raw-PDF preview (PlagiarismPdfViewer, still used for the
 * pre-upload local-file preview in screens/Upload) for an already-checked
 * report's Report page "original" view. Instead of rendering the uploaded
 * PDF's actual pages, it shows the marker-pdf-converted document (a clean,
 * reflowed HTML rendering — see backend/marker_preview.py) with matches
 * highlighted the same way PlagiarismPdfViewer highlights PDF text: locate
 * each match's `userSnippet` in the rendered text, exact first then a fuzzy
 * word-window fallback (lib/textMatch.ts), then wrap the located range with
 * a <mark>.
 *
 * This is NOT the extracted-text "document" view (DocumentCanvas) — that
 * one stays on extractor.py's output and backend-precise character offsets,
 * completely unchanged. marker-pdf extracts the same PDF independently, so
 * its text does not share those offsets; every highlight here is therefore
 * snippet-search-based, same as PlagiarismPdfViewer's pdf.js text layer
 * matching, not offset-precise.
 */

export interface MarkerDocumentViewerProps {
  reportId: string;
  matches: MatchedSource[];
  activeMatchId?: string | null;
  onMatchClick?: (matchId: string) => void;
  fileNameForDownload?: string;
}

const SEVERITY_COLOR: Record<Severity, { fill: string; fillActive: string; border: string }> = {
  high: { fill: "rgba(220, 38, 38, 0.16)", fillActive: "rgba(220, 38, 38, 0.38)", border: "rgba(220, 38, 38, 0.55)" },
  moderate: { fill: "rgba(217, 119, 6, 0.15)", fillActive: "rgba(217, 119, 6, 0.36)", border: "rgba(217, 119, 6, 0.55)" },
  low: { fill: "rgba(37, 99, 235, 0.13)", fillActive: "rgba(37, 99, 235, 0.34)", border: "rgba(37, 99, 235, 0.5)" },
};

const SEVERITY_LABEL: Record<Severity, string> = {
  high: tr("High match"),
  moderate: tr("Moderate match"),
  low: tr("Common phrasing"),
};

const SEVERITY_RANK: Record<Severity, number> = { high: 3, moderate: 2, low: 1 };

// Below this bag-of-words recall score, attributing a match to its
// best-scoring paragraph is more likely noise than signal — better to drop
// it than mislabel an unrelated paragraph.
const APPROXIMATE_MATCH_THRESHOLD = 0.5;

interface NodeSpan {
  node: Text;
  start: number;
  end: number;
}

interface BlockSpan {
  el: Element;
  start: number;
  end: number;
  text: string;
}

const BLOCK_SELECTOR = "p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, figcaption";

/** Groups `spans` by their nearest block-level ancestor, giving each block
 * its own (start, end, concatenated text) — the unit `wordOverlapRecall`
 * scores against for the approximate fallback below. Spans are assumed to
 * already be in document order (as `buildNodeSpans` produces), so the
 * first span seen for a given block is always its earliest (min `start`). */
function buildBlockSpans(spans: NodeSpan[]): BlockSpan[] {
  const byBlock = new Map<Element, BlockSpan>();
  for (const span of spans) {
    const el = span.node.parentElement?.closest(BLOCK_SELECTOR);
    if (!el) continue;
    const text = span.node.textContent ?? "";
    const existing = byBlock.get(el);
    if (existing) {
      existing.end = Math.max(existing.end, span.end);
      existing.text += text;
    } else {
      byBlock.set(el, { el, start: span.start, end: span.end, text });
    }
  }
  return Array.from(byBlock.values());
}

function collectTextNodes(root: HTMLElement): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = walker.nextNode())) nodes.push(n as Text);
  return nodes;
}

function buildNodeSpans(nodes: Text[]): { spans: NodeSpan[]; fullText: string } {
  let cursor = 0;
  const spans: NodeSpan[] = [];
  let fullText = "";
  for (const node of nodes) {
    const text = node.textContent ?? "";
    spans.push({ node, start: cursor, end: cursor + text.length });
    fullText += text;
    cursor += text.length;
  }
  return { spans, fullText };
}

/** Colours + underlines one <mark>, shared by both the precise and
 * approximate paths (and by the later severity-upgrade path for a block
 * shared by several approximate matches) so the two never drift apart. */
function applyMarkStyle(mark: HTMLElement, severity: Severity, approximate: boolean) {
  const color = SEVERITY_COLOR[severity] ?? SEVERITY_COLOR.moderate;
  mark.style.backgroundColor = color.fill;
  mark.style.boxShadow = `inset 0 0 0 1px ${color.border}`;
  mark.style.borderRadius = "3px";
  mark.style.cursor = "pointer";
  mark.style.transition = "background-color 120ms";
  // Same non-colour signal as renderPassageText.tsx elsewhere in this app:
  // dotted underline = exact/near-exact position, dashed = only attributed
  // to a whole paragraph by word overlap (see APPROXIMATE_MATCH_THRESHOLD).
  mark.style.textDecorationLine = "underline";
  mark.style.textDecorationStyle = approximate ? "dashed" : "dotted";
  mark.style.textDecorationColor = color.border;
  mark.style.textDecorationThickness = "2px";
  mark.style.textUnderlineOffset = "3px";
}

/** Wraps every text-node slice inside [rawStart, rawEnd) with a fresh
 * element from `makeMark()`. Handles a range spanning multiple text nodes
 * (a match straddling inline formatting, e.g. **bold** inside a sentence)
 * by wrapping each node's overlapping portion separately — this can't use
 * `Range.surroundContents()` directly since that throws on a range whose
 * boundary partially selects a non-text node. */
function wrapRangeWithMark(
  spans: NodeSpan[],
  rawStart: number,
  rawEnd: number,
  makeMark: () => HTMLElement,
): void {
  for (const span of spans) {
    const overlapStart = Math.max(span.start, rawStart);
    const overlapEnd = Math.min(span.end, rawEnd);
    if (overlapEnd <= overlapStart) continue;

    const localStart = overlapStart - span.start;
    const localEnd = overlapEnd - span.start;
    let middle = span.node;
    if (localStart > 0) middle = middle.splitText(localStart);
    if (localEnd - localStart < (middle.textContent?.length ?? 0)) {
      middle.splitText(localEnd - localStart);
    }
    const mark = makeMark();
    middle.parentNode?.insertBefore(mark, middle);
    mark.appendChild(middle);
  }
}

export function MarkerDocumentViewer({
  reportId,
  matches,
  activeMatchId,
  onMatchClick,
  fileNameForDownload = "document",
}: MarkerDocumentViewerProps) {
  const [preview, setPreview] = useState<MarkerPreview | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  // Which matches actually got a <mark> wrapped around a located snippet —
  // set at the end of the highlight-injection effect below, so the legend
  // counts what's really on screen instead of re-deriving it (imprecisely,
  // against raw HTML markup rather than the rendered DOM's text) here.
  const [highlightedIds, setHighlightedIds] = useState<Set<string>>(new Set());
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    pollMarkerPreview(reportId, (next) => {
      if (!cancelled) setPreview(next);
    }).catch((err) => {
      if (!cancelled) {
        setPreview({
          status: "failed",
          html: null,
          docx_ready: false,
          error: err instanceof Error ? err.message : tr("Failed to load preview."),
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [reportId]);

  // Inject the marker-pdf HTML, then highlight every match with a locatable
  // snippet on top of it. Re-runs whenever the HTML or the match list
  // itself changes — NOT on activeMatchId (that's handled by the cheaper
  // effect below, which only toggles a class).
  useEffect(() => {
    const container = containerRef.current;
    if (!container || preview?.status !== "ready" || !preview.html) return;

    container.innerHTML = preview.html;

    const nodes = collectTextNodes(container);
    const { spans: initialSpans, fullText } = buildNodeSpans(nodes);
    // Computed once, up front, from the UNMUTATED tree — wrapping a range
    // later splits text nodes but never moves them across a block boundary,
    // so these (element, start, end, text) triples stay valid throughout.
    const blockSpans = buildBlockSpans(initialSpans);

    const withSnippet = matches.filter((m) => m.userSnippet && m.userSnippet.trim().length > 0);
    const wrapped = new Set<string>();
    // Several low-confidence matches can all land on the same paragraph —
    // share one set of <mark>s for that block instead of nesting a fresh
    // wrap per match, upgrading its colour if a later match is more severe.
    const approximateByBlock = new Map<Element, { marks: HTMLElement[]; severity: Severity }>();

    for (const match of withSnippet) {
      const located = locateSnippetRaw(fullText, match.userSnippet);

      if (located) {
        // spans mutate (splitText) as each match is wrapped, so re-derive
        // fresh spans from the CURRENT text nodes before every wrap —
        // reusing spans from before a mutation would offset-drift.
        const liveNodes = collectTextNodes(container);
        const { spans: liveSpans } = buildNodeSpans(liveNodes);
        wrapRangeWithMark(liveSpans, located.rawStart, located.rawEnd, () => {
          const mark = document.createElement("mark");
          mark.dataset.matchId = match.id;
          mark.dataset.severity = match.severity;
          applyMarkStyle(mark, match.severity, false);
          return mark;
        });
        wrapped.add(match.id);
        continue;
      }

      // Fallback: marker-pdf extracted this PDF independently of whatever
      // produced `userSnippet` (extractor.py), so wording/OCR/reflow
      // differences can make even a confidently-scored backend match
      // unlocatable as a precise substring here. Rather than dropping it,
      // attribute it to whichever paragraph shares the most words with the
      // snippet and highlight that whole paragraph, visually softened
      // (dashed underline — see applyMarkStyle) to signal "approximate".
      if (match.userSnippet.trim().split(/\s+/).length < 4) continue; // too short to score reliably

      let best: BlockSpan | null = null;
      let bestScore = 0;
      for (const block of blockSpans) {
        const score = wordOverlapRecall(match.userSnippet, block.text);
        if (score > bestScore) {
          bestScore = score;
          best = block;
        }
      }
      if (!best || bestScore < APPROXIMATE_MATCH_THRESHOLD) continue;

      const existing = approximateByBlock.get(best.el);
      if (existing) {
        if (SEVERITY_RANK[match.severity] > SEVERITY_RANK[existing.severity]) {
          existing.severity = match.severity;
          existing.marks.forEach((mark) => {
            mark.dataset.matchId = match.id;
            mark.dataset.severity = match.severity;
            applyMarkStyle(mark, match.severity, true);
          });
        }
      } else {
        const liveNodes = collectTextNodes(container);
        const { spans: liveSpans } = buildNodeSpans(liveNodes);
        const createdMarks: HTMLElement[] = [];
        wrapRangeWithMark(liveSpans, best.start, best.end, () => {
          const mark = document.createElement("mark");
          mark.dataset.matchId = match.id;
          mark.dataset.severity = match.severity;
          applyMarkStyle(mark, match.severity, true);
          createdMarks.push(mark);
          return mark;
        });
        if (createdMarks.length > 0) {
          approximateByBlock.set(best.el, { marks: createdMarks, severity: match.severity });
        }
      }
      wrapped.add(match.id);
    }
    setHighlightedIds(wrapped);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview?.status, preview?.html, matches]);

  // Cheap active/hover repaint: toggle the "active" fill without re-running
  // the whole highlight-injection pass above.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const marks = container.querySelectorAll<HTMLElement>("mark[data-match-id]");
    marks.forEach((mark) => {
      const severity = (mark.dataset.severity as Severity) ?? "moderate";
      const color = SEVERITY_COLOR[severity] ?? SEVERITY_COLOR.moderate;
      const isActive = mark.dataset.matchId === activeMatchId;
      mark.style.backgroundColor = isActive ? color.fillActive : color.fill;
    });
  }, [activeMatchId, preview?.html]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !onMatchClick) return;
    function handleClick(e: MouseEvent) {
      const target = (e.target as HTMLElement)?.closest("[data-match-id]") as HTMLElement | null;
      if (target?.dataset.matchId) onMatchClick!(target.dataset.matchId);
    }
    container.addEventListener("click", handleClick);
    return () => container.removeEventListener("click", handleClick);
  }, [onMatchClick, preview?.html]);

  async function handleDownload() {
    setDownloading(true);
    setDownloadError(null);
    try {
      await downloadMarkerPreviewDocx(reportId, fileNameForDownload);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : tr("Download failed."));
    } finally {
      setDownloading(false);
    }
  }

  const severityCounts = useMemo(() => {
    const counts: Record<Severity, number> = { high: 0, moderate: 0, low: 0 };
    matches.forEach((m) => {
      if (highlightedIds.has(m.id)) counts[m.severity] = (counts[m.severity] ?? 0) + 1;
    });
    return counts;
  }, [highlightedIds, matches]);
  const hasHighlights = severityCounts.high + severityCounts.moderate + severityCounts.low > 0;

  return (
    <div className="flex h-full flex-col rounded-[var(--radius-card)] border border-line bg-surface-tint p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-medium text-ink-700">{t("Document preview")}</p>
        <div className="flex items-center gap-2">
          {downloadError && <span className="text-xs font-medium text-severity-high">{t(downloadError)}</span>}
          <button
            onClick={handleDownload}
            disabled={preview?.status !== "ready" || !preview.docx_ready || downloading}
            className="flex items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-1.5 text-xs font-semibold text-ink-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {downloading ? <CircleNotch size={14} className="animate-spin motion-reduce:animate-none" /> : <DownloadSimple size={14} />}
            {t("Download .docx")}</button>
        </div>
      </div>

      {hasHighlights && (
        <div className="mb-3 flex flex-wrap items-center gap-4 rounded-lg border border-line bg-white px-3 py-2 text-xs">
          {(Object.keys(SEVERITY_LABEL) as Severity[]).map((sev) => (
            <div key={sev} className="flex items-center gap-1.5">
              <span className="inline-block size-2.5 rounded-full" style={{ backgroundColor: SEVERITY_COLOR[sev].border }} />
              <span className="text-ink-600">{t(SEVERITY_LABEL[sev])}</span>
              <span className="font-semibold text-ink-800">{severityCounts[sev] ?? 0}</span>
            </div>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto rounded-lg bg-white p-6">
        {!preview || preview.status === "pending" ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <CircleNotch size={22} className="animate-spin motion-reduce:animate-none text-brand-500" />
            <p className="text-sm text-ink-500">
              {t("Rendering a cleaner document preview from your PDF… this can take a little while the first time.")}</p>
          </div>
        ) : preview.status === "failed" || preview.status === "unavailable" ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <WarningCircle size={22} className="text-ink-400" />
            <p className="max-w-sm text-sm text-ink-500">
              {preview.error ?? t("A document preview isn't available for this report.")}
            </p>
          </div>
        ) : (
          <div ref={containerRef} className="marker-document-preview" />
        )}
      </div>
    </div>
  );
}
