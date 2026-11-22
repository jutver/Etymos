import type { ExtractionMeta, InlineFormula } from "@etymos/shared";

function toFiniteInt(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

function toIntArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const item of value) {
    const n = toFiniteInt(item);
    if (n !== undefined && n >= 1) out.push(n);
  }
  return out;
}

/** Maps backend `documents.extraction_meta` / `result.document.extraction_meta`
 * (snake_case) to `ExtractionMeta` (camelCase), returning undefined when absent
 * or malformed so legacy reports stay unaffected. */
export function parseExtractionMeta(raw: unknown): ExtractionMeta | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;

  const rawMode = r.document_mode ?? r.documentMode;
  const documentMode =
    rawMode === "native" || rawMode === "ocr" || rawMode === "hybrid" ? rawMode : undefined;
  const pipelineVersion = toFiniteInt(r.pipeline_version ?? r.pipelineVersion);
  const totalPages = toFiniteInt(r.total_pages ?? r.totalPages);

  if (!documentMode || pipelineVersion === undefined || totalPages === undefined) {
    return undefined;
  }

  const warnings = Array.isArray(r.warnings)
    ? r.warnings.filter((w): w is string => typeof w === "string" && w.trim().length > 0)
    : undefined;

  return {
    pipelineVersion,
    documentMode,
    totalPages: Math.max(0, totalPages),
    ocrPages: toIntArray(r.ocr_pages ?? r.ocrPages),
    multiColumnPages: toIntArray(r.multi_column_pages ?? r.multiColumnPages),
    formulaCount: Math.max(0, toFiniteInt(r.formula_count ?? r.formulaCount) ?? 0),
    formulaFallbackCount: Math.max(
      0,
      toFiniteInt(r.formula_fallback_count ?? r.formulaFallbackCount) ?? 0,
    ),
    ...(warnings && warnings.length > 0 ? { warnings } : {}),
  };
}

/** Validates and sorts non-overlapping inline formula annotations for a passage.
 * Malformed or out-of-range entries are dropped so prose renders safely. */
export function parseInlineFormulas(raw: unknown, maxLen?: number): InlineFormula[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const candidates: InlineFormula[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const start = toFiniteInt(obj.start);
    const end = toFiniteInt(obj.end);
    const latex = typeof obj.latex === "string" ? obj.latex.trim() : "";
    if (start === undefined || end === undefined || !latex) continue;
    if (start < 0 || end <= start) continue;
    if (maxLen !== undefined && end > maxLen) continue;
    candidates.push({ start, end, latex });
  }

  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => a.start - b.start || a.end - b.end);

  const nonOverlapping: InlineFormula[] = [];
  let lastEnd = -1;
  for (const formula of candidates) {
    if (formula.start < lastEnd) continue;
    nonOverlapping.push(formula);
    lastEnd = formula.end;
  }

  return nonOverlapping.length > 0 ? nonOverlapping : undefined;
}
