import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  DownloadSimple,
  FileMagnifyingGlass,
  GraduationCap,
  LockSimple,
  Translate,
} from "@phosphor-icons/react";
import { supabase } from "@etymos/shared";
import { useAppStore } from "../../lib/store";
import { useAuth } from "../../lib/auth";
import { fetchCheckedDocument } from "../../lib/documentsQueries";
import { formatDate, formatNumber } from "../../lib/format";
import { SimilarityBadge, SeverityTag } from "../../components/Severity";
import { MatchCard } from "../../components/MatchCard";
import { Button } from "../../components/ui/Button";
import { SourceComparisonModal } from "./SourceComparisonModal";
import { RewritePanel } from "./RewritePanel";
import { PlagiarismPdfViewer } from "../../components/PlagiarismPdfViewer";
import type { CheckedDocument, MatchedSource } from "../../lib/types";

// Private Storage bucket the backend uploads original PDFs into (see
// backend/api/app.py's DOCUMENTS_BUCKET / _storage_path: `{user_id}/{report_id}.pdf`).
const DOCUMENTS_BUCKET = "documents";
// Short-lived on purpose (regenerated fresh every time this screen loads a
// historical document — see the signed-URL effect below), matching the
// pattern already used in apps/admin/src/lib/verificationQueries.ts.
const PDF_SIGNED_URL_TTL_SECONDS = 300;

