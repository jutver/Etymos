import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { FileMagnifyingGlass, Sparkle, WarningCircle, X } from "@phosphor-icons/react";
import { supabase, cn } from "@etymos/shared";
import { MotionConfig, m } from "motion/react";
import { useAppStore, planWordLimit, type BalanceSource } from "../../lib/store";
import { changedRecheckQuote, exportReportPdf, pollJob, quoteRecheck, restoreCheck, submitRecheck, type RecheckBlock, type RecheckQuote } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { trackEvent } from "../../lib/analytics";
import {
  fetchCheckedDocument,
  fetchDocumentVersions,
  fetchUploadVersion,
  renameDocument,
  saveDocumentVersion,
} from "../../lib/documentsQueries";
import { loadLocalDocumentVersions, saveLocalDocumentVersion, uploadLocalDocumentVersions } from "../../lib/localDocumentVersions";
import { statusFromScore } from "../../components/Severity";
import { Button } from "../../components/ui/Button";
import { useSplashHold } from "../../components/BootSplash";
import { PlagiarismPdfViewer } from "../../components/PlagiarismPdfViewer";
import { SourceComparisonModal } from "./SourceComparisonModal";
import { ExportVersionModal, type ExportVersionOption } from "./ExportVersionModal";
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
import { computeWordLimitOffset } from "./wordLimit";
import { applySavedVersion, withoutLegacyBadges } from "./applySavedVersion";
import { useQuickCheck } from "./useQuickCheck";
import { RecheckDialog } from "./RecheckDialog";
import { DesktopHintDialog } from "./DesktopHintDialog";
import { collectEditorBlocks } from "./recheck";
import { changedRatio, htmlToText } from "../../lib/textChange";
import { estimateScore, type PassageCheck } from "./rewriteScore";
import type { CheckedDocument, DocStatus, MatchedSource } from "../../lib/types";
import { t as tl, tr, useLanguage } from "../../lib/i18n";
import { effectiveTier, paywallPath } from "../../lib/paywall";
import { PDF_SIGNED_URL_TTL_SECONDS, computeSignedUrlExpiresAt, isSignedUrlStale } from "../../lib/pdfSignedUrl";

// Private Storage bucket the backend uploads original PDFs into (see
// backend/api/app.py's DOCUMENTS_BUCKET / _storage_path: `{user_id}/{report_id}.pdf`).
const DOCUMENTS_BUCKET = "documents";

// Stable empty set when AI passage overlays are hidden in DocumentCanvas.
const NO_PASSAGE_IDS = new Set<string>();
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
/** The `lg` breakpoint, where the sources panel sits beside the document. */
function isWideScreen() {
  return typeof window === "undefined" || window.matchMedia("(min-width: 1024px)").matches;
}

