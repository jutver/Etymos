// How much of a text changed: words added or replaced, divided by the earlier
// text's word count (0..1). Pure deletions don't count. The same measure as
// backend/api/recheck_quota.py's changed_ratio, which prices re-checks; this
// copy only labels Version History and is never trusted for pricing.

// Cells allowed in one LCS table; beyond it the diff falls back to comparing
// word counts, which can only overstate how much changed.
const MAX_LCS_CELLS = 4_000_000;

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

function paragraphs(text: string): string[][] {
  return text
    .split(/\n+/)
    .map(words)
    .filter((p) => p.length > 0);
}

/** Length of the longest common subsequence of `a` and `b`. */
function lcsLength<T>(a: T[], b: T[]): number {
  if (a.length * b.length > MAX_LCS_CELLS) return multisetOverlap(a, b);
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const row = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1]);
    }
    prev = row;
  }
  return prev[b.length];
}

function multisetOverlap<T>(a: T[], b: T[]): number {
  const counts = new Map<T, number>();
  for (const x of a) counts.set(x, (counts.get(x) ?? 0) + 1);
  let common = 0;
  for (const y of b) {
    const n = counts.get(y) ?? 0;
    if (n > 0) {
      common += 1;
      counts.set(y, n - 1);
    }
  }
  return common;
}

/** Index pairs of paragraphs that are identical in both texts, in order. */
function matchedParagraphs(oldKeys: string[], newKeys: string[]): [number, number][] {
  const n = oldKeys.length;
  const m = newKeys.length;
  if (n * m > MAX_LCS_CELLS) return [];
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] = oldKeys[i] === newKeys[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (oldKeys[i] === newKeys[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

export function changedRatio(before: string, after: string): number {
  const oldParas = paragraphs(before);
  const newParas = paragraphs(after);
  const baseWords = oldParas.reduce((sum, p) => sum + p.length, 0);
  if (baseWords === 0) return newParas.length > 0 ? 1 : 0;

  // Paragraphs that didn't change are skipped; words are compared only
  // inside the stretches between them.
  const pairs = matchedParagraphs(
    oldParas.map((p) => p.join(" ")),
    newParas.map((p) => p.join(" ")),
  );
  let added = 0;
  let oi = 0;
  let ni = 0;
  for (const [mi, mj] of [...pairs, [oldParas.length, newParas.length] as [number, number]]) {
    const oldGap = oldParas.slice(oi, mi).flat();
    const newGap = newParas.slice(ni, mj).flat();
    added += newGap.length - lcsLength(oldGap, newGap);
    oi = mi + 1;
    ni = mj + 1;
  }
  return Math.min(1, added / baseWords);
}

/** The text of a saved version's HTML, one editor block per paragraph. */
export function htmlToText(html: string): string {
  if (typeof DOMParser === "undefined") return html.replace(/<[^>]+>/g, " ");
  const body = new DOMParser().parseFromString(html, "text/html").body;
  const blocks = Array.from(body.querySelectorAll<HTMLElement>("[data-block-id]")).filter(
    (el) => !el.parentElement?.closest("[data-block-id]"),
  );
  if (blocks.length === 0) return body.textContent ?? "";
  return blocks.map((el) => el.textContent ?? "").join("\n\n");
}
