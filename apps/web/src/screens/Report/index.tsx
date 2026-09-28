import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { FileMagnifyingGlass } from "@phosphor-icons/react";
import { supabase, cn } from "@etymos/shared";
import { useAppStore, planWordLimit } from "../../lib/store";
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
import { PlagiarismPdfViewer } from "../../components/PlagiarismPdfViewer";
import { SourceComparisonModal } from "./SourceComparisonModal";
import { CitationDialog } from "../../components/CitationDialog";
import { RewritePanel } from "./RewritePanel";
import { ReportTopBar } from "./ReportTopBar";
import { FormatToolbar } from "./FormatToolbar";
import { DocumentCanvas, type DocumentCanvasHandle, type MatchColorIndex } from "./DocumentCanvas";
import { SourcesSidebar } from "./SourcesSidebar";
import { WordCountPill } from "./WordCountPill";
import { AiContentChip } from "./AiContentChip";
import type { DocumentVersion } from "./VersionHistoryMenu";
import { aiFlaggedPassageIds, buildMatchFocusMap, buildRenderedPassages, countWords, mapAiSegmentsToPassages } from "./highlights";
import { isOverLimit } from "./renderPassageText";
import { normalizeWhitespace } from "./replaceMatch";
import { computeWordLimitOffset } from "./wordLimit";
import type { CheckedDocument, DocStatus, MatchedSource } from "../../lib/types";
import { t as tl, tr } from "../../lib/i18n";

// Private Storage bucket the backend uploads original PDFs into (see
// backend/api/app.py's DOCUMENTS_BUCKET / _storage_path: `{user_id}/{report_id}.pdf`).
const DOCUMENTS_BUCKET = "documents";
// Short-lived on purpose (regenerated fresh every time this screen loads a
// historical document — see the signed-URL effect below), matching the
// pattern already used in apps/admin/src/lib/verificationQueries.ts.
const PDF_SIGNED_URL_TTL_SECONDS = 300;

const SCORE_CHIP: Record<DocStatus, string> = {
  clean: "text-success bg-success-bg border-success/20",
  low: "text-severity-low bg-severity-low-bg border-severity-low-line",
  moderate: "text-severity-moderate bg-severity-moderate-bg border-severity-moderate-line",
  high: "text-severity-high bg-severity-high-bg border-severity-high-line",
};

/** Compact similarity readout, sized to live in the top bar. */
function ScoreChip({ score }: { score: number }) {
  const status = statusFromScore(score);
  return (
    <span
      title={tl("Similarity score {{score}}%", { score: score })}
      className={cn(
        "hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold tabular-nums sm:inline-flex",
        SCORE_CHIP[status],
      )}
    >
      {score}{tl("% similar")}</span>
  );
}

