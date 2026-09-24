import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import { CaretLeft, CaretRight, MagnifyingGlassMinus, MagnifyingGlassPlus } from "@phosphor-icons/react";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import type { MatchedSource, Severity } from "../lib/types";
import { extractWordTokens, findFuzzyMatch, normalize, normalizeWithMap } from "../lib/textMatch";
import { t, tr } from "../lib/i18n";

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
  /** Fires whenever the current page or total page count changes, so a
   * parent status bar (WordCountPill) can show "Page X of Y" for this view
   * too, not just the editable Document view. */
  onPageChange?: (page: number, pageCount: number) => void;
  /** Character offset (into the document's full text) past which the word
   * limit has been exceeded. `Infinity`/undefined means nothing is over the
   * limit. See the suppression logic inside `measurePage` for exactly how
   * this is used — it's a deliberate approximation, documented there. */
  overLimitOffset?: number;
  /** AI-detection segments to give the same "find it on the page" treatment
   * as plagiarism matches — a separate, always-violet wash (DESIGN.md's
   * Functional Wall Rule: different signal, never sharing severity colours).
   * Located by searching each page's text layer for `excerpt`, the same way
   * matches are searched for `userSnippet` — this viewer only ever sees
   * rendered PDF text, never the backend's character offsets. Optional so
   * existing callers (e.g. Upload's bare file preview) don't need it. */
  aiSegments?: { id: string; excerpt: string; score: number }[];
  activeAiSegmentId?: string | null;
  onAiSegmentClick?: (segmentId: string) => void;
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

// Cùng cấu trúc MatchLocation/HighlightRect ở trên nhưng cho đoạn nghi AI viết
// - không có severity (AI detection không phân mức cao/vừa/thấp như đạo văn),
// tô 1 màu tím cố định, đo bằng đúng cơ chế Range API như match.
type AiSegmentLocation = {
  id: string;
  itemStart: number;
  startOffsetInItem: number;
  itemEnd: number;
  endOffsetInItem: number;
};

