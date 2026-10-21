import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { FileMagnifyingGlass } from "@phosphor-icons/react";
import { supabase, cn } from "@etymos/shared";
import { useAppStore, planWordLimit, type BalanceSource } from "../../lib/store";
import { changedRecheckQuote, pollJob, quoteRecheck, restoreCheck, submitRecheck, type RecheckBlock, type RecheckQuote } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { trackEvent } from "../../lib/analytics";
import {
  fetchCheckedDocument,
  fetchDocumentVersions,
  renameDocument,
  saveDocumentVersion,
} from "../../lib/documentsQueries";
import { loadLocalDocumentVersions, saveLocalDocumentVersion } from "../../lib/localDocumentVersions";
import { statusFromScore } from "../../components/Severity";
import { Button } from "../../components/ui/Button";
import { useSplashHold } from "../../components/BootSplash";
import { PlagiarismPdfViewer } from "../../components/PlagiarismPdfViewer";
import { SourceComparisonModal } from "./SourceComparisonModal";
import { CitationDialog } from "../../components/CitationDialog";
import { RewritePanel } from "./RewritePanel";
import { ReportTopBar } from "./ReportTopBar";
import { FormatToolbar, type ReportView } from "./FormatToolbar";
import { DocumentCanvas, type DocumentCanvasHandle, type MatchColorIndex } from "./DocumentCanvas";
import { SourcesSidebar, type SidebarTab } from "./SourcesSidebar";
import { WordCountPill } from "./WordCountPill";
import { AiContentChip } from "./AiContentChip";
import type { DocumentVersion } from "./VersionHistoryMenu";
import { aiFlaggedPassageIds, buildMatchFocusMap, buildRenderedPassages, countWords, mapAiSegmentsToPassages } from "./highlights";
import { isOverLimit } from "./renderPassageText";
import { normalizeWhitespace } from "./replaceMatch";
import { computeWordLimitOffset } from "./wordLimit";
import { applySavedVersion } from "./applySavedVersion";
import { useQuickCheck } from "./useQuickCheck";
import { RecheckDialog } from "./RecheckDialog";
import { collectEditorBlocks } from "./recheck";
import { changedRatio, htmlToText } from "../../lib/textChange";
import { estimateScore, type PassageCheck } from "./rewriteScore";
import type { CheckedDocument, DocStatus, MatchedSource } from "../../lib/types";
import { t as tl, tr } from "../../lib/i18n";
import { effectiveTier, paywallPath } from "../../lib/paywall";

// Private Storage bucket the backend uploads original PDFs into (see
// backend/api/app.py's DOCUMENTS_BUCKET / _storage_path: `{user_id}/{report_id}.pdf`).
const DOCUMENTS_BUCKET = "documents";

// Stable empties for the highlight kind that is switched off (see
// highlightMode), so the PDF viewer doesn't re-search on every render.
const NO_MATCHES: MatchedSource[] = [];
const NO_AI_SEGMENTS: { id: string; start: number; end: number; excerpt: string; score: number }[] = [];
const NO_PASSAGE_IDS = new Set<string>();
// Short-lived on purpose (regenerated fresh every time this screen loads a
// historical document — see the signed-URL effect below), matching the
// pattern already used in apps/admin/src/lib/verificationQueries.ts.
const PDF_SIGNED_URL_TTL_SECONDS = 300;
/** Longest the splash waits for the original PDF to draw. */
const PDF_SPLASH_TIMEOUT_MS = 15_000;

const SCORE_CHIP: Record<DocStatus, string> = {
  clean: "text-success bg-success-bg border-success/20",
  low: "text-severity-low bg-severity-low-bg border-severity-low-line",
  moderate: "text-severity-moderate bg-severity-moderate-bg border-severity-moderate-line",
  high: "text-severity-high bg-severity-high-bg border-severity-high-line",
};

/** Compact similarity readout, sized to live in the top bar. `estimated` once
 * passages were rewritten/edited (rewriteScore.ts); `checking` while a quick
 * check is still running. */
function ScoreChip({ score, estimated = false, checking = false }: { score: number; estimated?: boolean; checking?: boolean }) {
  const status = statusFromScore(score);
  return (
    <span
      title={
        estimated
          ? tl("Estimated similarity {{score}}% after your edits. Edited passages were only compared with the sources already in this report; a full re-check gives the exact score.", { score: score })
          : tl("Similarity score {{score}}%", { score: score })
      }
      className={cn(
        "hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold tabular-nums sm:inline-flex",
        SCORE_CHIP[status],
      )}
    >
      {checking && (
        <span aria-hidden="true" className="size-2.5 animate-spin motion-reduce:animate-none rounded-full border border-current border-t-transparent" />
      )}
      {estimated && <span aria-label={tl("estimated")}>≈</span>}
      {score}{tl("% similar")}</span>
  );
}

