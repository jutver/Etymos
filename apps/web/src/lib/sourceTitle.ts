/**
 * Client-side mirror of `backend/source_title.py:sanitize_source_title`.
 * Normalizes duplicated multi-result web titles, mirror suffixes, and arXiv/preprint tags
 * across both freshly-analyzed and previously saved historical reports.
 */

const PREPRINT_PREFIX_RE =
  /^\s*(?:\[(?:arXiv:)?\d{4}\.\d{4,5}(?:v\d+)?\]|arXiv:\d{4}\.\d{4,5}(?:v\d+)?\s*[-:]?|\[[a-z-]+(?:\.[A-Z]{2})?\])\s*/i;

const CONCAT_MARKER_RE = /(?:\.\.\.|…)\s*\S|\(\s*PDF\s*\)\s+|\s*·\s*Hugging Face/i;
const LEADING_PDF_RE = /^(?:\(\s*PDF\s*\)\s*)+/i;
const MIRROR_GLUE_RE = /\b(?:Hugging Face|GitHub|ResearchGate)\s*(?=[A-Z0-9])/g;
const MIRROR_CANDIDATE_RE = /(?:^|\s)[\w-]+\/[\w-]+|\b(?:Hugging Face|GitHub)\b/i;
const TRAILING_PREPOSITION_RE = /\b(?:a|an|the|in|on|of|for|with|and|to)$/i;

function normalizeWs(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function stripPreprintPrefix(title: string): string {
  let cleaned = title.trim();
  while (cleaned) {
    const updated = cleaned.replace(PREPRINT_PREFIX_RE, "").trim();
    if (updated === cleaned) break;
    cleaned = updated;
  }
  return cleaned;
}

function trimEdgeMarks(value: string): string {
  return value.replace(/^[\s·-]+|[\s·-]+$/g, "");
}

export function sanitizeSourceTitle(
  rawTitle: string | null | undefined,
  opts?: { isAcademic?: boolean; maxLength?: number },
): string {
  const isAcademic = opts?.isAcademic ?? false;
  const maxLength = opts?.maxLength ?? 160;

  let cleaned = normalizeWs(rawTitle ?? "");
  if (!cleaned) return "";
  if (isAcademic) {
    cleaned = stripPreprintPrefix(cleaned) || cleaned;
  }
  cleaned = cleaned.replace(LEADING_PDF_RE, "").trim();

  if (CONCAT_MARKER_RE.test(cleaned)) {
    const parts = cleaned.split(/(?:\.\.\.|…)\s*|(?<=\S)\s*(?=\(\s*PDF\s*\)\s+)/i);
    const candidates: string[] = [];

    for (const part of parts) {
      let piece = trimEdgeMarks(part.replace(LEADING_PDF_RE, ""));
      if (isAcademic) {
        piece = stripPreprintPrefix(piece) || piece;
      }
      if (!piece) continue;

      for (const sub of piece.split(MIRROR_GLUE_RE)) {
        const subClean = trimEdgeMarks(sub);
        if (subClean.length >= 6) {
          candidates.push(subClean);
        }
      }
    }

    if (candidates.length > 0) {
      const headPrefix = candidates[0].toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 20);
      const nonMirror = candidates.filter((c) => !MIRROR_CANDIDATE_RE.test(c));
      const pool = nonMirror.length > 0 ? nonMirror : candidates;
      const matchingHead = headPrefix
        ? pool.filter((c) =>
            c.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().startsWith(headPrefix.slice(0, 14)),
          )
        : [];
      const pickLongest = (list: string[]) =>
        list.reduce((best, item) => (item.length > best.length ? item : best), list[0]);

      if (matchingHead.length > 0) {
        const complete = matchingHead.filter((c) => !TRAILING_PREPOSITION_RE.test(c));
        cleaned = pickLongest(complete.length > 0 ? complete : matchingHead);
      } else {
        cleaned = pickLongest(pool);
      }
    }
  } else {
    const probe = cleaned.slice(0, 24).toLowerCase();
    if (probe.length >= 20) {
      const second = cleaned.toLowerCase().indexOf(probe, 20);
      if (second > 0) {
        cleaned = trimEdgeMarks(cleaned.slice(0, second));
      }
    }
  }

  if (cleaned.length > maxLength) {
    const slice = cleaned.slice(0, maxLength - 1);
    const lastSpace = slice.lastIndexOf(" ");
    const cut = (lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trim() || slice;
    cleaned = `${cut}…`;
  }
  return cleaned;
}