export default function ReportPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const plan = useAppStore((s) => s.plan);
  const pushToast = useAppStore((s) => s.pushToast);
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

  useEffect(() => {
    if (!id || cachedDoc) return;
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
  }, [id, cachedDoc]);

  const doc = cachedDoc ?? remoteDoc ?? null;
  const historyMeta = id ? history.find((h) => h.id === id) : undefined;

  // fetchCheckedDocument() (documentsQueries.ts) only ever reads the
  // `documents`/`document_matches`/`document_passages` tables — it never
  // returns a `pdfUrl`, so any document loaded from history (as opposed to
  // the fast `cachedDoc` path right after Upload/Analyzing, which already
  // carries an in-memory data URL) previously fell through to a bare
  // "/test-file.pdf" fallback that doesn't exist in apps/web/public, causing
  // react-pdf's onLoadError to fire. The real original PDF lives in the
  // private `documents` Storage bucket at `{user_id}/{document_id}.pdf`
  // (backend/api/app.py's _storage_path/get_source_pdf) — fetch it with a
  // signed URL here, the same pattern apps/admin/src/lib/verificationQueries.ts
  // uses for student-verification evidence files.
  const { user } = useAuth();
  const [signedPdfUrl, setSignedPdfUrl] = useState<string | null>(null);
  const [pdfFetchError, setPdfFetchError] = useState<string | null>(null);

  useEffect(() => {
    // Skip when: no id, doc came from the in-memory fast path (already has
    // a working pdfUrl if any), doc hasn't loaded yet, the doc has no
    // fileName (text-only submissions have no source PDF in Storage at
    // all), or we don't yet know who's signed in.
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

  // Đồng bộ giữa highlight trên PDF và match card đang được chọn
  const [activeMatchId, setActiveMatchId] = useState<string | null>(null);
  const [resolvedIds, setResolvedIds] = useState<Set<string>>(new Set());
  const [comparisonMatch, setComparisonMatch] = useState<MatchedSource | null>(null);
  const [rewriteMatch, setRewriteMatch] = useState<MatchedSource | null>(null);
  const [exporting, setExporting] = useState(false);

  const visibleMatches = useMemo(
    () => (doc ? (isFree ? doc.matches.filter((m) => m.detectionType === "traditional") : doc.matches) : []),
    [isFree, doc],
  );
  const lockedMatches = useMemo(
    () => (doc && isFree ? doc.matches.filter((m) => m.detectionType === "semantic") : []),
    [isFree, doc],
  );

  const baseScore = doc ? (isFree ? doc.similarityScoreFree : doc.similarityScore) : 0;
  const displayScore = Math.max(0, baseScore - resolvedIds.size * 4);

  function handleAcceptRewrite(matchId: string) {
    setResolvedIds((prev) => new Set(prev).add(matchId));
    pushToast({
      kind: "success",
      title: "Passage replaced",
      description: "Your similarity score has been recalculated.",
    });
  }

  function handleExport() {
    if (isFree) {
      navigate("/paywall");
      return;
    }
    setExporting(true);
    setTimeout(() => {
      setExporting(false);
      pushToast({ kind: "success", title: "Report exported", description: "Etymos-Report.pdf is ready." });
    }, 1200);
  }

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

  if (loading || !doc) {
    return (
      <div className="mx-auto max-w-[1600px] px-5 py-8 sm:px-8">
        <div className="flex flex-col gap-5 rounded-[var(--radius-card-lg)] border border-line bg-white p-6 shadow-[var(--shadow-card)]">
          <div className="h-6 w-64 animate-pulse rounded bg-surface-muted" />
          <div className="h-4 w-40 animate-pulse rounded bg-surface-muted" />
        </div>
        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[2fr_1fr]">
          <div className="h-[600px] animate-pulse rounded-[var(--radius-card-lg)] bg-surface-tint" />
          <div className="h-[600px] animate-pulse rounded-[var(--radius-card-lg)] bg-surface-tint" />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1600px] px-5 py-8 sm:px-8">
      {/* Top bar */}
      <div className="flex flex-col gap-5 rounded-[var(--radius-card-lg)] border border-line bg-white p-6 shadow-[var(--shadow-card)] lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <h1 className="truncate text-h3 font-bold text-navy-900">
            {historyMeta?.title ?? doc.title}
          </h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-500">
            <span>{formatDate(historyMeta?.date ?? doc.uploadedAt)}</span>
            <span className="flex items-center gap-1">
              <Translate size={13} /> Tiếng Việt
            </span>
            <span>{formatNumber(doc.wordCount)} words</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <SimilarityBadge score={displayScore} />

          <Button
            variant="outline"
            size="sm"
            loading={exporting}
            onClick={handleExport}
            iconLeft={isFree ? <LockSimple size={15} weight="fill" /> : <DownloadSimple size={15} />}
          >
            Export PDF
          </Button>
        </div>
      </div>

      {/* Legend */}
      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-ink-500">
        <span className="font-semibold text-ink-700">Legend:</span>
        <SeverityTag severity="high" />
        <SeverityTag severity="moderate" />
        <SeverityTag severity="low" />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[2fr_1fr]">

        {/* Document viewer */}
        <div className="rounded-[var(--radius-card-lg)] border border-line bg-surface-tint overflow-hidden">
          <PlagiarismPdfViewer
            pdfUrl={effectivePdfUrl ?? ""}
            unavailableMessage={pdfFetchError ?? undefined}
            matches={visibleMatches}
            activeMatchId={activeMatchId}
            onMatchClick={setActiveMatchId}
          />
        </div>

        {/* Match cards sidebar */}
        <div className="flex flex-col gap-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">
            {visibleMatches.length} matched source{visibleMatches.length === 1 ? "" : "s"}
          </p>

          {visibleMatches.map((m, i) => (
            <div
              key={m.id}
              className="relative cursor-pointer"
              onClick={() => setActiveMatchId(m.id)}
            >
              {resolvedIds.has(m.id) && (
                <div className="absolute right-4 top-4 z-10 flex items-center gap-1 rounded-full bg-success-bg px-2.5 py-1 text-xs font-semibold text-success">
                  Resolved
                </div>
              )}
              <MatchCard
                match={m}
                index={i + 1}
                locked={isFree}
                rewriteLocked={plan !== "professional"}
                highlighted={activeMatchId === m.id}
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
              />
            </div>
          ))}

          {lockedMatches.length > 0 && (
            <div className="rounded-[var(--radius-card-lg)] border-2 border-dashed border-brand-300 bg-brand-100/30 p-5 text-center">
              <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-white text-brand-600">
                <GraduationCap size={20} weight="bold" />
              </div>
              <p className="mt-3 text-sm font-semibold text-navy-900">
                {lockedMatches.length} more match found by Semantic Detection
              </p>
              <p className="mt-1 text-xs text-ink-500">
                Free plan only shows traditional matches. Upgrade to catch paraphrased and reworded
                copying too.
              </p>
              <Button size="sm" className="mt-3" onClick={() => navigate("/paywall")}>
                Unlock Semantic Detection
              </Button>
            </div>
          )}
        </div>
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