export default function ReportPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const plan = useAppStore((s) => s.plan);
  const pushToast = useAppStore((s) => s.pushToast);
  const renameDocumentInHistory = useAppStore((s) => s.renameDocumentInHistory);
  const isFree = plan === "free";

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
  const [refetchNonce, setRefetchNonce] = useState(0);

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
  // Bumped on every selection so picking the same source again scrolls again.
  const [focusTick, setFocusTick] = useState(0);
  // Plagiarism highlights on/off in the Document view (presentational only).
  const [showHighlights, setShowHighlights] = useState(true);
  const [resolvedIds, setResolvedIds] = useState<Set<string>>(new Set());
  const [comparisonMatch, setComparisonMatch] = useState<MatchedSource | null>(null);
  const [citingMatch, setCitingMatch] = useState<MatchedSource | null>(null);
  const [rewriteMatch, setRewriteMatch] = useState<MatchedSource | null>(null);
  const [exporting, setExporting] = useState(false);
  const [locked, setLocked] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Default to the Original PDF view with plagiarism highlighted directly on
  // the uploaded file — the Document (extracted-text) view is opt-in via the
  // toolbar's view switcher, not the first thing a user sees.
  const [view, setView] = useState<"document" | "original">("original");
  const [stats, setStats] = useState({ words: 0, characters: 0 });
  const [pageState, setPageState] = useState({ page: 1, pageCount: 1 });
  const [originalPageState, setOriginalPageState] = useState({ page: 1, pageCount: 1 });
  const [fileName, setFileName] = useState("");

  useEffect(() => {
    if (doc) setFileName(historyMeta?.title ?? doc.title ?? doc.fileName ?? tl("Untitled document"));
  }, [doc, historyMeta?.title]);

  // Remounting the editor is the only way to discard the browser-owned DOM and
  // re-render from fresh data, so a recheck bumps this key.
  const resetKey = refetchNonce;

  // The document body is rendered once and then owned by the browser (the user
  // types into it), so the initial counts are read back off the DOM rather than
  // recomputed from `doc.passages`.
  useEffect(() => {
    const text = editorRef.current?.innerText ?? "";
    baselineTextRef.current = text;
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
  }, [id]);

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

  // Sidebar order is the source of truth for both the highlight colour and the
  // number badge, so the two views can never disagree.
  const colorIndexByMatch = useMemo<MatchColorIndex>(
    () => new Map(visibleMatches.map((m, i) => [m.id, i])),
    [visibleMatches],
  );

  const baseScore = doc ? (isFree ? doc.similarityScoreFree : doc.similarityScore) : 0;
  const displayScore = Math.max(0, baseScore - resolvedIds.size * 4);

  const handleInput = useCallback((text: string) => {
    setStats({ words: countWords(text), characters: text.length });
    setDirty(text !== baselineTextRef.current);
  }, []);

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

  const wordLimit = planWordLimit(plan);
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
    // Its highlight is gone; a lingering selection would hide every other one.
    setActiveMatchId(null);
    pushToast({
      kind: "success",
      title: tr("Passage replaced"),
      description: tr("The flagged sentence now reads as your rewrite. Save to keep this version."),
    });
  }

  // The Original view has no editable text, so accepting from there switches to
  // the Document view first and applies the rewrite once the editor is mounted.
  const pendingRewriteRef = useRef<{ match: MatchedSource; rewritten: string } | null>(null);

  // Reading mode is a deliberate "don't change my document" lock, so neither
  // opening a rewrite nor accepting one may edit through it: tell the user what
  // to do instead. (The Original view has no lock control of its own — the
  // lock lives on the Document view's toolbar — so the hint differs there.)
  function notifyReadingMode() {
    pushToast({
      kind: "warning",
      title: tr("You're in reading mode"),
      description:
        view === "original"
          ? tr("The document can't be edited in reading mode. Switch to the Document tab and choose \"Reading mode — unlock to edit\", then try again.")
          : tr("The document can't be edited in reading mode. Choose \"Reading mode — unlock to edit\" in the toolbar to switch modes, then continue rewriting."),
    });
  }

  /** Returns false when the rewrite was refused (reading mode), so the panel can stay open and the text isn't lost. */
  function handleAcceptRewrite(match: MatchedSource, rewritten: string): boolean {
    if (locked) {
      notifyReadingMode();
      return false;
    }
    trackEvent("rewrite_accepted");
    if (view !== "document") {
      pendingRewriteRef.current = { match, rewritten };
      setView("document");
      return true;
    }
    replaceFlaggedPassage(match, rewritten);
    return true;
  }

  useEffect(() => {
    if (view !== "document" || !pendingRewriteRef.current) return;
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

  async function handleSave() {
    if (!id) return;
    const text = editorRef.current?.innerText ?? "";
    const html = editorRef.current?.innerHTML ?? "";
    setSaving(true);
    try {
      const version = await saveDocumentVersion(id, {
        label: tl("Version {{v}}", { v: versions.length + 1 }),
        html,
        wordCount: countWords(text),
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

  function handleRestoreVersion(version: DocumentVersion) {
    if (editorRef.current) editorRef.current.innerHTML = version.html;
    baselineTextRef.current = editorRef.current?.innerText ?? "";
    setDirty(false);
    pushToast({ kind: "info", title: tl("Restored {{label}}", { label: version.label }) });
  }

  function handleRecheck() {
    if (loading) return;
    setRefetchNonce((n) => n + 1);
    setResolvedIds(new Set());
    pushToast({ kind: "info", title: tr("Rechecking"), description: tr("Pulling the latest match results.") });
  }

  function handleCite(match: MatchedSource) {
    setCitingMatch(match);
  }

  function handleExport() {
    if (isFree) {
      navigate("/paywall");
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
      <div className="studio-report fixed inset-0 z-40 flex flex-col bg-surface-muted">
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
    <div className="studio-report fixed inset-0 z-40 flex flex-col bg-surface-muted">
      <ReportTopBar
        fileName={fileName}
        onRename={handleRename}
        onGoHome={() => navigate("/upload")}
        locked={locked}
        onToggleLock={() => setLocked((v) => !v)}
        dirty={dirty}
        saving={saving}
        onSave={handleSave}
        versions={versions}
        onRestoreVersion={handleRestoreVersion}
        rechecking={loading}
        onRecheck={handleRecheck}
        exporting={exporting}
        onExport={handleExport}
        exportLocked={isFree}
        scoreSlot={
          <>
            <ScoreChip score={displayScore} />
            <AiContentChip detection={doc.aiDetection} locked={isFree} onUpgrade={() => navigate("/paywall")} />
          </>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <FormatToolbar
            locked={locked}
            onRequestUnlock={() => setLocked(false)}
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
            focusActive={view === "document" && focusMatchId !== null}
            onClearFocus={clearSelection}
            onInsertTable={() => canvasRef.current?.insertTable()}
          />

          {view === "original" ? (
            <div className="relative flex-1 overflow-hidden pt-16">
              <PlagiarismPdfViewer
                pdfUrl={effectivePdfUrl ?? ""}
                unavailableMessage={tl(pdfFetchError) ?? undefined}
                matches={visibleMatches}
                activeMatchId={activeMatchId}
                onMatchClick={(matchId) => {
                  setActiveMatchId(matchId);
                  setActiveAiSegmentId(null);
                }}
                onPageChange={handleOriginalPageChange}
                overLimitOffset={overLimitOffset}
                aiSegments={flaggedAiSegments}
                activeAiSegmentId={activeAiSegmentId}
                onAiSegmentClick={handleSelectAiSegment}
              />
            </div>
          ) : (
            <div className="relative flex min-h-0 flex-1 flex-col">
              <DocumentCanvas
                ref={canvasRef}
                rendered={rendered}
                colorIndexByMatch={colorIndexByMatch}
                activeMatchId={focusMatchId}
                focusTick={focusTick}
                showHighlights={showHighlights}
                onSelectMatch={handleSelectMatch}
                onClearSelection={clearSelection}
                locked={locked}
                onInput={handleInput}
                onPageChange={handlePageChange}
                resetKey={resetKey}
                editorRef={editorRef}
                overLimitOffset={overLimitOffset}
                aiFlaggedPassageIds={aiFlaggedIds}
                activeAiBlockId={activeAiSegmentId ? (aiSegmentToPassage.get(activeAiSegmentId) ?? null) : null}
              />
            </div>
          )}

          {view === "document" ? (
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
          locatedIds={view === "document" ? locatedIds : undefined}
          resolvedIds={resolvedIds}
          explanationLocked={isFree}
          rewriteLocked={plan !== "professional"}
          aiDetection={doc.aiDetection}
          activeAiSegmentId={activeAiSegmentId}
          onAiSegmentClick={handleSelectAiSegment}
          onSelect={handleSelectMatch}
          onViewComparison={(match) => {
            trackEvent("source_comparison_opened");
            setComparisonMatch(match);
          }}
          onRewrite={(match) => {
            if (isFree) {
              navigate("/paywall");
              return;
            }
            if (plan !== "professional") {
              navigate("/pricing");
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
          onUpgrade={() => navigate("/paywall")}
          open={sidebarOpen}
          onToggle={() => setSidebarOpen((v) => !v)}
        />
      </div>

      <SourceComparisonModal
        match={comparisonMatch}
        open={comparisonMatch !== null}
        onClose={() => setComparisonMatch(null)}
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
      />
    </div>
  );
}
