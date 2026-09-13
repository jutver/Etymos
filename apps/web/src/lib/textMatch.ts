/**
 * Snippet-in-text matching utilities shared by every viewer that has to
 * locate a backend match's `userSnippet` inside text it doesn't control the
 * exact extraction of (PDF text-layer text, marker-pdf's reflowed HTML...).
 *
 * Extracted out of PlagiarismPdfViewer.tsx (which pioneered this against
 * pdf.js's per-page text content) so MarkerDocumentViewer.tsx can reuse the
 * exact same normalize/fuzzy-match behaviour against a plain DOM tree
 * instead of duplicating it.
 */

export function normalize(text: string) {
  return text
    .toLowerCase()
    // Dehyphenate line-wrap artifacts ("exam-\nple" / "exam- ple" -> "example")
    // BEFORE collapsing whitespace, so a hyphen followed by any run of
    // whitespace (space, newline, tab) is treated as a line break, not a
    // real hyphenated word.
    .replace(/-\s+/g, "")
    .replace(/\s+/g, " ")
    .replace(/[""'']/g, '"')
    .trim();
}

// Chuẩn hoá text NHƯNG giữ bảng ánh xạ 1-1 từ mỗi ký tự trong chuỗi đã
// chuẩn hoá về đúng vị trí ký tự tương ứng trong chuỗi gốc.
export function normalizeWithMap(raw: string): { normalized: string; map: number[] } {
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

export interface WordToken {
  word: string;
  start: number;
  end: number;
}

// Tách text thành các "từ" (chuỗi không-khoảng-trắng liên tục) kèm vị trí ký
// tự bắt đầu/kết thúc trong chuỗi gốc - dùng làm đơn vị so khớp cho fallback
// mờ (fuzzy) bên dưới.
export function extractWordTokens(text: string): WordToken[] {
  const tokens: WordToken[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    tokens.push({ word: m[0], start: m.index, end: m.index + m[0].length - 1 });
  }
  return tokens;
}

// Fallback "mờ" (fuzzy) khi indexOf khớp tuyệt đối thất bại: trích xuất
// thường lệch so với snippet gốc lưu ở backend (dấu gạch nối ngắt dòng còn
// sót, ligature, khoảng trắng thừa/thiếu do layout nhiều cột...). Đây KHÔNG
// phải một thư viện fuzzy-match đầy đủ - chỉ là so khớp theo cửa sổ trượt
// trên danh sách từ, đủ khoan dung để một match thật hiếm khi bị bỏ sót hoàn
// toàn. Neo (anchor) vào 1 trong 3 từ đầu của snippet để tránh quét O(số từ
// trang × kích thước cửa sổ) trên toàn bộ trang - chỉ thử các cửa sổ bắt đầu
// gần nơi thực sự xuất hiện 1 trong các từ neo đó.
export function findFuzzyMatch(
  pageTokens: WordToken[],
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

/** Locates `snippet` inside `haystack` (already whitespace/case-normalized
 * source text), trying an exact hit first and a fuzzy word-window match
 * second. Returns raw (un-normalized) offsets via `rawIndexMap`, or null if
 * neither strategy finds it. */
export function locateSnippetRaw(
  haystackRaw: string,
  snippet: string,
): { rawStart: number; rawEnd: number } | null {
  const normalizedSnippet = normalize(snippet);
  if (!normalizedSnippet || normalizedSnippet.length < 8) return null;

  const { normalized: haystackNormalized, map: rawIndexMap } = normalizeWithMap(haystackRaw);

  const idx = haystackNormalized.indexOf(normalizedSnippet);
  let matchStart: number;
  let matchEndInclusive: number;

  if (idx !== -1) {
    matchStart = idx;
    matchEndInclusive = idx + normalizedSnippet.length - 1;
  } else {
    const snippetWords = normalizedSnippet.split(" ").filter(Boolean);
    const tokens = extractWordTokens(haystackNormalized);
    const fuzzy = findFuzzyMatch(tokens, snippetWords);
    if (!fuzzy) return null;
    matchStart = fuzzy.start;
    matchEndInclusive = fuzzy.end;
  }

  const rawStart = rawIndexMap[matchStart] ?? 0;
  const rawEnd = rawIndexMap[Math.min(matchEndInclusive, rawIndexMap.length - 1)] ?? rawStart;
  return { rawStart, rawEnd: rawEnd + 1 }; // end exclusive
}

/**
 * Lenient bag-of-words recall: what fraction of `snippet`'s distinct
 * normalized words also appear in `text`. Used as a fallback when
 * `locateSnippetRaw` can't find a precise/near-precise substring position —
 * e.g. marker-pdf extracts a PDF independently of whatever produced
 * `snippet` (extractor.py for the backend's own matching text), so wording,
 * OCR corrections, or reflow can differ enough that no exact/fuzzy
 * substring position ever appears, even for a match the backend already
 * scored as confidently similar. This is intentionally coarser than
 * `locateSnippetRaw`'s window-anchored fuzzy match — it scores an entire
 * candidate block of text at once rather than searching for a contiguous
 * span, so it tolerates reordering and heavier rewording, at the cost of
 * only ever attributing a match to a whole block, never a precise range.
 */
export function wordOverlapRecall(snippet: string, text: string): number {
  const snippetWords = new Set(normalize(snippet).split(" ").filter(Boolean));
  if (snippetWords.size === 0) return 0;
  const textWords = new Set(normalize(text).split(" ").filter(Boolean));
  let hits = 0;
  for (const word of snippetWords) {
    if (textWords.has(word)) hits++;
  }
  return hits / snippetWords.size;
}
