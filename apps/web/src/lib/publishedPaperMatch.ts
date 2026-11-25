import type { PublishedPaperMatch } from "@etymos/shared";
import { sanitizeSourceTitle } from "./sourceTitle";

/** Parse backend/Supabase `published_paper_match` JSON into `PublishedPaperMatch`. */
export function parsePublishedPaperMatch(raw: unknown): PublishedPaperMatch | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  if (obj.detected !== true) return undefined;
  const rawTitle = typeof obj.source_title === "string" ? obj.source_title.trim() : "";
  const sourceTitle = sanitizeSourceTitle(rawTitle, { isAcademic: true }) || rawTitle;
  if (!sourceTitle) return undefined;

  const authors = Array.isArray(obj.source_authors)
    ? obj.source_authors.filter((a): a is string => typeof a === "string" && a.trim().length > 0)
    : [];
  const coverageRaw = Number(obj.coverage_percent);
  const coveragePercent = Number.isFinite(coverageRaw)
    ? Math.max(0, Math.min(100, Math.round(coverageRaw * 100) / 100))
    : 0;

  return {
    detected: true,
    sourcePaperId: typeof obj.source_paper_id === "string" ? obj.source_paper_id : "",
    sourceTitle,
    sourceAuthors: authors,
    sourceYear: typeof obj.source_year === "string" && obj.source_year.trim() ? obj.source_year.trim() : undefined,
    sourceUrl: typeof obj.source_url === "string" && obj.source_url.trim() ? obj.source_url.trim() : undefined,
    sourceDoi: typeof obj.source_doi === "string" && obj.source_doi.trim() ? obj.source_doi.trim() : undefined,
    coveragePercent,
    titleMatched: obj.title_matched === true,
  };
}