function ScoreChip({
  score,
  estimated = false,
  checking = false,
  compact = false,
}: {
  score: number;
  estimated?: boolean;
  checking?: boolean;
  /** "5.7%" for the phone sources bar, instead of "5.7% similar" (top bar, sm and up). */
  compact?: boolean;
}) {
  const status = statusFromScore(score);
  return (
    <span
      title={
        estimated
          ? tl("Estimated similarity {{score}}% after your edits. Edited passages were only compared with the sources already in this report; a full re-check gives the exact score.", { score: score })
          : tl("Similarity score {{score}}%", { score: score })
      }
      className={cn(
        "shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-semibold tabular-nums",
        compact ? "inline-flex" : "hidden sm:inline-flex",
        SCORE_CHIP[status],
      )}
    >
      {checking && (
        <span aria-hidden="true" className="size-2.5 animate-spin motion-reduce:animate-none rounded-full border border-current border-t-transparent" />
      )}
      {estimated && <span aria-label={tl("estimated")}>≈</span>}
      {compact ? `${score}%` : `${score}${tl("% similar")}`}</span>
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
  const userId = user?.id ?? null;
  const docFileName = doc?.fileName ?? "";
  const hasCachedPdfUrl = Boolean(cachedDoc?.pdfUrl);
  // A .docx has a PDF there only when the server could render one (backend
  // docx_to_pdf.py, needs LibreOffice). Without it the document simply has
  // no Original view - not an error.
  const isDocx = /\.docx$/i.test(docFileName);

  const [signedPdfUrl, setSignedPdfUrl] = useState<string | null>(null);
  const [signedPdfLoading, setSignedPdfLoading] = useState(false);
  const [hadSignedPdf, setHadSignedPdf] = useState(false);
  const [pdfFetchError, setPdfFetchError] = useState<string | null>(null);
  const signedPdfExpiresAtRef = useRef<number | null>(null);
  const signedPdfReqGenRef = useRef(0);
  const signedPdfInFlightRef = useRef<Promise<boolean> | null>(null);

  const fetchSignedPdfUrl = useCallback(
    (opts?: { clearExisting?: boolean }): Promise<boolean> => {
      if (!id || hasCachedPdfUrl || !docFileName || !userId) {
        return Promise.resolve(false);
      }
      if (signedPdfInFlightRef.current) {
        return signedPdfInFlightRef.current;
      }

      const gen = ++signedPdfReqGenRef.current;
      if (opts?.clearExisting) {
        setSignedPdfUrl(null);
      }
      setSignedPdfLoading(true);
      setPdfFetchError(null);

      const promise = (async () => {
        try {
          const { data, error } = await supabase.storage
            .from(DOCUMENTS_BUCKET)
            .createSignedUrl(`${userId}/${id}.pdf`, PDF_SIGNED_URL_TTL_SECONDS);
          if (signedPdfReqGenRef.current !== gen) return false;
          if (error || !data?.signedUrl) {
            signedPdfExpiresAtRef.current = null;
            setSignedPdfUrl(null);
            setPdfFetchError(
              isDocx ? null : (error?.message ?? tl("Could not create a preview link for the original PDF.")),
            );
            return false;
          }
          signedPdfExpiresAtRef.current = computeSignedUrlExpiresAt();
          setHadSignedPdf(true);
          setSignedPdfUrl(data.signedUrl);
          return true;
        } catch (err) {
          if (signedPdfReqGenRef.current !== gen) return false;
          signedPdfExpiresAtRef.current = null;
          setSignedPdfUrl(null);
          setPdfFetchError(
            isDocx
              ? null
              : err instanceof Error
                ? err.message
                : tl("Could not create a preview link for the original PDF."),
          );
          return false;
        } finally {
          if (signedPdfReqGenRef.current === gen) {
            setSignedPdfLoading(false);
            signedPdfInFlightRef.current = null;
          }
        }
      })();

      signedPdfInFlightRef.current = promise;
      return promise;
    },
    [id, hasCachedPdfUrl, docFileName, userId, isDocx],
  );

  useEffect(() => {
    setHadSignedPdf(false);
    signedPdfExpiresAtRef.current = null;

    // A fresh check of a PDF already has the file in memory (pdfUrl); a fresh
    // .docx check doesn't, but its rendering may be in Storage by now.
    if (!id || hasCachedPdfUrl || !docFileName || !userId) {
      signedPdfReqGenRef.current += 1;
      signedPdfInFlightRef.current = null;
      setSignedPdfUrl(null);
      setSignedPdfLoading(false);
      setPdfFetchError(null);
      return;
    }

    void fetchSignedPdfUrl({ clearExisting: true });

    return () => {
      signedPdfReqGenRef.current += 1;
      signedPdfInFlightRef.current = null;
    };
  }, [id, hasCachedPdfUrl, docFileName, userId, fetchSignedPdfUrl]);

  const handleRefreshPdfUrl = useCallback(
    () => (hasCachedPdfUrl ? Promise.resolve(false) : fetchSignedPdfUrl({ clearExisting: true })),
    [hasCachedPdfUrl, fetchSignedPdfUrl],
  );

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
  const pdfComing =
    Boolean(effectivePdfUrl) || signedPdfLoading || (!cachedDoc && Boolean(doc?.fileName) && !pdfFetchError);

  // --- Editor state --------------------------------------------------------
  const editorRef = useRef<HTMLDivElement>(null);
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
  const [scanWarningDismissed, setScanWarningDismissed] = useState(false);
  const [resolvedIds, setResolvedIds] = useState<Set<string>>(new Set());
  const [comparisonMatch, setComparisonMatch] = useState<MatchedSource | null>(null);
  const [citingMatch, setCitingMatch] = useState<MatchedSource | null>(null);
  const [rewriteMatch, setRewriteMatch] = useState<MatchedSource | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exportSelectedKey, setExportSelectedKey] = useState("original");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  // The upload's own result, restorable from Version History (listed last).
  const [originalVersion, setOriginalVersion] = useState<DocumentVersion | null>(null);
  // Side by side on wide screens; on phones the panel is a sheet under the
  // document that starts folded, so the document gets the screen first.
  const [sidebarOpen, setSidebarOpen] = useState(isWideScreen);
  // Default to the Original PDF view with plagiarism highlighted directly on
  // the uploaded file — the Document (extracted-text) view is opt-in via the
  // toolbar's view switcher, not the first thing a user sees.
  const [view, setView] = useState<ReportView>("original");
  const hasSwitchedViewRef = useRef(false);
  const handleViewChange = useCallback(
    (next: ReportView) => {
      hasSwitchedViewRef.current = true;
      setView(next);
      if (
        next === "original" &&
        !hasCachedPdfUrl &&
        docFileName &&
        userId &&
        (!isDocx || hadSignedPdf || Boolean(signedPdfUrl)) &&
        (!signedPdfUrl || isSignedUrlStale(signedPdfExpiresAtRef.current))
      ) {
        void fetchSignedPdfUrl({ clearExisting: true });
      }
    },
    [hasCachedPdfUrl, docFileName, userId, isDocx, hadSignedPdf, signedPdfUrl, fetchSignedPdfUrl],
  );
  // Pasted text and the sample report have no uploaded file, so the Original
  // view could only say so: open those on the Document view instead.
  const noFile = !!doc && !doc.fileName && !cachedDoc?.pdfUrl;
  useEffect(() => {
    if (noFile) setView((v) => (v === "original" ? "document" : v));
  }, [noFile, id]);
  useSplashHold(
    !!id && !notFound && !loadError && (!doc || (view === "original" && pdfComing && !pdfReady)),
    { reshow: false },
  );
  // The Document tab is read-only until the user unlocks it ("edit"); Original
  // always is. While a re-check runs the text it checks must not change under it.
  const [recheckRunning, setRecheckRunning] = useState(false);
  const locked = view !== "edit" || recheckRunning;
  // Document shows the extracted text with the user's (saved) edits, locked or
  // unlocked; Original swaps in the PDF viewer.
  const showsText = view !== "original";
  const [stats, setStats] = useState({ words: 0, characters: 0 });
  const [pageState, setPageState] = useState({ page: 1, pageCount: 1 });
  const [originalPageState, setOriginalPageState] = useState({ page: 1, pageCount: 1 });
  const [fileName, setFileName] = useState("");

  useEffect(() => {
    if (doc) setFileName(historyMeta?.title ?? doc.title ?? doc.fileName ?? tl("Untitled document"));
  }, [doc, historyMeta?.title]);

  // Browser tab: "<document name> - Etymos", following renames. SeoManager
  // resets the title on a language change, so it's re-applied then too.
  const language = useLanguage();
  useEffect(() => {
    if (fileName) document.title = `${fileName} - Etymos`;
  }, [fileName, language]);

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
      setOriginalVersion(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      // Versions handleSave had to keep on this device because Supabase
      // refused them (lib/localDocumentVersions.ts) go to the database first.
      await uploadLocalDocumentVersions(id);
      const [saved, original] = await Promise.all([
        fetchDocumentVersions(id).catch(() => [] as DocumentVersion[]),
        fetchUploadVersion(id),
      ]);
      if (cancelled) return;
      // Any it still refuses stay on this device and are listed too.
      setVersions([...loadLocalDocumentVersions(id), ...saved]);
      setOriginalVersion(original);
    })();
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
        .map((s) => ({ id: `${s.start}-${s.end}`, start: s.start, end: s.end, excerpt: s.excerpt ?? "", score: s.score, pdfRects: s.pdfRects })),
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

  const handlePageChange = useCallback((page: number, pageCount: number) => {
    setPageState((prev) => (prev.page === page && prev.pageCount === pageCount ? prev : { page, pageCount }));
  }, []);

  const handleOriginalPageChange = useCallback((page: number, pageCount: number) => {
    setOriginalPageState((prev) => (prev.page === page && prev.pageCount === pageCount ? prev : { page, pageCount }));
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
    if (!isWideScreen()) setSidebarOpen(true);
    setActiveMatchId((current) => (current === matchId ? null : matchId));
    setActiveAiSegmentId(null);
    setFocusTick((t) => t + 1);
  }, []);
  const clearSelection = useCallback(() => setActiveMatchId(null), []);

  // Same toggle-to-let-go behaviour as handleSelectMatch, for a flagged
  // paragraph picked from the AI Detection sidebar card.
  const handleSelectAiSegment = useCallback((segmentId: string) => {
    if (!isWideScreen()) setSidebarOpen(true);
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

    // A merged highlight can cover more words than this match's sentence; then
    // only the sentence is replaced and the rest stays highlighted ("part").
    const replaced =
      targetId !== undefined
        ? (canvasRef.current?.replaceMatchText(targetId, rewritten, match.userSnippet, match.id) ?? null)
        : null;

    if (!replaced) {
      offerPasteInstead(match, rewritten, targetId);
      return;
    }

    setResolvedIds((prev) => new Set(prev).add(match.id));
    // Is the rewrite itself clean? (Same request as the panel's pre-check.) A
    // partial replace is checked as this match alone, not the whole highlight.
    quickCheck.checkAcceptedRewrite(replaced === "whole" ? targetId! : match.id, rewritten);
    // Its highlight is gone; a lingering selection would hide every other one.
    setActiveMatchId(null);
    pushToast({
      kind: "success",
      title: tr("Passage replaced"),
      description: tr("The flagged sentence now reads as your rewrite. Save to keep this version."),
    });
  }

  // When the rewrite can't go in by itself (the passage spans several
  // paragraphs, or its words were already edited), select the passage and put
  // the rewrite on the clipboard, so one paste replaces it.
  function offerPasteInstead(match: MatchedSource, rewritten: string, targetId: string | undefined) {
    const failed = () =>
      pushToast({
        kind: "error",
        title: tr("Couldn't replace the passage"),
        description: tr("It no longer matches the document text exactly. Use Copy and paste the rewrite in yourself."),
      });
    const selected = targetId !== undefined && (canvasRef.current?.selectMatchText(targetId, match.userSnippet) ?? false);
    if (!selected || !navigator.clipboard) {
      failed();
      return;
    }
    navigator.clipboard.writeText(rewritten).then(
      () =>
        pushToast({
          kind: "info",
          title: tr("Paste to replace"),
          description: tr(
            "This passage couldn't be replaced automatically. It's selected and the rewrite is copied: press Ctrl+V (⌘V on Mac) to paste it in.",
          ),
        }),
      failed,
    );
  }

  // Only the Edit view has editable text, so accepting from another view switches to
  // the Edit view first and applies the rewrite once the editor is mounted.
  const pendingRewriteRef = useRef<{ match: MatchedSource; rewritten: string } | null>(null);

  // Reading mode and Original are read-only, so neither opening a rewrite nor
  // accepting one may edit through them: tell the user to unlock editing.
  function notifyReadingMode() {
    pushToast({
      kind: "warning",
      title: tr("You're in reading mode"),
      description: tr("Unlock editing from the toolbar, then try again."),
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

  const replacePendingRewriteRef = useRef(replaceFlaggedPassage);
  replacePendingRewriteRef.current = replaceFlaggedPassage;
  useEffect(() => {
    if (view !== "edit" || !pendingRewriteRef.current) return;
    const { match, rewritten } = pendingRewriteRef.current;
    pendingRewriteRef.current = null;
    replacePendingRewriteRef.current(match, rewritten);
  }, [view]);

  const handleToggleSidebar = useCallback(() => setSidebarOpen((v) => !v), []);
  const handleViewComparison = useCallback((match: MatchedSource) => {
    trackEvent("source_comparison_opened");
    setComparisonMatch(match);
  }, []);
  const handleRewriteMatch = useCallback(
    (match: MatchedSource) => {
      if (tier !== "professional") {
        navigate(paywallPath("rewrite", id));
        return;
      }
      if (locked) {
        notifyReadingMode();
        return;
      }
      trackEvent("rewrite_opened");
      setRewriteMatch(match);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tier, navigate, id, locked],
  );
  const handleUpgrade = useCallback((reason: "semantic" | "ai-detection") => {
    navigate(paywallPath(reason, id));
  }, [navigate, id]);
  const handleToggleHighlights = useCallback(() => {
    setShowHighlights((v) => !v);
    setActiveMatchId(null);
  }, []);
  const handleRequestUnlock = useCallback(() => {
    if (doc?.isSample) {
      pushToast({
        kind: "info",
        title: tr("This is a sample report"),
        description: tr("Upload your own document to edit and re-check it."),
      });
      return;
    }
    setView("edit");
  }, [doc?.isSample, pushToast]);
  const handleRequestLock = useCallback(() => setView("document"), []);
  const handleInsertTable = useCallback(() => canvasRef.current?.insertTable(), []);

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
      setVersions((prev) => [version, ...prev]);
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
        setVersions((prev) => [localVersion, ...prev]);
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
      pushToast({ kind: "info", title: tl("Restored {{label}} with its check results", { label: tl(version.label) }) });
      return;
    }
    // Block by block first, so the Document tab stays read-only afterwards;
    // the whole-HTML swap is kept for snapshots with no matching blocks.
    if (editorRef.current && !applySavedVersion(editorRef.current, version.html)) {
      editorRef.current.innerHTML = withoutLegacyBadges(version.html);
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
  const refreshBalances = useAppStore((s) => s.refreshBalances);
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
      setVersions((prev) => [version, ...prev]);
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
      // The server has charged a paid re-check by now; show its balances.
      if (quote.cost === "check") void refreshBalances();
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

  const docAiScore = doc?.aiDetection?.available ? doc.aiDetection.overallScore : null;
  const exportOptions = useMemo<ExportVersionOption[]>(() => {
    void language;
    const opts: ExportVersionOption[] = [];
    if (dirty && editorRef.current) {
      opts.push({
        key: "draft",
        kind: "draft",
        versionId: null,
        label: tl("Current Draft"),
        createdAt: null,
        similarityScore: displayScore,
        aiScore: docAiScore,
        isChecked: false,
        html: editorRef.current.innerHTML,
      });
    }
    for (const v of versions) {
      const checked = v.check != null;
      opts.push({
        key: `version:${v.id}`,
        kind: "saved",
        versionId: v.id,
        label: v.label,
        createdAt: v.createdAt ?? null,
        similarityScore: v.check?.score ?? displayScore ?? null,
        aiScore: v.check?.aiScore ?? docAiScore,
        isChecked: checked,
        html: v.html,
      });
    }
    opts.push({
      key: "original",
      kind: "original",
      versionId: null,
      label: originalVersion?.label ? tl(originalVersion.label) : tl("Original Document"),
      createdAt: originalVersion?.createdAt ?? doc?.uploadedAt ?? null,
      similarityScore: originalVersion?.check?.score ?? displayScore ?? null,
      aiScore: originalVersion?.check?.aiScore ?? docAiScore,
      isChecked: true,
      html: null,
    });
    return opts;
  }, [dirty, displayScore, doc?.uploadedAt, docAiScore, language, originalVersion, versions]);

  async function executeExport(option: ExportVersionOption) {
    if (!id || exporting) return;
    trackEvent("report_exported");
    setExporting(true);
    try {
      const { blob, filename } = await exportReportPdf(id, {
        version_kind: option.kind,
        version_id: option.versionId,
        version_label: option.label,
        document_title: fileName || undefined,
        edited_html: option.html,
        lang: language === "vi" ? "vi" : "en",
        snapshot_scores: {
          similarity_score: option.similarityScore,
          ai_score: option.aiScore,
          checked: option.isChecked,
        },
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExportModalOpen(false);
      pushToast({
        kind: "success",
        title: tr("Report exported"),
        description: tl("{{filename}} is ready.", { filename }),
      });
    } catch (err) {
      pushToast({
        kind: "error",
        title: tr("Couldn't export PDF"),
        description: err instanceof Error ? err.message : tr("Please try again."),
      });
    } finally {
      setExporting(false);
    }
  }

  function handleExport() {
    if (isFree) {
      navigate(paywallPath("export", id));
      return;
    }
    if (exportOptions.length <= 1) {
      const only = exportOptions[0];
      if (only) void executeExport(only);
      return;
    }
    setExportSelectedKey(exportOptions[0]?.key ?? "original");
    setExportModalOpen(true);
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

  const hasOriginal =
    Boolean(effectivePdfUrl) || Boolean(pdfFetchError) || (signedPdfLoading && (!isDocx || hadSignedPdf));

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
        originalVersion={originalVersion}
        uploadedAt={doc?.uploadedAt ?? null}
        showAiScores={!isFree}
        onRestoreVersion={handleRestoreVersion}
        exporting={exporting}
        onExport={handleExport}
        exportLocked={isFree}
        scoreSlot={
          <>
            <span data-tour="report-score" className="inline-flex">
              <ScoreChip
                score={displayScore}
                // Edits since the last check make the score an estimate until re-checked.
                estimated={scoreEstimate.estimated || editedSinceCheck}
                checking={scoreEstimate.checking}
              />
            </span>
            <span data-tour="report-ai" className="inline-flex">
              <AiContentChip detection={doc.aiDetection} locked={isFree} onUpgrade={() => navigate(paywallPath("ai-detection", id))} />
            </span>
          </>
        }
        toolbarSlot={
          <FormatToolbar
            locked={locked}
            onRequestUnlock={handleRequestUnlock}
            onRequestLock={handleRequestLock}
            hasOriginal={hasOriginal}
            view={view}
            onViewChange={handleViewChange}
            showHighlights={showHighlights}
            onToggleHighlights={handleToggleHighlights}
            focusActive={showsText ? focusMatchId !== null : activeMatchId !== null}
            onClearFocus={clearSelection}
            onInsertTable={handleInsertTable}
          />
        }
      />

      {doc.isSample && (
        <div className="flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-brand-200 bg-brand-100 px-4 py-2 text-center text-xs text-brand-700 sm:text-sm">
          <span className="flex items-center gap-1.5">
            <Sparkle size={14} weight="fill" className="shrink-0" />
            {tl("This is a sample report on an example essay. Its sources are illustrative.")}
          </span>
          <Link to="/upload" className="font-semibold underline underline-offset-2 hover:text-brand-600">
            {tl("Check your own document")}
          </Link>
        </div>
      )}

      {!scanWarningDismissed &&
        doc.extractionMeta?.warnings?.some((w) => /illegible_scan/i.test(w)) && (
          <div className="flex shrink-0 items-center justify-center gap-3 border-b border-severity-moderate-line bg-severity-moderate-bg/80 px-4 py-1.5 text-xs text-ink-700">
            <span className="flex items-center gap-1.5">
              <WarningCircle size={14} weight="fill" className="shrink-0 text-severity-moderate" />
              {tl("Some scanned pages could not be read clearly and were skipped during text extraction.")}
            </span>
            <button
              type="button"
              onClick={() => setScanWarningDismissed(true)}
              aria-label={tr("Dismiss")}
              className="rounded p-0.5 text-ink-500 transition-colors hover:bg-black/5 hover:text-ink-900"
            >
              <X size={12} weight="bold" />
            </button>
          </div>
        )}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <MotionConfig reducedMotion="user">
            {view === "original" ? (
              <m.div
                key="original"
                initial={hasSwitchedViewRef.current ? { opacity: 0 } : false}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.2, ease: [0.32, 0.72, 0, 1] }}
                className="relative flex flex-1 overflow-hidden"
              >
                <PlagiarismPdfViewer
                  pdfUrl={effectivePdfUrl ?? ""}
                  unavailableMessage={tl(pdfFetchError) ?? undefined}
                  isLoadingUrl={signedPdfLoading && !effectivePdfUrl}
                  onRefreshUrl={!hasCachedPdfUrl ? handleRefreshPdfUrl : undefined}
                  matches={visibleMatches}
                  colorIndexByMatch={colorIndexByMatch}
                  showHighlights={showSourceHighlights}
                  showAiHighlights={highlightMode === "ai"}
                  activeMatchId={activeMatchId}
                  onMatchClick={handleSelectMatch}
                  onPageChange={handleOriginalPageChange}
                  overLimitOffset={overLimitOffset}
                  aiSegments={flaggedAiSegments}
                  activeAiSegmentId={activeAiSegmentId}
                  onAiSegmentClick={handleSelectAiSegment}
                  onReady={handlePdfReady}
                />
              </m.div>
            ) : (
              <m.div
                key="document"
                data-tour="report-document"
                initial={hasSwitchedViewRef.current ? { opacity: 0 } : false}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.2, ease: [0.32, 0.72, 0, 1] }}
                className="relative flex min-h-0 flex-1 flex-col"
              >
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
              </m.div>
            )}
          </MotionConfig>

          {showsText ? (
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
              page={originalPageState.page}
              pageCount={originalPageState.pageCount}
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
          publishedPaperMatch={doc.publishedPaperMatch}
          activeAiSegmentId={activeAiSegmentId}
          onAiSegmentClick={handleSelectAiSegment}
          tab={sidebarTab}
          onTabChange={handleSidebarTabChange}
          onSelect={handleSelectMatch}
          onViewComparison={handleViewComparison}
          onRewrite={handleRewriteMatch}
          onCite={handleCite}
          onUpgrade={handleUpgrade}
          scoreBadge={
            <ScoreChip
              compact
              score={displayScore}
              estimated={scoreEstimate.estimated || editedSinceCheck}
              checking={scoreEstimate.checking}
            />
          }
          open={sidebarOpen}
          onToggle={handleToggleSidebar}
        />
      </div>

      <DesktopHintDialog />
      <ExportVersionModal
        open={exportModalOpen}
        options={exportOptions}
        selectedKey={exportSelectedKey}
        exporting={exporting}
        onSelect={setExportSelectedKey}
        onConfirm={() => {
          const chosen = exportOptions.find((o) => o.key === exportSelectedKey) ?? exportOptions[0];
          if (chosen) void executeExport(chosen);
        }}
        onClose={() => {
          if (!exporting) setExportModalOpen(false);
        }}
      />
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
        reportId={id}
      />
    </div>
  );
}
