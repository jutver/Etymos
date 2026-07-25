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
  /** Fires whenever the current page or total page count changes, so a
   * parent status bar (WordCountPill) can show "Page X of Y" for this view
   * too, not just the editable Document view. */
  onPageChange?: (page: number, pageCount: number) => void;
  /** Character offset (into the document's full text) past which the word
   * limit has been exceeded. `Infinity`/undefined means nothing is over the
   * limit. See the suppression logic inside `measurePage` for exactly how
   * this is used — it's a deliberate approximation, documented there. */
  overLimitOffset?: number;
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
    // Dehyphenate line-wrap artifacts ("exam-\nple" / "exam- ple" -> "example")
    // BEFORE collapsing whitespace, so a hyphen followed by any run of
    // whitespace (space, newline, tab) is treated as a PDF line break, not a
    // real hyphenated word.
    .replace(/-\s+/g, "")
    .replace(/\s+/g, " ")
    .replace(/[""'']/g, '"')
    .trim();
}

// Chuẩn hoá text NHƯNG giữ bảng ánh xạ 1-1 từ mỗi ký tự trong chuỗi đã
// chuẩn hoá về đúng vị trí ký tự tương ứng trong chuỗi gốc.
//
// Cũng dehyphenate ngay tại đây: một dấu "-" đứng ngay sau 1 ký tự chữ và
// theo sau là khoảng trắng gần như luôn là dấu ngắt dòng do PDF tự chèn
// (VD "context-\nual"), không phải dấu gạch nối thật - nên bỏ luôn cả "-" và
// khoảng trắng theo sau để khớp lại thành "contextual", giống hệt cách
// `normalize()` xử lý snippet gốc phía trên.
function normalizeWithMap(raw: string): { normalized: string; map: number[] } {
  let normalized = "";
  const map: number[] = [];
  let lastWasSpace = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];

    if (ch === "-" && /\s/.test(raw[i + 1] ?? "")) {
      let j = i + 1;
      while (j < raw.length && /\s/.test(raw[j])) j++;
      i = j - 1; // vòng lặp ngoài sẽ tự i++ để nhảy qua hết khoảng trắng
      continue;
    }

    let ch2 = ch;
    if (ch2 === "“" || ch2 === "”" || ch2 === "‘" || ch2 === "’") ch2 = '"';
    const lower = ch2.toLowerCase();

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

// Tách text thành các "từ" (chuỗi không-khoảng-trắng liên tục) kèm vị trí ký
// tự bắt đầu/kết thúc trong chuỗi gốc - dùng làm đơn vị so khớp cho fallback
// mờ (fuzzy) bên dưới.
function extractWordTokens(text: string): { word: string; start: number; end: number }[] {
  const tokens: { word: string; start: number; end: number }[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    tokens.push({ word: m[0], start: m.index, end: m.index + m[0].length - 1 });
  }
  return tokens;
}

