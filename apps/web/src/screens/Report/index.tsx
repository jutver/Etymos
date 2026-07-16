import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  DownloadSimple,
  GraduationCap,
  LockSimple,
  Translate,
} from "@phosphor-icons/react";
import { SAMPLE_DOCUMENT, HISTORY_SEED } from "../../lib/mockData";
import { useAppStore } from "../../lib/store";
import { formatDate, formatNumber } from "@etymos/shared";
import { SimilarityBadge, SeverityTag } from "../../components/Severity";
import { MatchCard } from "../../components/MatchCard";
import { Button } from "../../components/ui/Button";
import { SourceComparisonModal } from "./SourceComparisonModal";
import { RewritePanel } from "./RewritePanel";
import { PlagiarismPdfViewer } from "../../components/PlagiarismPdfViewer";
import type { MatchedSource } from "@etymos/shared";

export default function ReportPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const plan = useAppStore((s) => s.plan);
  const pushToast = useAppStore((s) => s.pushToast);
  const isFree = plan === "free";

  const checkedDocuments = useAppStore((s) => s.checkedDocuments);
  const history = useAppStore((s) => s.history);
  const doc = (id && checkedDocuments[id]) || SAMPLE_DOCUMENT;
  const historyMeta = history.find((h) => h.id === id) ?? HISTORY_SEED.find((h) => h.id === id);

  // Đồng bộ giữa highlight trên PDF và match card đang được chọn
  const [activeMatchId, setActiveMatchId] = useState<string | null>(null);
  const [resolvedIds, setResolvedIds] = useState<Set<string>>(new Set());
  const [comparisonMatch, setComparisonMatch] = useState<MatchedSource | null>(null);
  const [rewriteMatch, setRewriteMatch] = useState<MatchedSource | null>(null);
  const [exporting, setExporting] = useState(false);

  const visibleMatches = useMemo(
    () => (isFree ? doc.matches.filter((m) => m.detectionType === "traditional") : doc.matches),
    [isFree, doc.matches],
  );
  const lockedMatches = useMemo(
    () => (isFree ? doc.matches.filter((m) => m.detectionType === "semantic") : []),
    [isFree, doc.matches],
  );

  const baseScore = isFree ? doc.similarityScoreFree : doc.similarityScore;
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
            pdfUrl={doc.pdfUrl || "/test-file.pdf"}
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