export default function ReportPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const plan = useAppStore((s) => s.plan);
  const pushToast = useAppStore((s) => s.pushToast);
  const renameDocumentInHistory = useAppStore((s) => s.renameDocumentInHistory);

  const checkedDocuments = useAppStore((s) => s.checkedDocuments);
  const history = useAppStore((s) => s.history);
  // Fast path: the document was just created in this session (right after
  // Upload/Analyzing) and is already sitting in the local zustand cache —
  // no need to round-trip to Supabase for it.
  const cachedDoc = id ? checkedDocuments[id] : undefined;

  const [remoteDoc, setRemoteDoc] = useState<CheckedDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  // Bumped after a Save & re-check finishes, to load the re-checked report.
  // While it is 0 the cached report (if any) is used.
  const [refetchNonce, setRefetchNonce] = useState(0);
  // The refetchNonce whose report has arrived; the editor is rebuilt from it.
  const [loadedNonce, setLoadedNonce] = useState(0);

  useEffect(() => {
    if (!id || (cachedDoc && refetchNonce === 0)) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setNotFound(false);
    fetchCheckedDocument(id)
      .then((result) => {
        if (cancelled) return;
        if (!result) {
          setNotFound(true);
        } else {
          setRemoteDoc(result as CheckedDocument);
          setLoadedNonce(refetchNonce);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : tr("Failed to load report"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, cachedDoc, refetchNonce]);

  const doc = (refetchNonce > 0 ? remoteDoc : cachedDoc ?? remoteDoc) ?? null;
  // Features follow the better of the user's plan and this document's own
  // tier (a check paid with a credit, or a credit spent on it from the paywall).
  const tier = effectiveTier(plan, doc?.unlockedTier);
  const isFree = tier === "free";
  const historyMeta = id ? history.find((h) => h.id === id) : undefined;

  // Analytics: one `report_viewed` per report actually rendered (not per
  // re-render, and not for a 404/failed load).
  const hasDoc = doc !== null;
  useEffect(() => {
    if (id && hasDoc) trackEvent("report_viewed");
  }, [id, hasDoc]);

  // fetchCheckedDocument() (documentsQueries.ts) only ever reads the
  // `documents`/`document_matches`/`document_passages` tables — it never
  // returns a `pdfUrl`, so any document loaded from history needs a signed
  // URL for the original PDF, which lives in the private `documents` Storage
  // bucket at `{user_id}/{document_id}.pdf` (backend/api/app.py's
  // _storage_path/get_source_pdf).
  const { user } = useAuth();
  const [signedPdfUrl, setSignedPdfUrl] = useState<string | null>(null);
  const [pdfFetchError, setPdfFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (!id || cachedDoc || !doc || !doc.fileName || !user) {
      setSignedPdfUrl(null);
      setPdfFetchError(null);
      return;
    }
    let cancelled = false;
    setPdfFetchError(null);
    supabase.storage
      .from(DOCUMENTS_BUCKET)
      .createSignedUrl(`${user.id}/${id}.pdf`, PDF_SIGNED_URL_TTL_SECONDS)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error || !data?.signedUrl) {
          setSignedPdfUrl(null);
          setPdfFetchError(
            error?.message ?? tl("Could not create a preview link for the original PDF."),
          );
          return;
        }
        setSignedPdfUrl(data.signedUrl);
      });
    return () => {
      cancelled = true;
    };
  }, [id, cachedDoc, doc, user]);

  const effectivePdfUrl = cachedDoc?.pdfUrl || signedPdfUrl || undefined;

  // The splash (shown by AppShell on entering a report) stays up until the
  // document is here and, in the Original view, its PDF has drawn — capped,
  // so a huge or stuck PDF can't hold it forever. A PDF is only waited for
  // when one is coming: a URL is in hand, or the signed one is being fetched.
  const [pdfReady, setPdfReady] = useState(false);
  const handlePdfReady = useCallback(() => setPdfReady(true), []);
  useEffect(() => {
    setPdfReady(false);
    const timer = window.setTimeout(() => setPdfReady(true), PDF_SPLASH_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [id]);
  const pdfComing = Boolean(effectivePdfUrl) || (!cachedDoc && Boolean(doc?.fileName) && !pdfFetchError);

  // --- Editor state --------------------------------------------------------
  const editorRef = useRef<HTMLDivElement>(null);
  // The read-only Document tab's own editor — `editorRef` is always the Edit
  // tab's, which is what Save, rewrites and version restores work on.
  const documentViewEditorRef = useRef<HTMLDivElement>(null);
  // Lets FormatToolbar's "Insert table" button ask the canvas to add a
  // structural block — no longer possible via `document.execCommand` now
  // that the document is a real block array (see DocumentCanvas.tsx).
  const canvasRef = useRef<DocumentCanvasHandle>(null);
  const baselineTextRef = useRef("");
  const [activeMatchId, setActiveMatchId] = useState<string | null>(null);
  // Which AI-flagged paragraph the reader picked from the sidebar card —
  // kept apart from activeMatchId (Functional Wall Rule: separate signal),
  // but the two are mutually exclusive in the UI (picking one clears the
  // other) so the Document view never has to show two kinds of focus at once.
  const [activeAiSegmentId, setActiveAiSegmentId] = useState<string | null>(null);
  // Sidebar tab, lifted here so the document shows only that tab's
  // highlights: "sources" -> matched passages, "ai" -> AI-flagged paragraphs.
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("sources");
  // Bumped on every selection so picking the same source again scrolls again.
  const [focusTick, setFocusTick] = useState(0);
  // Plagiarism highlights on/off in the Document view (presentational only).
  const [showHighlights, setShowHighlights] = useState(true);
  const [resolvedIds, setResolvedIds] = useState<Set<string>>(new Set());
  const [comparisonMatch, setComparisonMatch] = useState<MatchedSource | null>(null);
  const [citingMatch, setCitingMatch] = useState<MatchedSource | null>(null);
  const [rewriteMatch, setRewriteMatch] = useState<MatchedSource | null>(null);
  const [exporting, setExporting] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Default to the Original PDF view with plagiarism highlighted directly on
  // the uploaded file — the Document (extracted-text) view is opt-in via the
  // toolbar's view switcher, not the first thing a user sees.
  const [view, setView] = useState<ReportView>("original");
  useSplashHold(
    !!id && !notFound && !loadError && (!doc || (view === "original" && pdfComing && !pdfReady)),
    { reshow: false },
  );
  // Only the Edit tab lets the user type; Document and Original are read-only.
  // While a re-check runs the text it checks must not change under it.
  const [recheckRunning, setRecheckRunning] = useState(false);
  const locked = view !== "edit" || recheckRunning;
  // Document and Edit show the extracted text; Original swaps in the PDF
  // viewer. They are two separate editors: Document always shows the text as
  // it was checked, Edit shows the user's (saved) edits. The Edit editor stays
  // mounted, hidden, while Document is showing, so unsaved typing survives a
  // look at the unedited text.
  const showsText = view !== "original";
  const [stats, setStats] = useState({ words: 0, characters: 0 });
  const [pageState, setPageState] = useState({ page: 1, pageCount: 1 });
  const [originalPageState, setOriginalPageState] = useState({ page: 1, pageCount: 1 });
  const [fileName, setFileName] = useState("");

  useEffect(() => {
    if (doc) setFileName(historyMeta?.title ?? doc.title ?? doc.fileName ?? tl("Untitled document"));
  }, [doc, historyMeta?.title]);

  // Remounting the editor is the only way to discard the browser-owned DOM and
  // re-render from fresh data, so a finished re-check bumps this key (once
  // the re-checked report has arrived).
  const resetKey = loadedNonce;

  // The document body is rendered once and then owned by the browser (the user
  // types into it), so the initial counts are read back off the DOM rather than
  // recomputed from `doc.passages`.
  // The text as last checked, and whether the editor now differs from it —
  // what makes "Save & re-check" worth pressing (a saved draft counts too).
  const checkedTextRef = useRef<string | null>(null);
  const [editedSinceCheck, setEditedSinceCheck] = useState(false);
  const refreshEditedSinceCheck = useCallback((text: string) => {
    setEditedSinceCheck(checkedTextRef.current !== null && text.trim() !== checkedTextRef.current.trim());
  }, []);

  useEffect(() => {
    const text = editorRef.current?.innerText ?? "";
    baselineTextRef.current = text;
    checkedTextRef.current = editorRef.current ? text : null;
    setEditedSinceCheck(false);
    setStats({ words: countWords(text), characters: text.length });
    setDirty(false);
  }, [doc?.id, resetKey]);

  // Load persisted edit-history snapshots for the Version History menu (see
  // supabase/migrations/20260726000000_document_versions.sql). Best-effort:
  // a fetch failure just leaves the menu empty rather than blocking the page.
  useEffect(() => {
    if (!id) {
      setVersions([]);
      return;
    }
    let cancelled = false;
    fetchDocumentVersions(id).then(
      (v) => {
        if (!cancelled) setVersions(v);
      },
      () => {
        if (!cancelled) setVersions([]);
      },
    ).then(() => {
      // Plus the versions handleSave had to keep on this device because
      // Supabase refused them (see lib/localDocumentVersions.ts).
      const local = loadLocalDocumentVersions(id);
      if (!cancelled && local.length > 0) {
        setVersions((prev) => [...local, ...prev].slice(0, 20));
      }
    });
    return () => {
      cancelled = true;
    };
    // loadedNonce: reload after a re-check or restore, for the new scores.
  }, [id, loadedNonce]);

  // Show the latest saved version in the Document/Edit editor, not the text
  // from the check: the editor is rebuilt from `doc.passages` whenever it
  // mounts (reload, or coming back from the Original tab). Skipped while the
  // editor holds unsaved typing so that is never overwritten.
  const latestSavedHtml = versions[0]?.html;
  // The editor element this effect last saw. A different one means the editor
  // was just (re)mounted — e.g. the page opened on the Original tab, where the
  // baseline above was read while no editor existed — so nothing can have
  // been typed into it yet and its fresh text is the baseline.
  const syncedEditorRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const editor = editorRef.current;
    if (!showsText || !editor) return;
    if (syncedEditorRef.current !== editor) {
      syncedEditorRef.current = editor;
      baselineTextRef.current = editor.innerText;
      // A fresh editor shows the checked passages until a saved version is applied below.
      checkedTextRef.current = editor.innerText;
      setEditedSinceCheck(false);
      setStats({ words: countWords(editor.innerText), characters: editor.innerText.length });
      setDirty(false);
    }
    if (!latestSavedHtml) return;
    if (editor.innerText !== baselineTextRef.current) return;
    if (!applySavedVersion(editor, latestSavedHtml)) return;
    const text = editor.innerText;
    baselineTextRef.current = text;
    refreshEditedSinceCheck(text);
    setStats({ words: countWords(text), characters: text.length });
    setDirty(false);
  }, [showsText, latestSavedHtml, doc?.id, resetKey, refreshEditedSinceCheck]);

  const visibleMatches = useMemo(
    () =>
      doc ? (isFree ? doc.matches.filter((m) => m.detectionType === "traditional") : doc.matches) : [],
    [isFree, doc],
  );
  const lockedMatches = useMemo(
    () => (doc && isFree ? doc.matches.filter((m) => m.detectionType === "semantic") : []),
    [isFree, doc],
  );

  const rendered = useMemo(
    () => buildRenderedPassages(doc?.passages ?? [], visibleMatches),
    [doc?.passages, visibleMatches],
  );

  // AI-detection segments worth pointing at — same score threshold
  // AiDetectionSection uses for its own "Paragraphs that look
  // machine-written" list, so the highlighted set in the Document/Original
  // views always matches exactly what the sidebar lists.
  const flaggedAiSegments = useMemo(
    () =>
      (doc?.aiDetection?.available ? doc.aiDetection.segments : [])
        .filter((s) => s.score >= 60)
        .map((s) => ({ id: `${s.start}-${s.end}`, start: s.start, end: s.end, excerpt: s.excerpt ?? "", score: s.score })),
    [doc],
  );
  // Which passage (Document view block) each flagged segment falls inside —
  // see highlights.ts's mapAiSegmentsToPassages docstring for why this is a
  // whole-paragraph mapping rather than a sentence-level one.
  const aiSegmentToPassage = useMemo(
    () => mapAiSegmentsToPassages(doc?.passages ?? [], flaggedAiSegments),
    [doc?.passages, flaggedAiSegments],
  );
  const aiFlaggedIds = useMemo(() => aiFlaggedPassageIds(aiSegmentToPassage), [aiSegmentToPassage]);

  // One kind of highlight at a time. With no AI result the sidebar has no AI
  // tab, so the document stays on source highlights.
  const highlightMode: SidebarTab = doc?.aiDetection?.available ? sidebarTab : "sources";
  const shownMatches = highlightMode === "ai" ? NO_MATCHES : visibleMatches;
  const shownAiSegments = highlightMode === "ai" ? flaggedAiSegments : NO_AI_SEGMENTS;
  const shownAiFlaggedIds = highlightMode === "ai" ? aiFlaggedIds : NO_PASSAGE_IDS;
  const showSourceHighlights = showHighlights && highlightMode === "sources";

  const handleSidebarTabChange = useCallback((next: SidebarTab) => {
    setSidebarTab(next);
    // Drop the other tab's focus, whose highlight is no longer drawn.
    if (next === "ai") setActiveMatchId(null);
    else setActiveAiSegmentId(null);
  }, []);

  // Sidebar order is the source of truth for both the highlight colour and the
  // number badge, so the two views can never disagree.
  const colorIndexByMatch = useMemo<MatchColorIndex>(
    () => new Map(visibleMatches.map((m, i) => [m.id, i])),
    [visibleMatches],
  );

  const baseScore = doc ? (isFree ? doc.similarityScoreFree : doc.similarityScore) : 0;
  // displayScore (was `baseScore - resolvedIds.size * 4`) is now computed
  // below the quick-check hook: each fixed passage takes off its own share of
  // the score (rewriteScore.ts) instead of a flat 4 points.

  const handleInput = useCallback((text: string) => {
    setStats({ words: countWords(text), characters: text.length });
    setDirty(text !== baselineTextRef.current);
    refreshEditedSinceCheck(text);
  }, [refreshEditedSinceCheck]);

  // The Document tab is read-only, so it has nothing to report.
  const ignoreInput = useCallback(() => {}, []);

  const handlePageChange = useCallback((page: number, pageCount: number) => {
    setPageState({ page, pageCount });
  }, []);

  const handleOriginalPageChange = useCallback((page: number, pageCount: number) => {
    setOriginalPageState({ page, pageCount });
  }, []);

  // The Original view isn't editable, so its word/character counts come
  // straight off the document's stored metadata rather than a live DOM read.
  const originalStats = useMemo(
    () => ({
      words: doc?.wordCount ?? 0,
      characters: doc?.passages.reduce((sum, p) => sum + (p.text?.length ?? 0), 0) ?? 0,
    }),
    [doc],
  );

  const wordLimit = planWordLimit(tier);
  // Where (character offset into the document) the word limit is first
  // crossed — feeds the per-view word-limit treatments so they can cut off
  // at the right spot instead of just gating the whole view.
  const overLimitOffset = useMemo(
    () => computeWordLimitOffset(doc?.passages ?? [], wordLimit),
    [doc?.passages, wordLimit],
  );

  // Which highlight each match should jump to. Passages past the word limit
  // are drawn muted with no highlights (renderPassageText), so they can't be a
  // target. A match missing from this map has nowhere to point in the Document
  // view — the sidebar says so rather than silently doing nothing.
  const focusMap = useMemo(
    () => buildMatchFocusMap(rendered.filter((r) => !isOverLimit(r.passage, overLimitOffset))),
    [rendered, overLimitOffset],
  );
  const focusMatchId = activeMatchId ? (focusMap.get(activeMatchId) ?? null) : null;
  const locatedIds = useMemo(() => new Set(focusMap.keys()), [focusMap]);

  // Quick check of rewritten / hand-edited passages against this report's
  // own sources (useQuickCheck.ts) — catches a rewrite that still copies the
  // source, or an edit that now copies a different one.
  const handleQuickCheckResult = useCallback(
    (check: PassageCheck) => {
      if (check.status !== "flagged") return;
      pushToast({
        kind: "warning",
        title: tr("The edited passage still overlaps a source"),
        description: tl("It is similar to \"{{title}}\". Reword it again, or quote and cite the source.", {
          title: check.hits[0]?.source_title || tl("a source"),
        }),
      });
    },
    [pushToast],
  );
  const quickCheck = useQuickCheck({
    reportId: id ?? null,
    editorRef,
    enabled: view === "edit",
    matches: visibleMatches,
    focusMap,
    setResolvedIds,
    onResult: handleQuickCheckResult,
  });
  const scoreEstimate = useMemo(
    () => estimateScore(baseScore, doc?.matches ?? [], resolvedIds, quickCheck.checks.values()),
    [baseScore, doc?.matches, resolvedIds, quickCheck.checks],
  );
  const displayScore = scoreEstimate.score;
  // A passage the quick check found still overlapping a source is not "Fixed":
  // its card says what it still overlaps instead.
  const stillFlaggedNotes = useMemo(() => {
    const notes = new Map<string, string>();
    for (const check of quickCheck.checks.values()) {
      if (check.status !== "flagged") continue;
      const title = check.hits[0]?.source_title || tl("a source");
      check.matchIds.forEach((matchId) => notes.set(matchId, title));
    }
    return notes;
  }, [quickCheck.checks]);
  const sidebarResolvedIds = useMemo(() => {
    if (stillFlaggedNotes.size === 0) return resolvedIds;
    return new Set([...resolvedIds].filter((matchId) => !stillFlaggedNotes.has(matchId)));
  }, [resolvedIds, stillFlaggedNotes]);

  // Picking a source focuses it: the Document view then shows only that
  // source's highlight. Picking the one already focused lets go again, so the
  // same click that focused it also brings every highlight back.
  const handleSelectMatch = useCallback((matchId: string) => {
    setActiveMatchId((current) => (current === matchId ? null : matchId));
    setActiveAiSegmentId(null);
    setFocusTick((t) => t + 1);
  }, []);
  const clearSelection = useCallback(() => setActiveMatchId(null), []);

  // Same toggle-to-let-go behaviour as handleSelectMatch, for a flagged
  // paragraph picked from the AI Detection sidebar card.
  const handleSelectAiSegment = useCallback((segmentId: string) => {
    setActiveAiSegmentId((current) => (current === segmentId ? null : segmentId));
    setActiveMatchId(null);
    setFocusTick((t) => t + 1);
  }, []);

  // Escape also lets go of the focused source (unless the key is meant for a
  // text field or an already-handled dialog).
  useEffect(() => {
    if (!activeMatchId && !activeAiSegmentId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      setActiveMatchId(null);
      setActiveAiSegmentId(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [activeMatchId, activeAiSegmentId]);

  // "Accept & replace" (only reachable outside reading mode — see
  // notifyReadingMode): put the AI rewrite into the document in place of the
  // flagged sentence. Only counts as fixed (Fixed badge, lower score) if the
  // text really was replaced — this used to just mark the card and show a
  // "Passage replaced" toast without touching the document at all.
  function replaceFlaggedPassage(match: MatchedSource, rewritten: string) {
    // The highlight that covers this match — its own, or the stronger one it was merged into.
    const targetId = focusMap.get(match.id);
    const target = targetId ? visibleMatches.find((m) => m.id === targetId) : undefined;

    // A merged match's highlight may span different words than this match's
    // sentence; replacing it with a rewrite of *this* sentence would then
    // rewrite the wrong text, so only proceed when they are the same words.
    const sameWords =
      target !== undefined && normalizeWhitespace(target.userSnippet) === normalizeWhitespace(match.userSnippet);

    const replaced =
      targetId !== undefined &&
      sameWords &&
      (canvasRef.current?.replaceMatchText(targetId, rewritten, match.userSnippet) ?? false);

    if (!replaced) {
      pushToast({
        kind: "error",
        title: tr("Couldn't replace the passage"),
        description: tr("It no longer matches the document text exactly. Use Copy and paste the rewrite in yourself."),
      });
      return;
    }

    setResolvedIds((prev) => new Set(prev).add(match.id));
    // Is the rewrite itself clean? (Same request as the panel's pre-check.)
    quickCheck.checkAcceptedRewrite(targetId, rewritten);
    // Its highlight is gone; a lingering selection would hide every other one.
    setActiveMatchId(null);
    pushToast({
      kind: "success",
      title: tr("Passage replaced"),
      description: tr("The flagged sentence now reads as your rewrite. Save to keep this version."),
    });
  }

  // Only the Edit view has editable text, so accepting from another view switches to
  // the Edit view first and applies the rewrite once the editor is mounted.
  const pendingRewriteRef = useRef<{ match: MatchedSource; rewritten: string } | null>(null);

  // Document and Original are read-only views, so neither opening a rewrite
  // nor accepting one may edit through them: tell the user to switch to the
  // Edit tab instead.
  function notifyReadingMode() {
    pushToast({
      kind: "warning",
      title: tr("You're in reading mode"),
      description: tr("The document can only be edited in the Edit tab. Switch to it in the toolbar, then try again."),
    });
  }

  /** Returns false when the rewrite was refused (reading mode), so the panel can stay open and the text isn't lost. */
  function handleAcceptRewrite(match: MatchedSource, rewritten: string): boolean {
    if (locked) {
      notifyReadingMode();
      return false;
    }
    trackEvent("rewrite_accepted");
    if (view !== "edit") {
      pendingRewriteRef.current = { match, rewritten };
      setView("edit");
      return true;
    }
    replaceFlaggedPassage(match, rewritten);
    return true;
  }

  useEffect(() => {
    if (view !== "edit" || !pendingRewriteRef.current) return;
    const { match, rewritten } = pendingRewriteRef.current;
    pendingRewriteRef.current = null;
    replaceFlaggedPassage(match, rewritten);
  });

  async function handleRename(next: string) {
    if (!id) return;
    setFileName(next);
    renameDocumentInHistory(id, next);
    try {
      await renameDocument(id, next);
    } catch {
      pushToast({
        kind: "error",
        title: tr("Rename failed"),
        description: tr("The new name is shown locally but could not be saved."),
      });
    }
  }

  /** How much `text` changed since the newest saved version (or, with none,
   * since the text as checked) — the "% changed" in Version History. */
  function changeSinceLastVersion(text: string): number | undefined {
    const before = versions[0] ? htmlToText(versions[0].html) : checkedTextRef.current;
    return before === null ? undefined : changedRatio(before, text);
  }

  async function handleSave() {
    if (!id) return;
    const text = editorRef.current?.innerText ?? "";
    const html = editorRef.current?.innerHTML ?? "";
    const changed = changeSinceLastVersion(text);
    setSaving(true);
    try {
      const version = await saveDocumentVersion(id, {
        label: tl("Version {{v}}", { v: versions.length + 1 }),
        html,
        wordCount: countWords(text),
        changedRatio: changed,
      });
      baselineTextRef.current = text;
      setVersions((prev) => [version, ...prev].slice(0, 20));
      setDirty(false);
      pushToast({ kind: "success", title: tr("Draft saved"), description: tr("A version was added to history.") });
    } catch (err) {
      console.error("Saving document version to Supabase failed:", err);
      // Keep the edit anyway: store the version on this device instead.
      const localVersion = saveLocalDocumentVersion(id, {
        label: tl("Version {{v}}", { v: versions.length + 1 }),
        html,
        wordCount: countWords(text),
        changedRatio: changed,
      });
      if (localVersion) {
        baselineTextRef.current = text;
        setVersions((prev) => [localVersion, ...prev].slice(0, 20));
        setDirty(false);
        pushToast({
          kind: "success",
          title: tr("Draft saved"),
          description: tr("A version was saved on this device."),
        });
        return;
      }
      pushToast({ kind: "error", title: tr("Could not save"), description: tr("The version was not recorded.") });
    } finally {
      setSaving(false);
    }
  }

  async function handleRestoreVersion(version: DocumentVersion) {
    if (version.check && id) {
      // A re-checked version comes back with its own results: the backend
      // makes that check the current report again, then the page reloads it.
      if (dirty) {
        pushToast({ kind: "warning", title: tr("Save your edits first"), description: tr("Restoring this version would replace them.") });
        return;
      }
      try {
        await restoreCheck(id, version.check.id);
      } catch (err) {
        pushToast({
          kind: "error",
          title: tr("Couldn't restore this version"),
          description: err instanceof Error ? err.message : tr("Please try again."),
        });
        return;
      }
      setResolvedIds(new Set());
      quickCheck.reset();
      setRefetchNonce((n) => n + 1);
      pushToast({ kind: "info", title: tl("Restored {{label}} with its check results", { label: version.label }) });
      return;
    }
    // Block by block first, so the Document tab stays read-only afterwards;
    // the whole-HTML swap is kept for snapshots with no matching blocks.
    if (editorRef.current && !applySavedVersion(editorRef.current, version.html)) {
      editorRef.current.innerHTML = version.html;
    }
    baselineTextRef.current = editorRef.current?.innerText ?? "";
    refreshEditedSinceCheck(baselineTextRef.current);
    setDirty(false);
    pushToast({ kind: "info", title: tl("Restored {{label}}", { label: version.label }) });
  }

  // --- Save & re-check (PLAN.md) --------------------------------------------
  // Saves the editor as a version, then checks only the changed paragraphs
  // (backend/recheck.py). The quote says whether it is free; the backend
  // prices it again and answers 409 if that changed in the meantime.
  const balances = useAppStore((s) => s.balances());
  const requestCheck = useAppStore((s) => s.requestCheck);
  const availableBalances = useMemo(() => balances.filter((b) => b.remaining > 0), [balances]);
  const [recheckOpen, setRecheckOpen] = useState(false);
  const [recheckQuote, setRecheckQuote] = useState<RecheckQuote | null>(null);
  const [recheckSubmitting, setRecheckSubmitting] = useState(false);
  /** Progress of a running re-check (0-100), null when none is running. */
  const [recheckProgress, setRecheckProgress] = useState<number | null>(null);
  const recheckBlocksRef = useRef<RecheckBlock[]>([]);

  async function handleOpenRecheck() {
    if (!id || !editorRef.current) return;
    const blocks = collectEditorBlocks(editorRef.current);
    if (blocks.every((b) => !b.text)) return;
    recheckBlocksRef.current = blocks;
    setRecheckQuote(null);
    setRecheckOpen(true);
    try {
      setRecheckQuote(await quoteRecheck(id, blocks));
    } catch (err) {
      setRecheckOpen(false);
      pushToast({
        kind: "error",
        title: tr("Couldn't start the re-check"),
        description: err instanceof Error ? err.message : tr("Please try again."),
      });
    }
  }

  async function handleConfirmRecheck(source?: BalanceSource) {
    if (!id || !recheckQuote || !editorRef.current) return;
    const quote = recheckQuote;
    const text = editorRef.current.innerText;
    setRecheckSubmitting(true);

    // The version first: a re-check belongs to a version saved on the server
    // (a version kept only on this device can't be re-checked).
    let versionId: string;
    try {
      const version = await saveDocumentVersion(id, {
        label: tl("Version {{v}}", { v: versions.length + 1 }),
        html: editorRef.current.innerHTML,
        wordCount: countWords(text),
        changedRatio: changeSinceLastVersion(text),
      });
      versionId = version.id;
      baselineTextRef.current = text;
      setVersions((prev) => [version, ...prev].slice(0, 20));
      setDirty(false);
    } catch (err) {
      console.error("Saving the version before a re-check failed:", err);
      setRecheckSubmitting(false);
      pushToast({ kind: "error", title: tr("Couldn't save to the server"), description: tr("Nothing was checked. Please try again.") });
      return;
    }

    let jobId: string;
    try {
      const job = await submitRecheck(id, {
        blocks: recheckBlocksRef.current,
        versionId,
        expectedCost: quote.cost,
        balanceSource: quote.cost === "check" ? source : undefined,
      });
      jobId = job.job_id;
    } catch (err) {
      setRecheckSubmitting(false);
      const fresh = changedRecheckQuote(err);
      if (fresh) {
        // Your version is saved; show the new price and let the user decide again.
        setRecheckQuote(fresh);
        pushToast({ kind: "warning", title: tr("The cost of this re-check changed"), description: tr("Please review it again.") });
        return;
      }
      setRecheckOpen(false);
      pushToast({
        kind: "error",
        title: tr("Couldn't start the re-check"),
        description: err instanceof Error ? err.message : tr("Please try again."),
      });
      return;
    }

    setRecheckOpen(false);
    setRecheckSubmitting(false);
    setRecheckProgress(0);
    setRecheckRunning(true);
    try {
      const job = await pollJob(jobId, (j) => setRecheckProgress(j.progress ?? 0));
      if (job.status !== "completed") throw new Error(job.error || tr("The re-check failed. You weren't charged."));
      // Mirror the server's deduction locally (backend/api/usage.py is the real gate).
      if (quote.cost === "check" && source) requestCheck(source);
      trackEvent("recheck_completed");
      setResolvedIds(new Set());
      quickCheck.reset();
      setRefetchNonce((n) => n + 1);
      pushToast({
        kind: "success",
        title: tr("Re-check complete"),
        description: quote.cost === "free" ? tr("This free re-check updated your score.") : tr("Your score is up to date."),
      });
    } catch (err) {
      pushToast({
        kind: "error",
        title: tr("Re-check failed"),
        description: err instanceof Error ? err.message : tr("You weren't charged. Please try again."),
      });
    } finally {
      setRecheckProgress(null);
      setRecheckRunning(false);
    }
  }

  function handleCite(match: MatchedSource) {
    setCitingMatch(match);
  }

  function handleExport() {
    if (isFree) {
      navigate(paywallPath("export", id));
      return;
    }
    trackEvent("report_exported");
    setExporting(true);
    window.setTimeout(() => {
      setExporting(false);
      pushToast({ kind: "success", title: tr("Report exported"), description: tr("Etymos-Report.pdf is ready.") });
    }, 1200);
  }

  // The editor is a full-viewport workspace layered over the app chrome, so the
  // page behind it must not scroll independently.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  if (!id || notFound || loadError) {
    return (
      <div className="mx-auto max-w-2xl px-5 py-24 text-center sm:px-8">
        <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-surface-tint text-ink-400">
          <FileMagnifyingGlass size={26} />
        </div>
        <h1 className="mt-5 text-h3 font-bold text-navy-900">{tl("Report not found")}</h1>
        <p className="mt-2 text-sm text-ink-500">
          {tl(loadError) ??
            tl("We couldn't find this document. It may have been deleted, moved to trash, or the link is incorrect.")}
        </p>
        <Button className="mt-6" onClick={() => navigate("/history")}>
          {tl("Back to History")}</Button>
      </div>
    );
  }

  if ((loading && !doc) || !doc) {
    return (
      <div className="studio-report fixed inset-x-0 bottom-0 top-[var(--banner-h,0px)] z-40 flex flex-col bg-surface-muted">
        <div className="h-14 shrink-0 border-b border-line bg-white/85" />
        <div className="flex flex-1 overflow-hidden">
          <div className="flex-1 px-4 pt-24">
            <div className="mx-auto h-full w-full max-w-[816px] animate-pulse motion-reduce:animate-none rounded-[2px] bg-white" />
          </div>
          <div className="hidden w-[22rem] shrink-0 border-l border-line bg-white p-3 lg:block">
            <div className="h-24 animate-pulse motion-reduce:animate-none rounded-[var(--radius-card)] bg-surface-tint" />
            <div className="mt-2.5 h-24 animate-pulse motion-reduce:animate-none rounded-[var(--radius-card)] bg-surface-tint" />
          </div>
        </div>
      </div>
    );
  }

  const hasOriginal = Boolean(effectivePdfUrl) || Boolean(pdfFetchError);

  return (
    <div className="studio-report fixed inset-x-0 bottom-0 top-[var(--banner-h,0px)] z-40 flex flex-col bg-surface-muted">
      <ReportTopBar
        fileName={fileName}
        onRename={handleRename}
        onGoHome={() => navigate("/upload")}
        locked={locked}
        dirty={dirty}
        saving={saving}
        onSave={handleSave}
        onRecheck={view === "edit" ? handleOpenRecheck : undefined}
        canRecheck={editedSinceCheck && recheckProgress === null && !recheckOpen}
        recheckProgress={recheckProgress}
        versions={versions}
        showAiScores={!isFree}
        onRestoreVersion={handleRestoreVersion}
        exporting={exporting}
        onExport={handleExport}
        exportLocked={isFree}
        scoreSlot={
          <>
            <ScoreChip
              score={displayScore}
              // Edits since the last check make the score an estimate until re-checked.
              estimated={scoreEstimate.estimated || editedSinceCheck}
              checking={scoreEstimate.checking}
            />
            <AiContentChip detection={doc.aiDetection} locked={isFree} onUpgrade={() => navigate(paywallPath("ai-detection", id))} />
          </>
        }
        toolbarSlot={
          <FormatToolbar
            locked={locked}
            onRequestUnlock={() => setView("edit")}
            hasOriginal={hasOriginal}
            view={view}
            onViewChange={setView}
            showHighlights={showHighlights}
            onToggleHighlights={() => {
              setShowHighlights((v) => !v);
              // Flipping the switch is an explicit "show all / hide all", so it
              // also drops any focused source rather than fighting it.
              setActiveMatchId(null);
            }}
            focusActive={showsText && focusMatchId !== null}
            onClearFocus={clearSelection}
            onInsertTable={() => canvasRef.current?.insertTable()}
          />
        }
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {view === "original" ? (
            <div className="relative flex-1 overflow-hidden">
              <PlagiarismPdfViewer
                pdfUrl={effectivePdfUrl ?? ""}
                unavailableMessage={tl(pdfFetchError) ?? undefined}
                matches={shownMatches}
                activeMatchId={activeMatchId}
                onMatchClick={(matchId) => {
                  setActiveMatchId(matchId);
                  setActiveAiSegmentId(null);
                }}
                onPageChange={handleOriginalPageChange}
                overLimitOffset={overLimitOffset}
                aiSegments={shownAiSegments}
                activeAiSegmentId={activeAiSegmentId}
                onAiSegmentClick={handleSelectAiSegment}
                onReady={handlePdfReady}
              />
            </div>
          ) : (
            <>
            {view === "document" && (
              <div className="relative flex min-h-0 flex-1 flex-col">
                {/* The text exactly as checked: never takes saved edits, always read-only. */}
                <DocumentCanvas
                  rendered={rendered}
                  colorIndexByMatch={colorIndexByMatch}
                  activeMatchId={focusMatchId}
                  focusTick={focusTick}
                  showHighlights={showSourceHighlights}
                  onSelectMatch={handleSelectMatch}
                  onClearSelection={clearSelection}
                  locked
                  onInput={ignoreInput}
                  onPageChange={handlePageChange}
                  resetKey={resetKey}
                  editorRef={documentViewEditorRef}
                  overLimitOffset={overLimitOffset}
                  aiFlaggedPassageIds={shownAiFlaggedIds}
                  activeAiBlockId={activeAiSegmentId ? (aiSegmentToPassage.get(activeAiSegmentId) ?? null) : null}
                />
              </div>
            )}
            <div className={cn("relative min-h-0 flex-1 flex-col", view === "edit" ? "flex" : "hidden")}>
              <DocumentCanvas
                ref={canvasRef}
                rendered={rendered}
                colorIndexByMatch={colorIndexByMatch}
                activeMatchId={focusMatchId}
                focusTick={focusTick}
                showHighlights={showSourceHighlights}
                onSelectMatch={handleSelectMatch}
                onClearSelection={clearSelection}
                locked={locked}
                onInput={handleInput}
                onPageChange={handlePageChange}
                resetKey={resetKey}
                editorRef={editorRef}
                overLimitOffset={overLimitOffset}
                aiFlaggedPassageIds={shownAiFlaggedIds}
                activeAiBlockId={activeAiSegmentId ? (aiSegmentToPassage.get(activeAiSegmentId) ?? null) : null}
              />
            </div>
            </>
          )}

          {view === "edit" ? (
            <WordCountPill
              words={stats.words}
              characters={stats.characters}
              page={pageState.page}
              pageCount={pageState.pageCount}
              dirty={dirty}
              locked={locked}
            />
          ) : (
            <WordCountPill
              words={originalStats.words}
              characters={originalStats.characters}
              page={view === "document" ? pageState.page : originalPageState.page}
              pageCount={view === "document" ? pageState.pageCount : originalPageState.pageCount}
              dirty={false}
              locked
            />
          )}
        </main>

        <SourcesSidebar
          matches={visibleMatches}
          lockedCount={lockedMatches.length}
          activeMatchId={activeMatchId}
          locatedIds={showsText ? locatedIds : undefined}
          resolvedIds={sidebarResolvedIds}
          stillFlaggedNotes={stillFlaggedNotes}
          explanationLocked={isFree}
          rewriteLocked={tier !== "professional"}
          aiDetection={doc.aiDetection}
          activeAiSegmentId={activeAiSegmentId}
          onAiSegmentClick={handleSelectAiSegment}
          tab={sidebarTab}
          onTabChange={handleSidebarTabChange}
          onSelect={handleSelectMatch}
          onViewComparison={(match) => {
            trackEvent("source_comparison_opened");
            setComparisonMatch(match);
          }}
          onRewrite={(match) => {
            if (tier !== "professional") {
              navigate(paywallPath("rewrite", id));
              return;
            }
            // Don't spend an AI call on a rewrite that can't be applied.
            if (locked) {
              notifyReadingMode();
              return;
            }
            trackEvent("rewrite_opened");
            setRewriteMatch(match);
          }}
          onCite={handleCite}
          onUpgrade={(reason) => navigate(paywallPath(reason, id))}
          open={sidebarOpen}
          onToggle={() => setSidebarOpen((v) => !v)}
        />
      </div>

      <SourceComparisonModal
        match={comparisonMatch}
        open={comparisonMatch !== null}
        onClose={() => setComparisonMatch(null)}
      />
      <RecheckDialog
        open={recheckOpen}
        onClose={() => {
          if (!recheckSubmitting) setRecheckOpen(false);
        }}
        quote={recheckQuote}
        balances={availableBalances}
        busy={recheckSubmitting}
        onConfirm={(source) => void handleConfirmRecheck(source)}
      />
      <CitationDialog
        match={citingMatch}
        open={citingMatch !== null}
        onClose={() => setCitingMatch(null)}
      />
      <RewritePanel
        match={rewriteMatch}
        open={rewriteMatch !== null}
        onClose={() => setRewriteMatch(null)}
        onAccept={handleAcceptRewrite}
        precheck={quickCheck.runCheck}
      />
    </div>
  );
}