type AiHighlightRect = {
  segmentId: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

const SEVERITY_COLOR: Record<Severity, { fill: string; fillActive: string; border: string }> = {
  high: { fill: "rgba(220, 38, 38, 0.16)", fillActive: "rgba(220, 38, 38, 0.38)", border: "rgba(220, 38, 38, 0.55)" },
  moderate: { fill: "rgba(217, 119, 6, 0.15)", fillActive: "rgba(217, 119, 6, 0.36)", border: "rgba(217, 119, 6, 0.55)" },
  low: { fill: "rgba(37, 99, 235, 0.13)", fillActive: "rgba(37, 99, 235, 0.34)", border: "rgba(37, 99, 235, 0.5)" },
};

// Cùng màu --color-ai-flag (#7c3aed) dùng cho chip/card AI Detection ở
// sidebar, để 2 nơi luôn khớp nhau về mặt màu sắc.
const AI_FLAG_COLOR = {
  fill: "rgba(124, 58, 237, 0.10)",
  fillActive: "rgba(124, 58, 237, 0.24)",
  border: "rgba(124, 58, 237, 0.4)",
};

const SEVERITY_LABEL: Record<Severity, string> = {
  high: tr("High match"),
  moderate: tr("Moderate match"),
  low: tr("Common phrasing"),
};

const SEVERITY_RANK: Record<Severity, number> = { high: 3, moderate: 2, low: 1 };

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
  onPageChange,
  overLimitOffset = Infinity,
  aiSegments = [],
  activeAiSegmentId = null,
  onAiSegmentClick,
}: PlagiarismPdfViewerProps) {
  const [numPages, setNumPages] = useState<number | null>(null);
  // "Trang hiện tại" giờ không còn điều khiển việc render nữa (mọi trang đều
  // được mount cùng lúc trong dải cuộn dài) - nó chỉ là trang đang hiển thị
  // nhiều nhất trong khung nhìn, dùng cho chỉ báo "Trang X / Y" + để biết mũi
  // tên trước/sau nên cuộn tới đâu. Được cập nhật bởi scroll listener bên dưới.
  const [currentPage, setCurrentPage] = useState(1);
  const [scale, setScale] = useState(1.1);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [fileBuffer, setFileBuffer] = useState<ArrayBuffer | null>(null);
  const [bufferError, setBufferError] = useState<string | null>(null);

  // Trang nào có match nào (chỉ để hiện chỉ báo trang + nhảy trang) - KHÔNG
  // chứa toạ độ hình học, nên không thể bị lem.
  const [matchesByPage, setMatchesByPage] = useState<Record<number, string[]>>({});
  const [analyzing, setAnalyzing] = useState(false);
  const [hoveredMatchId, setHoveredMatchId] = useState<string | null>(null);

  // Toạ độ pixel thật của các match, đo trực tiếp từ DOM text layer của TỪNG
  // TRANG mỗi khi trang đó render text layer xong - khoá theo số trang vì bây
  // giờ mọi trang đều mount cùng lúc (chính xác tuyệt đối, không lem).
  const [pageRects, setPageRects] = useState<Record<number, HighlightRect[]>>({});

  // Song song với matchesByPage/pageRects/matchLocationsCache ở trên, nhưng
  // cho đoạn AI - tách riêng hẳn (không gộp chung state) để không đụng vào
  // logic match đã chạy ổn định.
  const [aiSegmentsByPage, setAiSegmentsByPage] = useState<Record<number, string[]>>({});
  const [aiPageRects, setAiPageRects] = useState<Record<number, AiHighlightRect[]>>({});
  const aiLocationsCache = useRef<Record<number, AiSegmentLocation[]>>({});

  const matchLocationsCache = useRef<Record<number, MatchLocation[]>>({});
  // Container DOM của từng trang (để đo Range/getClientRects và để scrollIntoView).
  const pageContainerRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  // Vùng cuộn thực sự của viewer (KHÔNG phải toàn bộ trang Report) - đây là
  // "zone" nội bộ mà bước 1 yêu cầu, để trang Report bên ngoài không bị cuộn theo.
  const viewerRef = useRef<HTMLDivElement | null>(null);

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

  // Đổi file (tài liệu mới) -> mọi ref/toạ độ trang cũ không còn hợp lệ nữa.
  useEffect(() => {
    pageContainerRefs.current.clear();
    setPageRects({});
    setAiPageRects({});
    setCurrentPage(1);
  }, [fileSource]);

  // --- 2. Đo toạ độ pixel THẬT của match trên MỘT trang cụ thể, bằng Range
  //         API trên text layer thật của trình duyệt. Đây là lý do hết lem
  //         hoàn toàn: không còn tự suy ra vị trí/độ rộng chữ bằng công thức
  //         transform hay ước lượng tỉ lệ ký tự nữa, mà lấy đúng
  //         getClientRects() của chính đoạn text đó do trình duyệt layout ra.
  //         Trước đây hàm này chỉ chạy cho "trang đang xem"; giờ mỗi trang
  //         trong dải cuộn dài tự gọi hàm này qua onRenderTextLayerSuccess
  //         của chính nó, nên tất cả các trang đã mount đều được tô cùng lúc. ---
  const measurePage = useCallback(
    (page: number) => {
      const container = pageContainerRefs.current.get(page);
      const locations = matchLocationsCache.current[page];
      if (!container || !locations || locations.length === 0) {
        setPageRects((prev) => {
          if (!(page in prev)) return prev;
          const next: Record<number, HighlightRect[]> = {};
          for (const key of Object.keys(prev)) {
            const k = Number(key);
            if (k !== page) next[k] = prev[k];
          }
          return next;
        });
        return;
      }
      const spans = container.querySelectorAll<HTMLElement>("span");
      if (spans.length === 0) {
        setPageRects((prev) => ({ ...prev, [page]: [] }));
        return;
      }
      const containerRect = container.getBoundingClientRect();
      const rects: HighlightRect[] = [];

      for (const loc of locations) {
        // --- Ẩn highlight của các match đã vượt giới hạn số từ ---------------
        // `overLimitOffset` là offset ký tự (vào full text tài liệu) đánh dấu
        // ranh giới "quá giới hạn". Chỉ những match CÓ `startOffset` từ backend
        // mới được so sánh chính xác với ranh giới này - nếu match không có
        // `startOffset` (rất nhiều match chỉ có snippet text, không có offset
        // tuyệt đối) thì KHÔNG đoán mò vị trí của nó, cứ tô bình thường. Đây là
        // lựa chọn đơn giản hoá có chủ đích (không phải thiếu sót): suy ra vị
        // trí gần đúng cho match không có offset kém tin cậy hơn là cứ hiển thị nó.
        const src = matchById.get(loc.id);
        if (src?.startOffset != null && src.startOffset >= overLimitOffset) continue;

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

      setPageRects((prev) => ({ ...prev, [page]: dedupeOverlappingRects(rects) }));
    },
    [matchById, overLimitOffset],
  );

  // Song song measurePage() ở trên, nhưng đo vị trí pixel của đoạn AI-flagged
  // - cùng kỹ thuật Range API, tách hàm riêng (không gộp vào measurePage) để
  // không đụng/rủi ro logic match đã chạy ổn định. Không có khái niệm
  // "overLimitOffset suppression" hay severity ở đây - AI segments không có 2
  // khái niệm đó.
  const measureAiPage = useCallback((page: number) => {
    const container = pageContainerRefs.current.get(page);
    const locations = aiLocationsCache.current[page];
    if (!container || !locations || locations.length === 0) {
      setAiPageRects((prev) => {
        if (!(page in prev)) return prev;
        const next: Record<number, AiHighlightRect[]> = {};
        for (const key of Object.keys(prev)) {
          const k = Number(key);
          if (k !== page) next[k] = prev[k];
        }
        return next;
      });
      return;
    }
    const spans = container.querySelectorAll<HTMLElement>("span");
    if (spans.length === 0) {
      setAiPageRects((prev) => ({ ...prev, [page]: [] }));
      return;
    }
    const containerRect = container.getBoundingClientRect();
    const rects: AiHighlightRect[] = [];

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
            segmentId: loc.id,
            x: cr.left - containerRect.left,
            y: cr.top - containerRect.top,
            width: cr.width,
            height: cr.height,
          });
        }
      } catch {
        // Bỏ qua nếu range không hợp lệ, giống measurePage().
      }
    }

    setAiPageRects((prev) => ({ ...prev, [page]: rects }));
  }, []);

  // --- 3. Quét toàn bộ văn bản để biết trang nào có match nào, và lưu lại vị
  //         trí "logic" (item + offset ký tự) của từng match. KHÔNG tính toạ
  //         độ pixel ở bước này - toạ độ pixel do trình duyệt tự đo thật khi
  //         từng trang render (bước 2), nên không còn sai số/lem nữa. ---
  useEffect(() => {
    if (!fileSource) return;
    if (matches.length === 0 && aiSegments.length === 0) {
      setMatchesByPage({});
      matchLocationsCache.current = {};
      setAiSegmentsByPage({});
      aiLocationsCache.current = {};
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
        const aiByPage: Record<number, string[]> = {};
        const aiLocCache: Record<number, AiSegmentLocation[]> = {};

        const normalizedSnippets = matches
          .filter((m) => m.userSnippet && m.userSnippet.trim().length > 0)
          .map((m) => ({ id: m.id, severity: m.severity, snippet: normalize(m.userSnippet) }));

        // Excerpt luôn là 160 ký tự đầu của đoạn, có thể bị cắt kèm "…" -
        // bỏ ký tự đó trước khi tìm, không thì indexOf/fuzzy sẽ không bao
        // giờ khớp (trang PDF không có ký tự "…" ở giữa câu).
        const normalizedAiSegments = aiSegments
          .map((s) => ({ id: s.id, snippet: normalize(s.excerpt.replace(/…$/, "").trim()) }))
          .filter((s) => s.snippet.length >= 8);

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
          // Chỉ tách từ khi thực sự cần fallback (indexOf thất bại) - tránh
          // tốn chi phí cho trường hợp phổ biến là khớp tuyệt đối thành công.
          let pageTokensCache: ReturnType<typeof extractWordTokens> | null = null;
          const getPageTokens = () => (pageTokensCache ??= extractWordTokens(normalizedPageText));

          for (const { id, severity, snippet } of normalizedSnippets) {
            if (!snippet || snippet.length < 8) continue; // câu quá ngắn dễ match sai

            let matchStart: number;
            let matchEndInclusive: number;

            const idx = normalizedPageText.indexOf(snippet);
            if (idx !== -1) {
              matchStart = idx;
              matchEndInclusive = idx + snippet.length - 1;
            } else {
              // Khớp tuyệt đối thất bại - thử fallback mờ theo chuỗi từ thay
              // vì âm thầm bỏ qua match này (đây chính là lỗi khiến nhiều
              // match không được highlight dù thực sự có trên trang).
              const snippetWords = snippet.split(" ").filter(Boolean);
              const fuzzy = findFuzzyMatch(getPageTokens(), snippetWords);
              if (!fuzzy) continue;
              matchStart = fuzzy.start;
              matchEndInclusive = fuzzy.end;
            }

            const rawStart = rawIndexMap[matchStart] ?? 0;
            const rawEnd =
              rawIndexMap[Math.min(matchEndInclusive, rawIndexMap.length - 1)] ?? rawStart;

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

          // Cùng cơ chế tìm kiếm ở trên (exact rồi fuzzy), tái dùng đúng
          // normalizedPageText/rawIndexMap/charToItem/getPageTokens vừa tính
          // cho trang này - không parse lại PDF lần 2.
          for (const { id, snippet } of normalizedAiSegments) {
            let matchStart: number;
            let matchEndInclusive: number;

            const idx = normalizedPageText.indexOf(snippet);
            if (idx !== -1) {
              matchStart = idx;
              matchEndInclusive = idx + snippet.length - 1;
            } else {
              const snippetWords = snippet.split(" ").filter(Boolean);
              const fuzzy = findFuzzyMatch(getPageTokens(), snippetWords);
              if (!fuzzy) continue;
              matchStart = fuzzy.start;
              matchEndInclusive = fuzzy.end;
            }

            const rawStart = rawIndexMap[matchStart] ?? 0;
            const rawEnd =
              rawIndexMap[Math.min(matchEndInclusive, rawIndexMap.length - 1)] ?? rawStart;

            const itemStart = charToItem[rawStart] ?? 0;
            const itemEnd = charToItem[rawEnd] ?? charToItem[charToItem.length - 1] ?? 0;
            const startOffsetInItem = charOffsetInItem[rawStart] ?? 0;
            const endOffsetInItem = charOffsetInItem[rawEnd] ?? 0;

            (aiByPage[pageIdx] ??= []).push(id);
            (aiLocCache[pageIdx] ??= []).push({
              id,
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
          aiLocationsCache.current = aiLocCache;
          setAiSegmentsByPage(aiByPage);
          // Các trang trong dải cuộn dài có thể đã render text layer XONG
          // TRƯỚC KHI bước quét này hoàn tất (chạy song song), nên chủ động đo
          // lại toàn bộ trang đã mount ngay khi có kết quả quét mới, thay vì
          // chờ một sự kiện render khác không chắc sẽ xảy ra.
          requestAnimationFrame(() => {
            if (cancelled) return;
            pageContainerRefs.current.forEach((_, p) => {
              measurePage(p);
              measureAiPage(p);
            });
          });
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
    // measurePage/measureAiPage cố ý không nằm trong dependency: chúng chỉ
    // được gọi lại ở đây để "bù" race giữa quét văn bản và render trang,
    // không phải điều khiển luồng chính của effect này (chỉ nên chạy lại khi
    // file/matches/aiSegments đổi).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileSource, matches, aiSegments]);

  // Xoá toàn bộ highlight cũ ngay khi đổi zoom để không hiện sai vị trí trong
  // lúc chờ các trang render lại theo scale mới (mỗi trang sẽ tự đo lại qua
  // onRenderTextLayerSuccess bên dưới).
  useEffect(() => {
    setPageRects({});
    setAiPageRects({});
  }, [scale]);

  useEffect(() => {
    if (numPages) onPageChange?.(currentPage, numPages);
  }, [currentPage, numPages, onPageChange]);

  // --- 4. Xác định trang nào đang "hiện diện" nhiều nhất trong khung nhìn của
  //         chính viewer (không phải window/Report page), dùng cùng kỹ thuật
  //         với DocumentCanvas.measurePages(): so sánh mép trên của từng trang
  //         với một "đường tham chiếu" nằm gần đỉnh khung nhìn. ---
  const updateCurrentPage = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer || !numPages) return;
    const viewerRect = viewer.getBoundingClientRect();
    const viewportLine = viewerRect.top + viewerRect.height * 0.35;
    let current = 1;
    for (let p = 1; p <= numPages; p++) {
      const el = pageContainerRefs.current.get(p);
      if (!el) continue;
      if (el.getBoundingClientRect().top <= viewportLine) current = p;
    }
    setCurrentPage((prev) => (prev === current ? prev : current));
  }, [numPages]);

  useEffect(() => {
    if (!numPages) return;
    const raf = requestAnimationFrame(updateCurrentPage);
    return () => cancelAnimationFrame(raf);
  }, [numPages, updateCurrentPage]);

  // Cuộn mượt viewer nội bộ tới 1 trang cụ thể - thay cho việc đổi pageNumber
  // để "nhảy trang" như trước, vì giờ mọi trang đều đã mount sẵn trong dải dài.
  const scrollToPage = useCallback((page: number) => {
    const el = pageContainerRefs.current.get(page);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  // --- 5. Cuộn tới trang chứa match khi activeMatchId đổi ---
  useEffect(() => {
    if (!activeMatchId) return;
    const targetPage = Object.entries(matchesByPage).find(([, ids]) => ids.includes(activeMatchId))?.[0];
    if (targetPage) scrollToPage(Number(targetPage));
  }, [activeMatchId, matchesByPage, scrollToPage]);

  // Cùng cơ chế ở trên, cho việc bấm 1 đoạn "nghi AI viết" từ card sidebar.
  useEffect(() => {
    if (!activeAiSegmentId) return;
    const targetPage = Object.entries(aiSegmentsByPage).find(([, ids]) => ids.includes(activeAiSegmentId))?.[0];
    if (targetPage) scrollToPage(Number(targetPage));
  }, [activeAiSegmentId, aiSegmentsByPage, scrollToPage]);

  function onDocumentLoadSuccess({ numPages }: { numPages: number }) {
    setNumPages(numPages);
    setCurrentPage(1);
    setLoadError(null);
  }

  function onDocumentLoadError(err: Error) {
    console.error("PDF load error:", err);
    setLoadError(tr("Could not load the PDF. The file may be corrupted or unsupported."));
  }

  const isPreparingFile = typeof pdfUrl !== "string" && !fileBuffer && !bufferError;
  const severityCounts = useMemo(() => {
    const counts: Record<Severity, number> = { high: 0, moderate: 0, low: 0 };
    Object.values(pageRects).forEach((rects) => {
      rects.forEach((r) => {
        counts[r.severity] = (counts[r.severity] ?? 0) + 1;
      });
    });
    return counts;
  }, [pageRects]);
  const hasHighlights = severityCounts.high + severityCounts.moderate + severityCounts.low > 0;
  const aiSegmentCount = useMemo(() => {
    const ids = new Set<string>();
    Object.values(aiPageRects).forEach((rects) => rects.forEach((r) => ids.add(r.segmentId)));
    return ids.size;
  }, [aiPageRects]);
  const hoveredMatch = hoveredMatchId ? matchById.get(hoveredMatchId) : null;
  const hoveredLocation = useMemo(() => {
    if (!hoveredMatchId) return null;
    for (const [pageStr, rects] of Object.entries(pageRects)) {
      const rect = rects.find((r) => r.matchId === hoveredMatchId);
      if (rect) return { page: Number(pageStr), rect };
    }
    return null;
  }, [hoveredMatchId, pageRects]);

  const pageNumbers = useMemo(
    () => (numPages ? Array.from({ length: numPages }, (_, i) => i + 1) : []),
    [numPages],
  );

  return (
    <div className="flex h-full flex-col rounded-[var(--radius-card)] border border-line bg-surface-tint p-4">
      {/* Toolbar */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => scrollToPage(Math.max(1, currentPage - 1))}
            disabled={currentPage <= 1}
            className="flex size-8 items-center justify-center rounded-lg border border-line bg-white text-ink-600 disabled:opacity-40"
            aria-label={t("Previous page")}
          >
            <CaretLeft size={16} />
          </button>
          <span className="text-sm font-medium text-ink-700">
            {t("Page")}{" "}{currentPage} / {numPages ?? "..."}
            {analyzing && <span className="ml-2 text-xs text-ink-400">{t("(scanning for overlaps...)")}</span>}
          </span>
          <button
            onClick={() => scrollToPage(Math.min(numPages ?? currentPage, currentPage + 1))}
            disabled={!numPages || currentPage >= numPages}
            className="flex size-8 items-center justify-center rounded-lg border border-line bg-white text-ink-600 disabled:opacity-40"
            aria-label={t("Next page")}
          >
            <CaretRight size={16} />
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setScale((s) => Math.max(0.6, s - 0.1))}
            className="flex size-8 items-center justify-center rounded-lg border border-line bg-white text-ink-600"
            aria-label={t("Zoom out")}
          >
            <MagnifyingGlassMinus size={16} />
          </button>
          <span className="w-12 text-center text-xs font-medium text-ink-500">
            {Math.round(scale * 100)}%
          </span>
          <button
            onClick={() => setScale((s) => Math.min(2, s + 0.1))}
            className="flex size-8 items-center justify-center rounded-lg border border-line bg-white text-ink-600"
            aria-label={t("Zoom in")}
          >
            <MagnifyingGlassPlus size={16} />
          </button>
        </div>
      </div>

      {/* Legend mức độ trùng lặp, kiểu Turnitin */}
      {(hasHighlights || aiSegmentCount > 0) && (
        <div className="mb-3 flex flex-wrap items-center gap-4 rounded-lg border border-line bg-white px-3 py-2 text-xs">
          {(Object.keys(SEVERITY_LABEL) as Severity[]).map((sev) => (
            <div key={sev} className="flex items-center gap-1.5">
              <span
                className="inline-block size-2.5 rounded-full"
                style={{ backgroundColor: SEVERITY_COLOR[sev].border }}
              />
              <span className="text-ink-600">{t(SEVERITY_LABEL[sev])}</span>
              <span className="font-semibold text-ink-800">{severityCounts[sev] ?? 0}</span>
            </div>
          ))}
          {aiSegmentCount > 0 && (
            <div className="flex items-center gap-1.5 border-l border-line pl-4">
              <span
                className="inline-block size-2.5 rounded-full"
                style={{ backgroundColor: AI_FLAG_COLOR.border }}
              />
              <span className="text-ink-600">{t("AI content")}</span>
              <span className="font-semibold text-ink-800">{aiSegmentCount}</span>
            </div>
          )}
        </div>
      )}

      {/* Viewer - đây là "vùng riêng" của component này: overflow-y-auto tự
          quản lý cuộn dải dài nhiều trang, KHÔNG đụng tới scroll của trang
          Report bên ngoài (Report/index.tsx đã bọc component này trong 1 div
          `relative flex-1 overflow-hidden`). */}
      <div
        ref={viewerRef}
        onScroll={updateCurrentPage}
        className="min-h-0 flex-1 overflow-y-auto rounded-lg bg-ink-100/40 p-4"
      >
        {!pdfUrl ? (
          <p
            className={`py-12 text-center text-sm ${unavailableMessage ? "font-medium text-severity-high" : "text-ink-400"}`}
          >
            {t(unavailableMessage) ?? t("No original PDF available to preview.")}
          </p>
        ) : bufferError ? (
          <p className="py-12 text-center text-sm font-medium text-severity-high">{t(bufferError)}</p>
        ) : loadError ? (
          <p className="py-12 text-center text-sm font-medium text-severity-high">{t(loadError)}</p>
        ) : isPreparingFile ? (
          <p className="py-12 text-center text-sm text-ink-400">{t("Preparing file...")}</p>
        ) : fileSource ? (
          <Document
            file={fileSource}
            onLoadSuccess={onDocumentLoadSuccess}
            onLoadError={onDocumentLoadError}
            loading={<p className="py-12 text-center text-sm text-ink-400">{t("Loading PDF...")}</p>}
          >
            {/* Dải trang dài cuộn liên tục - mọi trang được mount cùng lúc,
                xếp dọc, thay cho việc chỉ mount 1 <Page> theo pageNumber. */}
            <div className="flex flex-col items-center gap-6">
              {pageNumbers.map((p) => {
                const rects = pageRects[p] ?? [];
                const aiRects = aiPageRects[p] ?? [];
                return (
                  <div
                    key={p}
                    ref={(el) => {
                      if (el) pageContainerRefs.current.set(p, el);
                      else pageContainerRefs.current.delete(p);
                    }}
                    data-page-number={p}
                    className="relative inline-block shadow-[var(--shadow-card)]"
                  >
                    <Page
                      pageNumber={p}
                      scale={scale}
                      renderAnnotationLayer={false}
                      renderTextLayer
                      onRenderTextLayerSuccess={() => {
                        measurePage(p);
                        measureAiPage(p);
                        updateCurrentPage();
                      }}
                    />

                    {/* Overlay đoạn nghi AI viết - vẽ TRƯỚC overlay match nên
                        nằm DƯỚI nó trong thứ tự DOM/stacking: match (câu, hẹp
                        hơn) luôn nhận click trước khi trùng vùng với AI wash
                        (đoạn, rộng hơn) - đúng "Functional Wall Rule", 2 tín
                        hiệu vẫn tách biệt về màu/click nhưng không giành nhau. */}
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
                              backgroundColor: isActive ? AI_FLAG_COLOR.fillActive : AI_FLAG_COLOR.fill,
                              boxShadow: isActive ? `inset 0 0 0 1px ${AI_FLAG_COLOR.border}` : undefined,
                            }}
                          />
                        );
                      })}
                    </div>

                    {/* Overlay highlight - toạ độ đã là pixel thật, không nhân scale nữa */}
                    <div className="pointer-events-none absolute inset-0">
                      {rects.map((r, i) => {
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

                    {/* Tooltip khi hover - chỉ render trên đúng trang chứa match đang hover */}
                    {hoveredMatch && hoveredLocation && hoveredLocation.page === p && (
                      <div
                        className="pointer-events-none absolute z-30 max-w-xs rounded-lg border border-line bg-navy-900 px-3 py-2 text-xs text-white shadow-[var(--shadow-pop)]"
                        style={{
                          left: hoveredLocation.rect.x,
                          top: Math.max(0, hoveredLocation.rect.y - 8),
                          transform: "translateY(-100%)",
                        }}
                      >
                        <p className="font-semibold text-white">
                          {t(SEVERITY_LABEL[hoveredMatch.severity])} · {hoveredMatch.matchPercent}%
                        </p>
                        <p className="mt-0.5 truncate text-ink-300">{hoveredMatch.sourceTitle}</p>
                      </div>
                    )}
                  </div>
                );
              })}
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
                onClick={() => scrollToPage(p)}
                className={`rounded-md border px-2 py-1 text-xs font-medium ${
                  p === currentPage
                    ? "border-brand-400 bg-brand-100 text-brand-700"
                    : "border-line bg-white text-ink-500 hover:border-brand-300"
                }`}
              >
                {t("Page")}{" "}{p} ({matchesByPage[p].length})
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
