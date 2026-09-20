import type { MatchedSource } from "@etymos/shared";

/** Lower-cases and strips diacritics so "nguyen" finds "Nguyễn" and "dai hoc"
 * finds "Đại học". `đ` has no Unicode decomposition, so it is mapped by hand. */
export function normalizeForSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/đ/g, "d");
}

/** Everything a user might reasonably type to find a matched source. */
export function searchableText(match: MatchedSource): string {
  return normalizeForSearch(
    [
      match.sourceTitle,
      match.sourceAuthor,
      match.citation,
      match.sourceYear,
      match.sourceDoi,
      match.sourceUrl,
      match.sourceKind,
      match.userSnippet,
      match.sourceSnippet,
      `${match.matchPercent}%`,
    ]
      .filter(Boolean)
      .join(" "),
  );
}

/** Builds the per-match haystacks once, so each keystroke is just `includes`. */
export function buildSearchIndex(matches: MatchedSource[]): string[] {
  return matches.map(searchableText);
}

/**
 * Indexes (into the original `matches` array) that satisfy `query`.
 *
 * Every whitespace-separated term must appear somewhere in the match (AND), in
 * any order. Indexes — not filtered copies — are returned because a match's
 * position is also its badge number and highlight colour, which must not shift
 * when the list is filtered.
 */
export function filterMatchIndexes(index: string[], query: string): number[] {
  const terms = normalizeForSearch(query).split(/\s+/).filter(Boolean);
  const all = index.map((_, i) => i);
  if (terms.length === 0) return all;
  return all.filter((i) => terms.every((term) => index[i].includes(term)));
}
