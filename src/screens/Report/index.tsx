import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  DownloadSimple,
  GraduationCap,
  LockSimple,
  Sparkle,
  Translate,
} from "@phosphor-icons/react";
import { SAMPLE_DOCUMENT, HISTORY_SEED } from "../../lib/mockData";
import { useAppStore } from "../../lib/store";
import { formatDate, formatNumber } from "../../lib/format";
import { SimilarityBadge, AIContentBadge, SeverityTag, severityConfig } from "../../components/Severity";
import { MatchCard } from "../../components/MatchCard";
import { LockedOverlay } from "../../components/LockedOverlay";
import { Button } from "../../components/ui/Button";
import { SourceComparisonModal } from "./SourceComparisonModal";
import { RewritePanel } from "./RewritePanel";
import type { MatchedSource } from "../../lib/types";
import { cn } from "../../lib/cn";

export default function ReportPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const plan = useAppStore((s) => s.plan);
  const pushToast = useAppStore((s) => s.pushToast);
  const isFree = plan === "free";

  const doc = SAMPLE_DOCUMENT;
  const historyMeta = HISTORY_SEED.find((h) => h.id === id);

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
  const visibleMatchIds = useMemo(() => new Set(visibleMatches.map((m) => m.id)), [visibleMatches]);

  const baseScore = isFree ? doc.similarityScoreFree : doc.similarityScore;
  const displayScore = Math.max(0, baseScore - resolvedIds.size * 4);

  function scrollToMatch(matchId: string) {
    setActiveMatchId(matchId);
    document.getElementById(`match-${matchId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

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

          {isFree ? (
            <button
              onClick={() => navigate("/paywall")}
              className="flex items-center gap-1.5 rounded-full border border-ai-flag-line bg-ai-flag-bg px-3 py-1.5 text-xs font-semibold text-ai-flag"
            >
              <LockSimple size={13} weight="fill" />
              AI-content detection locked
            </button>
          ) : (
            <AIContentBadge score={doc.aiContentScore} />
          )}

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
        {!isFree && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-ai-flag-line bg-ai-flag-bg px-2.5 py-1 text-xs font-semibold text-ai-flag">
            <Sparkle size={11} weight="fill" />
            AI-generated content
          </span>
        )}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[1.7fr_1fr]">
        {/* Document viewer */}
        <div className="rounded-[var(--radius-card-lg)] border border-line bg-white p-7 lg:p-9">
          <div className="mx-auto max-w-[62ch] space-y-5 text-body leading-[1.85] text-ink-800">
            {doc.passages.map((p) => {
              const isVisibleMatch = p.matchId && visibleMatchIds.has(p.matchId);
              const isResolved = p.matchId && resolvedIds.has(p.matchId);
              const showAiFlag = p.aiFlag && !isFree;

              if (isVisibleMatch && p.severity) {
                const c = severityConfig[p.severity];
                return (
                  <p key={p.id}>
                    <span
                      onClick={() => scrollToMatch(p.matchId!)}
                      className={cn(
                        "cursor-pointer rounded px-0.5 transition-colors",
                        isResolved
                          ? "bg-success-bg decoration-success"
                          : cn(c.bg, activeMatchId === p.matchId && "ring-2 ring-brand-400"),
                      )}
                    >
                      {p.text}
                    </span>
                  </p>
                );
              }

              if (showAiFlag) {
                return (
                  <p key={p.id}>
                    <span
                      onClick={() => scrollToMatch("ai-content")}
                      className="cursor-pointer rounded bg-ai-flag-bg px-0.5"
                    >
                      {p.text}
                    </span>
                  </p>
                );
              }

              return <p key={p.id}>{p.text}</p>;
            })}
          </div>
        </div>

        {/* Match cards sidebar */}
        <div className="flex flex-col gap-4">
          <div id="ai-content" className="rounded-[var(--radius-card-lg)] border border-line bg-white p-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">
              AI-generated content
            </p>
            {isFree ? (
              <div className="mt-3">
                <LockedOverlay
                  title="AI-content detection"
                  description="See the likelihood this text was written by ChatGPT, Gemini, or similar models."
                  compact
                >
                  <div className="flex items-center gap-2 rounded-full border border-ai-flag-line bg-ai-flag-bg px-3.5 py-1.5 text-sm font-semibold text-ai-flag">
                    <Sparkle size={15} weight="fill" />
                    62% likely AI-generated
                  </div>
                </LockedOverlay>
              </div>
            ) : (
              <div className="mt-3">
                <AIContentBadge score={doc.aiContentScore} />
                <p className="mt-3 text-xs leading-relaxed text-ink-600">{doc.aiContentExplanation}</p>
              </div>
            )}
          </div>

          <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">
            {visibleMatches.length} matched source{visibleMatches.length === 1 ? "" : "s"}
          </p>

          {visibleMatches.map((m, i) => (
            <div key={m.id} className="relative">
              {resolvedIds.has(m.id) && (
                <div className="absolute right-4 top-4 z-10 flex items-center gap-1 rounded-full bg-success-bg px-2.5 py-1 text-xs font-semibold text-success">
                  Resolved
                </div>
              )}
              <MatchCard
                match={m}
                index={i + 1}
                locked={isFree}
                highlighted={activeMatchId === m.id}
                onViewComparison={setComparisonMatch}
                onRewrite={(match) => {
                  if (isFree) {
                    navigate("/paywall");
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
