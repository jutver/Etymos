import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MatchedSource } from "@etymos/shared";
import { explainReportMatch } from "../../lib/api";
import { explainMatch } from "../../lib/matchExplanation";

export interface MatchExplanationEntry {
  text: string;
  source: "llm:gemini" | "facts";
}

export interface MatchExplanationState {
  aiText?: string;
  loading: boolean;
}

export function normalizeExplainLanguage(language: string | undefined): "en" | "vi" {
  return language === "vi" ? "vi" : "en";
}

function cacheKey(matchId: string, lang: "en" | "vi"): string {
  return `${matchId}:${lang}`;
}

export interface UseMatchExplanationsOptions {
  reportId: string | undefined;
  matches: MatchedSource[];
  language: string;
  isSample?: boolean;
  locked?: boolean;
  fetcher?: typeof explainReportMatch;
}

/**
 * Manages on-demand cached Gemini explanations for MatchCard disclosures.
 *
 * Pre-seeds from persisted `match.aiExplanations?.[lang]` so historical and
 * revisited reports open instantaneously without hitting the backend again.
 * Deduplicates concurrent requests per `(matchId, language)` and degrades
 * silently to the upgraded passage-specific fact explanation (`explainMatch`)
 * when unavailable.
 */
export function useMatchExplanations({
  reportId,
  matches,
  language,
  isSample = false,
  locked = false,
  fetcher = explainReportMatch,
}: UseMatchExplanationsOptions) {
  const lang = normalizeExplainLanguage(language);
  const [cache, setCache] = useState<Record<string, MatchExplanationEntry>>({});
  const [loadingMap, setLoadingMap] = useState<Record<string, boolean>>({});
  const inFlightRef = useRef<Map<string, Promise<void>>>(new Map());
  const reportIdRef = useRef(reportId);

  // Clear session-local cache cleanly when navigating to a different report.
  useEffect(() => {
    if (reportIdRef.current !== reportId) {
      reportIdRef.current = reportId;
      setCache({});
      setLoadingMap({});
      inFlightRef.current.clear();
    }
  }, [reportId]);

  const seededCache = useMemo(() => {
    const out: Record<string, MatchExplanationEntry> = {};
    for (const m of matches) {
      const en = m.aiExplanations?.en;
      if (en?.text) out[cacheKey(m.id, "en")] = { text: en.text, source: en.source };
      const vi = m.aiExplanations?.vi;
      if (vi?.text) out[cacheKey(m.id, "vi")] = { text: vi.text, source: vi.source };
    }
    return out;
  }, [matches]);

  const mergedCache = useMemo(() => ({ ...seededCache, ...cache }), [seededCache, cache]);
  const mergedCacheRef = useRef(mergedCache);
  mergedCacheRef.current = mergedCache;

  const requestExplanation = useCallback(
    (match: MatchedSource) => {
      if (!reportId || isSample || locked) return;
      const key = cacheKey(match.id, lang);
      if (mergedCacheRef.current[key] || inFlightRef.current.has(key)) return;

      const activeReportId = reportId;
      setLoadingMap((prev) => (prev[key] ? prev : { ...prev, [key]: true }));

      const task = (async () => {
        try {
          const res = await fetcher(activeReportId, match.id, lang);
          if (reportIdRef.current !== activeReportId) return;
          const text = res.explanation?.trim() || explainMatch(match);
          setCache((prev) => ({
            ...prev,
            [key]: { text, source: res.source === "llm:gemini" ? "llm:gemini" : "facts" },
          }));
        } catch {
          // Graceful fallback: card renders upgraded passage-specific `explainMatch(match)`.
        } finally {
          inFlightRef.current.delete(key);
          if (reportIdRef.current === activeReportId) {
            setLoadingMap((prev) => {
              if (!prev[key]) return prev;
              const next = { ...prev };
              delete next[key];
              return next;
            });
          }
        }
      })();

      inFlightRef.current.set(key, task);
    },
    [reportId, isSample, locked, lang, fetcher],
  );

  const getExplanationState = useCallback(
    (matchId: string): MatchExplanationState => {
      const key = cacheKey(matchId, lang);
      return {
        aiText: mergedCache[key]?.text,
        loading: Boolean(loadingMap[key]),
      };
    },
    [mergedCache, loadingMap, lang],
  );

  return {
    language: lang,
    requestExplanation,
    getExplanationState,
    cachedExplanations: mergedCache,
    loadingKeys: loadingMap,
  };
}
