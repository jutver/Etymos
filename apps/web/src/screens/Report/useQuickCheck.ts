/**
 * Quick check ("check nhanh") of passages the reader changed in the Edit view.
 *
 * Two triggers, one check:
 *   1. "Accept & replace" of an AI rewrite (`checkAcceptedRewrite`), and
 *   2. typing inside a highlighted passage or inside an earlier rewrite — once
 *      the reader has stopped typing for EDIT_SETTLE_MS, or leaves the editor.
 *
 * Opening the Edit view warms the backend up (sources + embedding model), so
 * even the first check answers quickly.
 *
 * Each check compares only the changed passage with the sources this report
 * already found (POST /api/reports/{id}/quick-check, backend/quick_check.py):
 * no search, no download, no check used from the quota. The result feeds
 * rewriteScore.ts's estimate: a clean passage takes its share off the score,
 * a passage that still (or newly) overlaps a source puts that overlap back.
 *
 * The listeners are native and separate from DocumentCanvas's own onInput,
 * which keeps doing exactly what it did.
 */
import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { quickCheckPassage, warmQuickCheck, type QuickCheckResponse } from "../../lib/api";
import type { MatchedSource } from "../../lib/types";
import { markText, normalizeWhitespace, REWRITTEN_CLASS, REWRITTEN_FLAGGED_CLASS } from "./replaceMatch";
import type { PassageCheck } from "./rewriteScore";

/** How long the reader must stop typing before an edited passage is checked.
 * A check takes ~40 ms once the backend is warm, so this is the only wait;
 * leaving the editor (blur) checks at once. */
export const EDIT_SETTLE_MS = 1200;

const HOST_SELECTOR = "mark[data-match-id], span[data-rewritten-from]";

function hostKey(host: HTMLElement): string | undefined {
  return host.tagName === "MARK" ? host.dataset.matchId : host.dataset.rewrittenFrom;
}

function hostText(host: HTMLElement): string {
  if (!host.isConnected) return "";
  return host.tagName === "MARK" ? markText(host) : (host.textContent ?? "");
}

function cacheKey(text: string): string {
  return normalizeWhitespace(text).toLowerCase();
}

export interface UseQuickCheckOptions {
  /** Report / document id; null disables the check. */
  reportId: string | null;
  /** The Edit view's editor. */
  editorRef: RefObject<HTMLDivElement | null>;
  /** Only the Edit view can be typed into. */
  enabled: boolean;
  matches: MatchedSource[];
  /** match id -> the highlight it is drawn in (highlights.ts's buildMatchFocusMap). */
  focusMap: Map<string, string>;
  setResolvedIds: Dispatch<SetStateAction<Set<string>>>;
  /** Called once per finished check (toast etc.). */
  onResult?: (check: PassageCheck, origin: "rewrite" | "edit") => void;
}

