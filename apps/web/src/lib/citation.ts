import type { MatchedSource } from "@etymos/shared";

/** Text-based citation (APA-ish), suitable for pasting into Word/Docs.
 * Mirrors backend/citations.py's format_reference() so the two stay
 * consistent, but runs client-side since the dialog needs no round trip. */
export function formatCitationText(match: MatchedSource): string {
  const author = (match.sourceAuthor || "").trim();
  const parts: string[] = [];
  if (author) parts.push(author.endsWith(".") ? author : `${author}.`);
  if (match.sourceYear) parts.push(`(${match.sourceYear}).`);
  const title = (match.sourceTitle || "").trim();
  if (title) parts.push(`${title.replace(/\.+$/, "")}.`);
  if (match.sourceUrl) parts.push(match.sourceUrl);
  return parts.length > 0 ? parts.join(" ") : title || "Untitled source";
}

function bibtexKey(match: MatchedSource): string {
  const lastName = (match.sourceAuthor || "").split(",")[0].split(" ").pop()?.replace(/[^a-zA-Z]/g, "") || "source";
  const firstWord = (match.sourceTitle || "").trim().split(/\s+/)[0]?.replace(/[^a-zA-Z0-9]/g, "") || "";
  return `${lastName}${match.sourceYear || ""}${firstWord}`;
}

function escapeBibtex(value: string): string {
  return value.replace(/[{}]/g, "");
}

/** BibTeX entry. Uses @misc for web sources (no publisher/journal to hang
 * an @article on) and @article for academic ones, degrading gracefully
 * when individual fields are absent — same rule as the text variant. */
export function formatCitationBibtex(match: MatchedSource): string {
  const entryType = match.sourceKind === "academic" ? "article" : "misc";
  const key = bibtexKey(match);
  const lines = [`@${entryType}{${key},`];
  if (match.sourceAuthor) lines.push(`  author = {${escapeBibtex(match.sourceAuthor)}},`);
  if (match.sourceTitle) lines.push(`  title = {${escapeBibtex(match.sourceTitle)}},`);
  if (match.sourceYear) lines.push(`  year = {${escapeBibtex(match.sourceYear)}},`);
  if (match.sourceDoi) lines.push(`  doi = {${escapeBibtex(match.sourceDoi)}},`);
  if (match.sourceUrl) lines.push(`  url = {${escapeBibtex(match.sourceUrl)}},`);
  lines.push("}");
  return lines.join("\n");
}
