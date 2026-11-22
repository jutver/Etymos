import { memo, useMemo } from "react";
import DOMPurify from "dompurify";
import katex from "katex";
import { cn } from "@etymos/shared";
import { t } from "../../lib/i18n";

const FORBID_TAGS = ["script", "iframe", "object", "embed", "style", "link", "meta"];
const FORBID_ATTR = ["onerror", "onload", "onclick", "onmouseover", "onfocus", "onblur", "href", "xlink:href", "action", "formaction"];
const MAX_KATEX_CACHE = 300;
const katexCache = new Map<string, string | null>();

function stripUnsafeMarkup(html: string): string {
  return html
    .replace(/<\s*(script|iframe|object|embed|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*(script|iframe|object|embed|style|link|meta)\b[^>]*\/?>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s+(?:href|xlink:href|action|formaction)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/javascript\s*:/gi, "");
}

/**
 * Synchronously render a LaTeX expression with KaTeX (`trust: false`,
 * `strict: "ignore"`, `throwOnError: false`), sanitized with `DOMPurify`, and
 * memoized in a bounded cache so identical formulas skip repeated parsing/sanitizing.
 */
export function renderSafeKatex(latex: string | undefined, displayMode: boolean): string | null {
  const source = latex?.trim();
  if (!source) return null;
  const cacheKey = `${displayMode ? "1" : "0"}:${source}`;
  if (katexCache.has(cacheKey)) {
    return katexCache.get(cacheKey) ?? null;
  }

  let result: string | null = null;
  try {
    const rendered = katex.renderToString(source, {
      displayMode,
      throwOnError: false,
      strict: "ignore",
      trust: false,
    });
    const purified = DOMPurify.isSupported
      ? DOMPurify.sanitize(rendered, {
          USE_PROFILES: { html: true, mathMl: true, svg: true },
          FORBID_TAGS,
          FORBID_ATTR,
        })
      : rendered;
    result = stripUnsafeMarkup(purified);
  } catch {
    result = null;
  }

  if (katexCache.size >= MAX_KATEX_CACHE) {
    const firstKey = katexCache.keys().next().value;
    if (firstKey !== undefined) katexCache.delete(firstKey);
  }
  katexCache.set(cacheKey, result);
  return result;
}

export interface FormulaBlockProps {
  formulaLatex?: string;
  equationNumber?: string;
  imageUrl?: string;
  fallbackText?: string;
  muted?: boolean;
}

export const FormulaBlock = memo(function FormulaBlock({
  formulaLatex,
  equationNumber,
  imageUrl,
  fallbackText,
  muted = false,
}: FormulaBlockProps) {
  const html = useMemo(() => renderSafeKatex(formulaLatex, true), [formulaLatex]);

  return (
    <div
      contentEditable={false}
      role="math"
      aria-label={t("Mathematical formula")}
      data-formula-latex={formulaLatex ?? undefined}
      className={cn(
        "formula-block my-5 flex items-center justify-between gap-4 rounded-[var(--radius-control)] border border-line/60 bg-surface-tint/60 px-4 py-3 select-none",
        muted && "opacity-60",
      )}
    >
      <div className="min-w-0 flex-1 overflow-x-auto text-center">
        {html ? (
          <div className="inline-block max-w-full" dangerouslySetInnerHTML={{ __html: html }} />
        ) : imageUrl ? (
          <img
            src={imageUrl}
            alt={t("Mathematical formula")}
            title={t("Shown as an image: this formula could not be converted to editable math")}
            className="mx-auto max-h-32 max-w-full object-contain"
          />
        ) : (
          <code className="font-mono text-sm text-ink-700">
            {fallbackText?.trim() || t("Formula unavailable")}
          </code>
        )}
      </div>
      {equationNumber && (
        <span className="shrink-0 font-mono text-xs text-ink-500">{equationNumber}</span>
      )}
    </div>
  );
});
