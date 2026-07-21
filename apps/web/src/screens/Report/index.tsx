import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { FileMagnifyingGlass } from "@phosphor-icons/react";
import { supabase, cn } from "@etymos/shared";
import { useAppStore } from "../../lib/store";
import { useAuth } from "../../lib/auth";
import { fetchCheckedDocument, renameDocument } from "../../lib/documentsQueries";
import { statusFromScore } from "../../components/Severity";
import { Button } from "../../components/ui/Button";
import { PlagiarismPdfViewer } from "../../components/PlagiarismPdfViewer";
import { SourceComparisonModal } from "./SourceComparisonModal";
import { RewritePanel } from "./RewritePanel";
import { ReportTopBar } from "./ReportTopBar";
import { FormatToolbar } from "./FormatToolbar";
import { DocumentCanvas, type MatchColorIndex } from "./DocumentCanvas";
import { SourcesSidebar } from "./SourcesSidebar";
import { WordCountPill } from "./WordCountPill";
import type { DocumentVersion } from "./VersionHistoryMenu";
import { buildRenderedPassages, countWords } from "./highlights";
import type { CheckedDocument, DocStatus, MatchedSource } from "../../lib/types";

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
      title={`Similarity score ${score}%`}
      className={cn(
        "hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold tabular-nums sm:inline-flex",
        SCORE_CHIP[status],
      )}
    >
      {score}% similar
    </span>
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
        setLoadError(err instanceof Error ? err.message : "Failed to load report");
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
            error?.message ?? "Không thể tạo liên kết xem trước cho file PDF gốc.",
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
  const baselineTextRef = useRef("");
  const [activeMatchId, setActiveMatchId] = useState<string | null>(null);
  const [resolvedIds, setResolvedIds] = useState<Set<string>>(new Set());
  const [comparisonMatch, setComparisonMatch] = useState<MatchedSource | null>(null);
  const [rewriteMatch, setRewriteMatch] = useState<MatchedSource | null>(null);
  const [exporting, setExporting] = useState(false);
  const [locked, setLocked] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [view, setView] = useState<"document" | "original">("document");
  const [stats, setStats] = useState({ words: 0, characters: 0 });
  const [pageState, setPageState] = useState({ page: 1, pageCount: 1 });
  const [fileName, setFileName] = useState("");

  useEffect(() => {
    if (doc) setFileName(historyMeta?.title ?? doc.title ?? doc.fileName ?? "Untitled document");
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

  function handleAcceptRewrite(matchId: string) {
    setResolvedIds((prev) => new Set(prev).add(matchId));
    pushToast({
      kind: "success",
      title: "Passage replaced",
      description: "Your similarity score has been recalculated.",
    });
  }

  async function handleRename(next: string) {
    if (!id) return;
    setFileName(next);
    renameDocumentInHistory(id, next);
    try {
      await renameDocument(id, next);
    } catch {
      pushToast({
        kind: "error",
        title: "Rename failed",
        description: "The new name is shown locally but could not be saved.",
      });
    }
  }

  function handleSave() {
    const text = editorRef.current?.innerText ?? "";
    const html = editorRef.current?.innerHTML ?? "";
    setSaving(true);
    // STUB: there is no document-body write endpoint yet, so a save records a
    // local snapshot and clears the dirty flag. Swap the timeout for the real
    // mutation when the backend exposes one.
    window.setTimeout(() => {
      baselineTextRef.current = text;
      setVersions((prev) =>
        [
          {
            id: `v-${Date.now()}`,
            label: `Version ${prev.length + 1}`,
            savedAt: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            wordCount: countWords(text),
            html,
          },
          ...prev,
        ].slice(0, 20),
      );
      setSaving(false);
      setDirty(false);
      pushToast({ kind: "success", title: "Draft saved", description: "A version was added to history." });
    }, 500);
  }

  function handleRestoreVersion(version: DocumentVersion) {
    if (editorRef.current) editorRef.current.innerHTML = version.html;
    baselineTextRef.current = editorRef.current?.innerText ?? "";
    setDirty(false);
    pushToast({ kind: "info", title: `Restored ${version.label}` });
  }

  function handleRecheck() {
    if (loading) return;
    setRefetchNonce((n) => n + 1);
    setResolvedIds(new Set());
    pushToast({ kind: "info", title: "Rechecking", description: "Pulling the latest match results." });
  }

  function handleCite(match: MatchedSource) {
    const citation = match.citation || `${match.sourceAuthor}. ${match.sourceTitle}.`;
    navigator.clipboard?.writeText(citation).then(
      () =>
        pushToast({
          kind: "success",
          title: "Citation copied",
          description: "Paste it where the passage appears.",
        }),
      () => pushToast({ kind: "error", title: "Could not copy citation" }),
    );
  }

  function handleExport() {
    if (isFree) {
      navigate("/paywall");
      return;
    }
    setExporting(true);
    window.setTimeout(() => {
      setExporting(false);
      pushToast({ kind: "success", title: "Report exported", description: "Etymos-Report.pdf is ready." });
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
        <h1 className="mt-5 text-h3 font-bold text-navy-900">Report not found</h1>
        <p className="mt-2 text-sm text-ink-500">
          {loadError ??
            "We couldn't find this document. It may have been deleted, moved to trash, or the link is incorrect."}
        </p>
        <Button className="mt-6" onClick={() => navigate("/history")}>
          Back to History
        </Button>
      </div>
    );
  }

  if ((loading && !doc) || !doc) {
    return (
      <div className="fixed inset-0 z-40 flex flex-col bg-surface-muted">
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
    <div className="fixed inset-0 z-40 flex flex-col bg-surface-muted">
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
        scoreSlot={<ScoreChip score={displayScore} />}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <FormatToolbar
            locked={locked}
            onRequestUnlock={() => setLocked(false)}
            hasOriginal={hasOriginal}
            view={view}
            onViewChange={setView}
          />

          {view === "original" ? (
            <div className="flex-1 overflow-hidden pt-16">
              <PlagiarismPdfViewer
                pdfUrl={effectivePdfUrl ?? ""}
                unavailableMessage={pdfFetchError ?? undefined}
                matches={visibleMatches}
                activeMatchId={activeMatchId}
                onMatchClick={setActiveMatchId}
              />
            </div>
          ) : (
            <DocumentCanvas
              rendered={rendered}
              colorIndexByMatch={colorIndexByMatch}
              activeMatchId={activeMatchId}
              onSelectMatch={setActiveMatchId}
              locked={locked}
              onInput={handleInput}
              onPageChange={handlePageChange}
              resetKey={resetKey}
              editorRef={editorRef}
            />
          )}

          {view === "document" && (
            <WordCountPill
              words={stats.words}
              characters={stats.characters}
              page={pageState.page}
              pageCount={pageState.pageCount}
              dirty={dirty}
              locked={locked}
            />
          )}
        </main>

        <SourcesSidebar
          matches={visibleMatches}
          lockedCount={lockedMatches.length}
          activeMatchId={activeMatchId}
          resolvedIds={resolvedIds}
          explanationLocked={isFree}
          rewriteLocked={plan !== "professional"}
          onSelect={setActiveMatchId}
          onViewComparison={setComparisonMatch}
          onRewrite={(match) => {
            if (isFree) {
              navigate("/paywall");
              return;
            }
            if (plan !== "professional") {
              navigate("/pricing");
              return;
            }
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
      <RewritePanel
        match={rewriteMatch}
        open={rewriteMatch !== null}
        onClose={() => setRewriteMatch(null)}
        onAccept={handleAcceptRewrite}
      />
    </div>
  );
}