// Fallback "mờ" (fuzzy) khi indexOf khớp tuyệt đối thất bại: trích xuất PDF
// (pdf.js) thường lệch so với snippet gốc lưu ở backend (dấu gạch nối ngắt
// dòng còn sót, ligature, khoảng trắng thừa/thiếu do layout nhiều cột...).
// Đây KHÔNG phải một thư viện fuzzy-match đầy đủ - chỉ là so khớp theo cửa sổ
// trượt trên danh sách từ, đủ khoan dung để một match thật hiếm khi bị bỏ
// sót hoàn toàn. Neo (anchor) vào 1 trong 3 từ đầu của snippet để tránh quét
// O(số từ trang × kích thước cửa sổ) trên toàn bộ trang - chỉ thử các cửa sổ
// bắt đầu gần nơi thực sự xuất hiện 1 trong các từ neo đó.
function findFuzzyMatch(
  pageTokens: { word: string; start: number; end: number }[],
  snippetWords: string[],
): { start: number; end: number } | null {
  const target = snippetWords.length;
  if (target < 3 || pageTokens.length === 0) return null;

  const minWindow = Math.max(1, target - 2);
  const maxWindow = target + 4;

  const anchorWords = snippetWords.slice(0, 3);
  const anchorStarts = new Set<number>();
  pageTokens.forEach((t, i) => {
    if (anchorWords.includes(t.word)) anchorStarts.add(i);
  });
  if (anchorStarts.size === 0) return null;

  let best: { start: number; end: number; score: number } | null = null;
  for (const anchor of anchorStarts) {
    const winStart = Math.max(0, anchor - 2);
    for (let win = minWindow; win <= maxWindow; win++) {
      const end = winStart + win;
      if (end > pageTokens.length) break;
      const used = new Array(win).fill(false);
      let matchedCount = 0;
      for (const sw of snippetWords) {
        for (let k = 0; k < win; k++) {
          if (!used[k] && pageTokens[winStart + k].word === sw) {
            used[k] = true;
            matchedCount++;
            break;
          }
        }
      }
      const score = matchedCount / target;
      if (score >= 0.7 && (!best || score > best.score)) {
        best = { start: pageTokens[winStart].start, end: pageTokens[end - 1].end, score };
      }
    }
  }

  return best ? { start: best.start, end: best.end } : null;
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
  onPageChange,
  overLimitOffset = Infinity,
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

  // Đổi file (tài liệu mới) -> mọi ref/toạ độ trang cũ không còn hợp lệ nữa.
  useEffect(() => {
    pageContainerRefs.current.clear();
    setPageRects({});
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

  // --- 3. Quét toàn bộ văn bản để biết trang nào có match nào, và lưu lại vị
  //         trí "logic" (item + offset ký tự) của từng match. KHÔNG tính toạ
  //         độ pixel ở bước này - toạ độ pixel do trình duyệt tự đo thật khi
  //         từng trang render (bước 2), nên không còn sai số/lem nữa. ---
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
        }

        if (!cancelled) {
          matchLocationsCache.current = locCache;
          setMatchesByPage(byPage);
          // Các trang trong dải cuộn dài có thể đã render text layer XONG
          // TRƯỚC KHI bước quét này hoàn tất (chạy song song), nên chủ động đo
          // lại toàn bộ trang đã mount ngay khi có kết quả quét mới, thay vì
          // chờ một sự kiện render khác không chắc sẽ xảy ra.
          requestAnimationFrame(() => {
            if (cancelled) return;
            pageContainerRefs.current.forEach((_, p) => measurePage(p));
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
    // measurePage cố ý không nằm trong dependency: nó chỉ được gọi lại ở đây
    // để "bù" race giữa quét văn bản và render trang, không phải điều khiển
    // luồng chính của effect này (chỉ nên chạy lại khi file/matches đổi).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileSource, matches]);

  // Xoá toàn bộ highlight cũ ngay khi đổi zoom để không hiện sai vị trí trong
  // lúc chờ các trang render lại theo scale mới (mỗi trang sẽ tự đo lại qua
  // onRenderTextLayerSuccess bên dưới).
  useEffect(() => {
    setPageRects({});
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

  function onDocumentLoadSuccess({ numPages }: { numPages: number }) {
    setNumPages(numPages);
    setCurrentPage(1);
    setLoadError(null);
  }

  function onDocumentLoadError(err: Error) {
    console.error("PDF load error:", err);
    setLoadError("Không thể tải file PDF. File có thể bị lỗi cấu trúc hoặc không được hỗ trợ.");
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
            aria-label="Trang trước"
          >
            <CaretLeft size={16} />
          </button>
          <span className="text-sm font-medium text-ink-700">
            Trang {currentPage} / {numPages ?? "..."}
            {analyzing && <span className="ml-2 text-xs text-ink-400">(đang quét trùng lặp...)</span>}
          </span>
          <button
            onClick={() => scrollToPage(Math.min(numPages ?? currentPage, currentPage + 1))}
            disabled={!numPages || currentPage >= numPages}
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
      {hasHighlights && (
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
            {unavailableMessage ?? "Không có file PDF gốc để hiển thị preview."}
          </p>
        ) : bufferError ? (
          <p className="py-12 text-center text-sm font-medium text-severity-high">{bufferError}</p>
        ) : loadError ? (
          <p className="py-12 text-center text-sm font-medium text-severity-high">{loadError}</p>
        ) : isPreparingFile ? (
          <p className="py-12 text-center text-sm text-ink-400">Đang chuẩn bị file...</p>
        ) : fileSource ? (
          <Document
            file={fileSource}
            onLoadSuccess={onDocumentLoadSuccess}
            onLoadError={onDocumentLoadError}
            loading={<p className="py-12 text-center text-sm text-ink-400">Đang tải PDF...</p>}
          >
            {/* Dải trang dài cuộn liên tục - mọi trang được mount cùng lúc,
                xếp dọc, thay cho việc chỉ mount 1 <Page> theo pageNumber. */}
            <div className="flex flex-col items-center gap-6">
              {pageNumbers.map((p) => {
                const rects = pageRects[p] ?? [];
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
                        updateCurrentPage();
                      }}
                    />

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
                          {SEVERITY_LABEL[hoveredMatch.severity]} · {hoveredMatch.matchPercent}%
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
                Trang {p} ({matchesByPage[p].length})
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
