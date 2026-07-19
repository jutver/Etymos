import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import { CaretLeft, CaretRight, MagnifyingGlassMinus, MagnifyingGlassPlus } from "@phosphor-icons/react";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import type { MatchedSource, Severity } from "../lib/types";

// Ép nó load chính xác version đang dùng qua mạng
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

type PlagiarismPdfViewerProps = {
  pdfUrl: File | string;
  matches: MatchedSource[];
  activeMatchId?: string | null;
  onMatchClick?: (matchId: string) => void;
  // Set by the caller when it tried and failed to resolve a real pdfUrl
  // (e.g. a signed-URL fetch error) — distinct from simply having no PDF to
  // show at all (e.g. a text-only submission), so the empty state doesn't
  // read as a false "everything's fine, there's just nothing here".
  unavailableMessage?: string;
};

// Toạ độ ở đây là PIXEL THẬT trên màn hình tại scale hiện tại (đo trực tiếp
// từ text layer thật của trình duyệt bằng Range API) - không cần nhân thêm
// với `scale` khi render nữa, và không còn lệch/lem vì không tự tính bằng tay.
type HighlightRect = {
  matchId: string;
  severity: Severity;
  x: number;
  y: number;
  width: number;
  height: number;
};

// Vị trí "logic" của 1 match trên 1 trang: item bắt đầu/kết thúc trong
// textContent.items của pdf.js + offset ký tự bên trong item đó. Tính 1 lần
// lúc quét toàn văn bản, dùng lại để đo pixel khi trang đó được render.
type MatchLocation = {
  id: string;
  severity: Severity;
  itemStart: number;
  startOffsetInItem: number;
  itemEnd: number;
  endOffsetInItem: number;
};

const SEVERITY_COLOR: Record<Severity, { fill: string; fillActive: string; border: string }> = {
  high: { fill: "rgba(220, 38, 38, 0.16)", fillActive: "rgba(220, 38, 38, 0.38)", border: "rgba(220, 38, 38, 0.55)" },
  moderate: { fill: "rgba(217, 119, 6, 0.15)", fillActive: "rgba(217, 119, 6, 0.36)", border: "rgba(217, 119, 6, 0.55)" },
  low: { fill: "rgba(37, 99, 235, 0.13)", fillActive: "rgba(37, 99, 235, 0.34)", border: "rgba(37, 99, 235, 0.5)" },
};

const SEVERITY_LABEL: Record<Severity, string> = {
  high: "High match",
  moderate: "Moderate match",
  low: "Common phrasing",
};

const SEVERITY_RANK: Record<Severity, number> = { high: 3, moderate: 2, low: 1 };

function normalize(text: string) {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[""'']/g, '"')
    .trim();
}

// Chuẩn hoá text NHƯNG giữ bảng ánh xạ 1-1 từ mỗi ký tự trong chuỗi đã
// chuẩn hoá về đúng vị trí ký tự tương ứng trong chuỗi gốc.
function normalizeWithMap(raw: string): { normalized: string; map: number[] } {
  let normalized = "";
  const map: number[] = [];
  let lastWasSpace = false;

  for (let i = 0; i < raw.length; i++) {
    let ch = raw[i];
    if (ch === "\u201C" || ch === "\u201D" || ch === "\u2018" || ch === "\u2019") ch = '"';
    const lower = ch.toLowerCase();

    if (/\s/.test(lower)) {
      if (lastWasSpace) continue;
      normalized += " ";
      map.push(i);
      lastWasSpace = true;
    } else {
      normalized += lower;
      map.push(i);
      lastWasSpace = false;
    }
  }

  return { normalized, map };
}