export function useQuickCheck({
  reportId,
  editorRef,
  enabled,
  matches,
  focusMap,
  setResolvedIds,
  onResult,
}: UseQuickCheckOptions) {
  /** Keyed by highlight id (the mark that was rewritten or edited). */
  const [checks, setChecks] = useState<Map<string, PassageCheck>>(() => new Map());

  // Latest values for the native listeners, without re-binding them.
  const latest = useRef({ reportId, matches, focusMap, onResult, checks });
  latest.current = { reportId, matches, focusMap, onResult, checks };

  // One request per distinct text: the Rewrite panel's pre-check and the
  // check after "Accept & replace" share it.
  const cacheRef = useRef(new Map<string, Promise<QuickCheckResponse>>());
  // Last request per highlight, so a slow answer for older text can't
  // overwrite the answer for newer text.
  const seqRef = useRef(new Map<string, number>());

  useEffect(() => {
    setChecks(new Map());
    cacheRef.current.clear();
  }, [reportId]);

  // Warm the backend once per report, the first time the Edit view opens.
  const warmedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled || !reportId || warmedRef.current === reportId) return;
    warmedRef.current = reportId;
    warmQuickCheck(reportId).catch(() => {
      // Only a head start: the first check still works without it.
    });
  }, [enabled, reportId]);

  const runCheck = useCallback((text: string): Promise<QuickCheckResponse> => {
    const id = latest.current.reportId;
    if (!id) return Promise.reject(new Error("No report to check against."));
    const key = cacheKey(text);
    const cached = cacheRef.current.get(key);
    if (cached) return cached;
    // Distinct matched source sentences — the fallback corpus for a report
    // the backend has no copy of.
    const seen = new Set<string>();
    const sources: { title: string; text: string }[] = [];
    for (const m of latest.current.matches) {
      const sourceText = normalizeWhitespace(m.sourceSnippet);
      if (!sourceText || seen.has(sourceText)) continue;
      seen.add(sourceText);
      sources.push({ title: m.sourceTitle, text: sourceText });
    }
    const request = quickCheckPassage(id, text, sources);
    cacheRef.current.set(key, request);
    request.catch(() => cacheRef.current.delete(key));
    return request;
  }, []);

  /** Ids of every match drawn in highlight `key` (merged matches included). */
  const matchIdsFor = useCallback((key: string): string[] => {
    const ids = new Set<string>([key]);
    for (const [matchId, target] of latest.current.focusMap) if (target === key) ids.add(matchId);
    return [...ids];
  }, []);

  const startCheck = useCallback(
    (key: string, matchIds: string[], text: string, origin: "rewrite" | "edit") => {
      const seq = (seqRef.current.get(key) ?? 0) + 1;
      seqRef.current.set(key, seq);
      const isCurrent = () => seqRef.current.get(key) === seq;

      // The old wording is gone either way, so its share comes off now; a
      // flagged result puts the new overlap back.
      setResolvedIds((prev) => {
        const next = new Set(prev);
        matchIds.forEach((id) => next.add(id));
        return next;
      });

      const finish = (check: PassageCheck) => {
        if (!isCurrent()) return;
        setChecks((prev) => new Map(prev).set(key, check));
        const span = editorRef.current?.querySelector<HTMLElement>(
          `span[data-rewritten-from="${CSS.escape(key)}"]`,
        );
        if (span) span.className = check.status === "flagged" ? REWRITTEN_FLAGGED_CLASS : REWRITTEN_CLASS;
        if (check.status !== "checking") latest.current.onResult?.(check, origin);
      };

      if (!normalizeWhitespace(text)) {
        // The passage was deleted outright: nothing left to overlap anything.
        finish({ matchIds, text: "", status: "clean", hits: [] });
        return;
      }

      finish({ matchIds, text, status: "checking", hits: [] });
      runCheck(text).then(
        (res) => finish({ matchIds, text, status: res.status, hits: res.hits }),
        () => finish({ matchIds, text, status: "unverified", hits: [] }),
      );
    },
    [editorRef, runCheck, setResolvedIds],
  );

  /** After "Accept & replace" put `text` in place of highlight `targetId`. */
  const checkAcceptedRewrite = useCallback(
    (targetId: string, text: string) => startCheck(targetId, matchIdsFor(targetId), text, "rewrite"),
    [matchIdsFor, startCheck],
  );

  /** The highlight went back to its original words: it is flagged as before. */
  const revert = useCallback(
    (key: string, matchIds: string[]) => {
      seqRef.current.set(key, (seqRef.current.get(key) ?? 0) + 1);
      setChecks((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Map(prev);
        next.delete(key);
        return next;
      });
      setResolvedIds((prev) => {
        if (!matchIds.some((id) => prev.has(id))) return prev;
        const next = new Set(prev);
        matchIds.forEach((id) => next.delete(id));
        return next;
      });
    },
    [setResolvedIds],
  );

  // Hand edits: remember which highlights / rewrites the reader is changing
  // (on beforeinput, while the selection is still inside them — a deletion
  // can remove the element itself), then check them once typing settles.
  useEffect(() => {
    const editor = editorRef.current;
    if (!enabled || !editor) return;

    const pending = new Map<string, HTMLElement>();
    let timer: number | undefined;

    const collect = () => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      if (!editor.contains(range.commonAncestorContainer)) return;
      const anchor = range.startContainer;
      const anchorEl = anchor.nodeType === Node.ELEMENT_NODE ? (anchor as Element) : anchor.parentElement;
      const around = anchorEl?.closest<HTMLElement>(HOST_SELECTOR);
      if (around && editor.contains(around)) {
        const key = hostKey(around);
        if (key) pending.set(key, around);
      }
      if (!range.collapsed) {
        editor.querySelectorAll<HTMLElement>(HOST_SELECTOR).forEach((host) => {
          const key = hostKey(host);
          if (key && range.intersectsNode(host)) pending.set(key, host);
        });
      }
    };

    const flush = () => {
      timer = undefined;
      const { matches: currentMatches, checks: currentChecks } = latest.current;
      for (const [key, host] of pending) {
        const text = hostText(host);
        const matchIds = matchIdsFor(key);
        const previous = currentChecks.get(key);
        if (host.tagName === "MARK") {
          const original = currentMatches.find((m) => m.id === key)?.userSnippet ?? "";
          if (host.isConnected && cacheKey(text) === cacheKey(original)) {
            revert(key, matchIds);
            continue;
          }
        }
        if (previous && previous.status !== "unverified" && cacheKey(previous.text) === cacheKey(text)) continue;
        startCheck(key, matchIds, text, "edit");
      }
      pending.clear();
    };

    const onInput = () => {
      if (pending.size === 0) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(flush, EDIT_SETTLE_MS);
    };

    // Leaving the editor means the reader is done for now: check right away.
    const onFocusOut = (e: FocusEvent) => {
      if (timer === undefined || editor.contains(e.relatedTarget as Node | null)) return;
      window.clearTimeout(timer);
      flush();
    };

    editor.addEventListener("beforeinput", collect);
    editor.addEventListener("input", onInput);
    editor.addEventListener("focusout", onFocusOut);
    return () => {
      editor.removeEventListener("beforeinput", collect);
      editor.removeEventListener("input", onInput);
      editor.removeEventListener("focusout", onFocusOut);
      if (timer !== undefined) {
        window.clearTimeout(timer);
        flush();
      }
    };
  }, [enabled, editorRef, matchIdsFor, revert, startCheck]);

  return { checks, runCheck, checkAcceptedRewrite };
}