// Khi nhiều match (khác nguồn) cùng trùng vào 1 vùng chữ, tránh tô chồng
// nhiều lớp màu lên nhau (nhìn rối mắt) — chỉ giữ lại box có mức độ nghiêm
// trọng cao nhất cho vùng đó, bỏ các box còn lại chồng >50% diện tích.
function dedupeOverlappingRects(rects: HighlightRect[]): HighlightRect[] {
  const sorted = [...rects].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  const kept: HighlightRect[] = [];
  for (const r of sorted) {
    const overlapsExisting = kept.some((k) => {
      const ix = Math.max(0, Math.min(r.x + r.width, k.x + k.width) - Math.max(r.x, k.x));
      const iy = Math.max(0, Math.min(r.y + r.height, k.y + k.height) - Math.max(r.y, k.y));
      const overlapArea = ix * iy;
      const rArea = r.width * r.height || 1;
      return overlapArea / rArea > 0.5;
    });
    if (!overlapsExisting) kept.push(r);
  }
  return kept;
}

export function PlagiarismPdfViewer({
  pdfUrl,
  matches,
  activeMatchId,
  onMatchClick,
  unavailableMessage,
}: PlagiarismPdfViewerProps) {
  const [numPages, setNumPages] = useState<number | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [scale, setScale] = useState(1.1);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [fileBuffer, setFileBuffer] = useState<ArrayBuffer | null>(null);
  const [bufferError, setBufferError] = useState<string | null>(null);

  // Trang nào có match nào (chỉ để hiện chỉ báo trang + nhảy trang) - KHÔNG
  // chứa toạ độ hình học, nên không thể bị lem.
  const [matchesByPage, setMatchesByPage] = useState<Record<number, string[]>>({});
  const [analyzing, setAnalyzing] = useState(false);
  const [hoveredMatchId, setHoveredMatchId] = useState<string | null>(null);

  // Toạ độ pixel thật của các match trên TRANG ĐANG XEM, đo trực tiếp từ DOM
  // text layer mỗi khi trang render xong (chính xác tuyệt đối, không lem).
  const [pageRects, setPageRects] = useState<HighlightRect[]>([]);

  const matchLocationsCache = useRef<Record<number, MatchLocation[]>>({});
  const pageContainerRef = useRef<HTMLDivElement | null>(null);

  const matchById = useMemo(() => {
    const map = new Map<string, MatchedSource>();
    matches.forEach((m) => map.set(m.id, m));
    return map;
  }, [matches]);

  // --- 1. Đọc file thành ArrayBuffer (ổn định hơn blob URL) ---
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
        if (!cancelled) setBufferError("Không thể đọc file này.");
      });
    return () => {
      cancelled = true;
    };
  }, [pdfUrl]);

  const fileSource = useMemo(() => {
    if (typeof pdfUrl === "string") return pdfUrl;
    return fileBuffer;
  }, [pdfUrl, fileBuffer]);

  // --- 2. Quét toàn bộ văn bản để biết trang nào có match nào, và lưu lại vị
  //         trí "logic" (item + offset ký tự) của từng match. KHÔNG tính toạ
  //         độ pixel ở bước này - toạ độ pixel sẽ do trình duyệt tự đo thật
  //         khi trang đó render (bước 3), nên không còn sai số/lem nữa. ---
  useEffect(() => {
    if (!fileSource) return;
    if (matches.length === 0) {
      setMatchesByPage({});
      matchLocationsCache.current = {};
      return;
    }

    let cancelled = false;
    setAnalyzing(true);

    const analysisSource =
      typeof fileSource === "string" ? fileSource : { data: fileSource.slice(0) };

    pdfjs
      .getDocument(analysisSource as any)
      .promise.then(async (pdfDoc) => {
        const byPage: Record<number, string[]> = {};
        const locCache: Record<number, MatchLocation[]> = {};

        const normalizedSnippets = matches
          .filter((m) => m.userSnippet && m.userSnippet.trim().length > 0)
          .map((m) => ({ id: m.id, severity: m.severity, snippet: normalize(m.userSnippet) }));

        for (let pageIdx = 1; pageIdx <= pdfDoc.numPages; pageIdx++) {
          if (cancelled) return;
          const page = await pdfDoc.getPage(pageIdx);
          const textContent = await page.getTextContent();

          let pageText = "";
          const charToItem: number[] = [];
          const charOffsetInItem: number[] = [];
          textContent.items.forEach((item: any, itemIdx: number) => {
            const str = item.str ?? "";
            for (let c = 0; c < str.length; c++) {
              charToItem.push(itemIdx);
              charOffsetInItem.push(c);
            }
            pageText += str;
            if (item.hasEOL) {
              pageText += " ";
              charToItem.push(itemIdx);
              charOffsetInItem.push(str.length);
            } else if (!str.endsWith(" ")) {
              pageText += " ";
              charToItem.push(itemIdx);
              charOffsetInItem.push(str.length);
            }
          });

          const { normalized: normalizedPageText, map: rawIndexMap } = normalizeWithMap(pageText);

          for (const { id, severity, snippet } of normalizedSnippets) {
            if (!snippet || snippet.length < 8) continue; // câu quá ngắn dễ match sai
            const idx = normalizedPageText.indexOf(snippet);
            if (idx === -1) continue;

            const rawStart = rawIndexMap[idx] ?? 0;
            const rawEnd =
              rawIndexMap[Math.min(idx + snippet.length - 1, rawIndexMap.length - 1)] ?? rawStart;

            const itemStart = charToItem[rawStart] ?? 0;
            const itemEnd = charToItem[rawEnd] ?? charToItem[charToItem.length - 1] ?? 0;
            const startOffsetInItem = charOffsetInItem[rawStart] ?? 0;
            const endOffsetInItem = charOffsetInItem[rawEnd] ?? 0;

            (byPage[pageIdx] ??= []).push(id);
            (locCache[pageIdx] ??= []).push({
              id,
              severity,
              itemStart,
              startOffsetInItem,
              itemEnd,
              endOffsetInItem,
            });
          }
        }

        if (!cancelled) {
          matchLocationsCache.current = locCache;
          setMatchesByPage(byPage);
        }
      })
      .catch((err) => {
        console.error("PDF text analysis error:", err);
      })
      .finally(() => {
        if (!cancelled) setAnalyzing(false);
      });

    return () => {
      cancelled = true;
    };
  }, [fileSource, matches]);

  // --- 3. Đo toạ độ pixel THẬT của match trên trang đang hiển thị, bằng
  //         Range API trên text layer thật của trình duyệt. Đây là lý do hết
  //         lem hoàn toàn: không còn tự suy ra vị trí/độ rộng chữ bằng công
  //         thức transform hay ước lượng tỉ lệ ký tự nữa, mà lấy đúng
  //         getClientRects() của chính đoạn text đó do trình duyệt layout ra. ---
  const measureCurrentPage = useCallback(() => {
    const container = pageContainerRef.current;
    const locations = matchLocationsCache.current[pageNumber];
    if (!container || !locations || locations.length === 0) {
      setPageRects([]);
      return;
    }
    const spans = container.querySelectorAll<HTMLElement>("span");
    if (spans.length === 0) {
      setPageRects([]);
      return;
    }
    const containerRect = container.getBoundingClientRect();
    const rects: HighlightRect[] = [];

    for (const loc of locations) {
      const startSpan = spans[loc.itemStart];
      const endSpan = spans[loc.itemEnd];
      const startNode = startSpan?.firstChild;
      const endNode = endSpan?.firstChild;
      if (!startNode || !endNode) continue;

      try {
        const range = document.createRange();
        const startLen = startNode.textContent?.length ?? 0;
        const endLen = endNode.textContent?.length ?? 0;
        range.setStart(startNode, Math.min(loc.startOffsetInItem, startLen));
        range.setEnd(endNode, Math.min(loc.endOffsetInItem + 1, endLen));

        for (const cr of Array.from(range.getClientRects())) {
          if (cr.width <= 0 || cr.height <= 0) continue;
          rects.push({
            matchId: loc.id,
            severity: loc.severity,
            x: cr.left - containerRect.left,
            y: cr.top - containerRect.top,
            width: cr.width,
            height: cr.height,
          });
        }
      } catch {
        // Bỏ qua nếu range không hợp lệ (hiếm gặp, VD trang có cấu trúc đặc biệt)
      }
    }

    setPageRects(dedupeOverlappingRects(rects));
  }, [pageNumber]);

  // Xoá highlight cũ ngay khi đổi trang/zoom để không hiện sai vị trí trong
  // lúc chờ trang mới render xong (measureCurrentPage sẽ tự chạy lại qua
  // onRenderTextLayerSuccess bên dưới).
  useEffect(() => {
    setPageRects([]);
  }, [pageNumber, scale]);

  // --- 4. Nhảy tới trang chứa match khi activeMatchId đổi ---
  useEffect(() => {
    if (!activeMatchId) return;
    const targetPage = Object.entries(matchesByPage).find(([, ids]) => ids.includes(activeMatchId))?.[0];
    if (targetPage) setPageNumber(Number(targetPage));
  }, [activeMatchId, matchesByPage]);

  function onDocumentLoadSuccess({ numPages }: { numPages: number }) {
    setNumPages(numPages);
    setPageNumber(1);
    setLoadError(null);
  }

  function onDocumentLoadError(err: Error) {
    console.error("PDF load error:", err);
    setLoadError("Không thể tải file PDF. File có thể bị lỗi cấu trúc hoặc không được hỗ trợ.");
  }

  const isPreparingFile = typeof pdfUrl !== "string" && !fileBuffer && !bufferError;
  const severityCounts = useMemo(() => {
    const counts: Record<Severity, number> = { high: 0, moderate: 0, low: 0 };
    pageRects.forEach((r) => {
      counts[r.severity] = (counts[r.severity] ?? 0) + 1;
    });
    return counts;
  }, [pageRects]);
  const hoveredMatch = hoveredMatchId ? matchById.get(hoveredMatchId) : null;
  const hoveredRect = hoveredMatchId ? pageRects.find((r) => r.matchId === hoveredMatchId) : null;

  return (
    <div className="rounded-[var(--radius-card)] border border-line bg-surface-tint p-4">
      {/* Toolbar */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPageNumber((p) => Math.max(1, p - 1))}
            disabled={pageNumber <= 1}
            className="flex size-8 items-center justify-center rounded-lg border border-line bg-white text-ink-600 disabled:opacity-40"
            aria-label="Trang trước"
          >
            <CaretLeft size={16} />
          </button>
          <span className="text-sm font-medium text-ink-700">
            Trang {pageNumber} / {numPages ?? "..."}
            {analyzing && <span className="ml-2 text-xs text-ink-400">(đang quét trùng lặp...)</span>}
          </span>
          <button
            onClick={() => setPageNumber((p) => Math.min(numPages ?? p, p + 1))}
            disabled={!numPages || pageNumber >= numPages}
            className="flex size-8 items-center justify-center rounded-lg border border-line bg-white text-ink-600 disabled:opacity-40"
            aria-label="Trang sau"
          >
            <CaretRight size={16} />
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setScale((s) => Math.max(0.6, s - 0.1))}
            className="flex size-8 items-center justify-center rounded-lg border border-line bg-white text-ink-600"
            aria-label="Thu nhỏ"
          >
            <MagnifyingGlassMinus size={16} />
          </button>
          <span className="w-12 text-center text-xs font-medium text-ink-500">
            {Math.round(scale * 100)}%
          </span>
          <button
            onClick={() => setScale((s) => Math.min(2, s + 0.1))}
            className="flex size-8 items-center justify-center rounded-lg border border-line bg-white text-ink-600"
            aria-label="Phóng to"
          >
            <MagnifyingGlassPlus size={16} />
          </button>
        </div>
      </div>

      {/* Legend mức độ trùng lặp, kiểu Turnitin */}
      {pageRects.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-4 rounded-lg border border-line bg-white px-3 py-2 text-xs">
          {(Object.keys(SEVERITY_LABEL) as Severity[]).map((sev) => (
            <div key={sev} className="flex items-center gap-1.5">
              <span
                className="inline-block size-2.5 rounded-full"
                style={{ backgroundColor: SEVERITY_COLOR[sev].border }}
              />
              <span className="text-ink-600">{SEVERITY_LABEL[sev]}</span>
              <span className="font-semibold text-ink-800">{severityCounts[sev] ?? 0}</span>
            </div>
          ))}
        </div>
      )}

      {/* Viewer */}
      <div className="flex justify-center overflow-auto rounded-lg bg-ink-100/40 p-4">
        {!pdfUrl ? (
          <p
            className={`py-12 text-sm ${unavailableMessage ? "font-medium text-severity-high" : "text-ink-400"}`}
          >
            {unavailableMessage ?? "Không có file PDF gốc để hiển thị preview."}
          </p>
        ) : bufferError ? (
          <p className="py-12 text-sm font-medium text-severity-high">{bufferError}</p>
        ) : loadError ? (
          <p className="py-12 text-sm font-medium text-severity-high">{loadError}</p>
        ) : isPreparingFile ? (
          <p className="py-12 text-sm text-ink-400">Đang chuẩn bị file...</p>
        ) : fileSource ? (
          <Document
            file={fileSource}
            onLoadSuccess={onDocumentLoadSuccess}
            onLoadError={onDocumentLoadError}
            loading={<p className="py-12 text-sm text-ink-400">Đang tải PDF...</p>}
          >
            <div ref={pageContainerRef} className="relative inline-block shadow-[var(--shadow-card)]">
              <Page
                pageNumber={pageNumber}
                scale={scale}
                renderAnnotationLayer={false}
                renderTextLayer
                onRenderTextLayerSuccess={measureCurrentPage}
              />

              {/* Overlay highlight - toạ độ đã là pixel thật, không nhân scale nữa */}
              <div className="pointer-events-none absolute inset-0">
                {pageRects.map((r, i) => {
                  const isActive = activeMatchId === r.matchId;
                  const isHovered = hoveredMatchId === r.matchId;
                  const color = SEVERITY_COLOR[r.severity] ?? SEVERITY_COLOR.moderate;
                  return (
                    <div
                      key={`${r.matchId}-${i}`}
                      onClick={() => onMatchClick?.(r.matchId)}
                      onMouseEnter={() => setHoveredMatchId(r.matchId)}
                      onMouseLeave={() => setHoveredMatchId((cur) => (cur === r.matchId ? null : cur))}
                      className="pointer-events-auto absolute cursor-pointer rounded-[3px] transition-colors"
                      style={{
                        left: r.x,
                        top: r.y,
                        width: r.width,
                        height: r.height,
                        backgroundColor: isActive || isHovered ? color.fillActive : color.fill,
                        boxShadow: `inset 0 0 0 1px ${color.border}`,
                      }}
                    />
                  );
                })}
              </div>

              {/* Tooltip khi hover */}
              {hoveredMatch && hoveredRect && (
                <div
                  className="pointer-events-none absolute z-30 max-w-xs rounded-lg border border-line bg-navy-900 px-3 py-2 text-xs text-white shadow-[var(--shadow-pop)]"
                  style={{
                    left: hoveredRect.x,
                    top: Math.max(0, hoveredRect.y - 8),
                    transform: "translateY(-100%)",
                  }}
                >
                  <p className="font-semibold text-white">
                    {SEVERITY_LABEL[hoveredMatch.severity]} · {hoveredMatch.matchPercent}%
                  </p>
                  <p className="mt-0.5 truncate text-ink-300">{hoveredMatch.sourceTitle}</p>
                </div>
              )}
            </div>
          </Document>
        ) : null}
      </div>

      {/* Chỉ báo trang nào có match, để nhảy nhanh */}
      {numPages && Object.keys(matchesByPage).length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {Object.keys(matchesByPage)
            .map(Number)
            .sort((a, b) => a - b)
            .map((p) => (
              <button
                key={p}
                onClick={() => setPageNumber(p)}
                className={`rounded-md border px-2 py-1 text-xs font-medium ${
                  p === pageNumber
                    ? "border-brand-400 bg-brand-100 text-brand-700"
                    : "border-line bg-white text-ink-500 hover:border-brand-300"
                }`}
              >
                Trang {p} ({matchesByPage[p].length})
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
