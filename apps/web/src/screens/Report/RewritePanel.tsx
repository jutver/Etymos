import { useEffect, useRef, useState } from "react";
import { ArrowClockwise, Check, Copy, MagicWand } from "@phosphor-icons/react";
import { SlideOver } from "../../components/ui/SlideOver";
import { ModalCloseButton } from "../../components/ui/Modal";
import { Button } from "../../components/ui/Button";
import { SeverityTag } from "../../components/Severity";
import type { MatchedSource } from "@etymos/shared";
import { cn } from "@etymos/shared";
import { rewriteText } from "../../lib/api";
import type { QuickCheckResponse } from "../../lib/api";
import { WarningCircle, CheckCircle } from "@phosphor-icons/react";
import { t } from "../../lib/i18n";

export function RewritePanel({
  match,
  open,
  onClose,
  onAccept,
  precheck,
  reportId,
}: {
  /** The report this passage is in: the AI rewrite is then checked against
   * its sources and regenerated while it still overlaps one. */
  reportId?: string;
  /** Quick check of the shown rewrite against the report's sources
   * (useQuickCheck.ts), so the reader sees whether it still overlaps one
   * before accepting it. Omit to skip. */
  precheck?: (text: string) => Promise<QuickCheckResponse>;
  match: MatchedSource | null;
  open: boolean;
  onClose: () => void;
  /** Receives the rewrite that was on screen, so the caller can put it into the
   * document. Return `false` to refuse (e.g. reading mode): the panel then stays
   * open so the rewrite can still be copied. */
  onAccept: (match: MatchedSource, rewrittenText: string) => boolean | void;
}) {
  const [variant, setVariant] = useState<string>("");
  // Kept apart from `variant` so an error message can never be accepted into the document as if it were a rewrite.
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  // Mỗi khi panel mở hoặc đổi match, gọi AI ngay lập tức
  useEffect(() => {
    if (open && match) {
      handleRegenerate();
    }
  }, [open, match?.id]);

  // Verdicts the rewrite request already returned, so they aren't asked for twice.
  const knownChecks = useRef(new Map<string, QuickCheckResponse>());

  // Quick check of each rewrite as soon as it is on screen.
  const [precheckState, setPrecheckState] = useState<
    { text: string; status: "checking" | "error" } | { text: string; status: "done"; result: QuickCheckResponse } | null
  >(null);
  useEffect(() => {
    const text = variant.trim();
    if (!precheck || !open || regenerating || failed || !text) {
      setPrecheckState(null);
      return;
    }
    const known = knownChecks.current.get(text);
    if (known) {
      setPrecheckState({ text, status: "done", result: known });
      return;
    }
    let cancelled = false;
    setPrecheckState({ text, status: "checking" });
    precheck(text).then(
      (result) => !cancelled && setPrecheckState({ text, status: "done", result }),
      () => !cancelled && setPrecheckState({ text, status: "error" }),
    );
    return () => {
      cancelled = true;
    };
  }, [precheck, open, regenerating, failed, variant]);

  if (!match) return null;

  async function handleRegenerate() {
    if (!match) return;
    
    setRegenerating(true);
    setCopied(false);
    setFailed(false);

    try {
      // Gọi API Rewrite mới tạo ở Backend
      const data = await rewriteText(match.userSnippet, match.sourceSnippet, reportId);
      if (data.check) knownChecks.current.set(data.rewritten_text.trim(), data.check);
      setVariant(data.rewritten_text);
    } catch (err) {
      console.error("Rewrite error:", err);
      setVariant(t("Something went wrong while contacting the AI. Please try again."));
      setFailed(true);
    } finally {
      setRegenerating(false);
    }
  }

  function handleCopy() {
    navigator.clipboard?.writeText(variant).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <SlideOver open={open} onClose={onClose}>
      <div className="relative flex items-center gap-3 border-b border-line px-6 py-5">
        <div className="flex size-10 items-center justify-center rounded-xl brand-gradient text-white">
          <MagicWand size={20} weight="bold" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-navy-900">{t("AI Rewrite Assistant")}</h2>
          <p className="text-xs text-ink-500">{t("Academic tone · English")}</p>
        </div>
        <ModalCloseButton onClose={onClose} />
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin px-6 py-6">
        <div className="flex items-center gap-2">
          <SeverityTag severity={match.severity} />
          <span className="text-xs font-medium text-ink-500">{match.matchPercent}{t("% match")}</span>
        </div>

        <p className="mt-4 text-[0.6875rem] font-bold uppercase tracking-wide text-ink-500">
          {t("Flagged passage")}</p>
        <div className="mt-2 rounded-[var(--radius-card)] border border-severity-high-line bg-severity-high-bg/40 p-4">
          <p className="text-sm leading-relaxed text-ink-800">{match.userSnippet}</p>
        </div>

        <div className="mt-6 flex items-center justify-between">
          <p className="text-[0.6875rem] font-bold uppercase tracking-wide text-brand-600">
            {t("AI paraphrase")}</p>
          <button
            onClick={handleRegenerate}
            disabled={regenerating}
            className="flex items-center gap-1.5 text-xs font-semibold text-brand-600 hover:underline disabled:opacity-50"
          >
            <ArrowClockwise size={14} className={cn(regenerating && "animate-spin motion-reduce:animate-none")} />
            {regenerating ? t("Regenerating...") : t("Regenerate")}
          </button>
        </div>
        
        <div className="mt-2 min-h-[7rem] rounded-[var(--radius-card)] border border-brand-300/60 bg-brand-100/40 p-4">
          {regenerating ? (
            <div className="flex flex-col gap-2">
              <div className="h-3 w-full animate-pulse motion-reduce:animate-none rounded shimmer-bg" />
              <div className="h-3 w-full animate-pulse motion-reduce:animate-none rounded shimmer-bg" />
              <div className="h-3 w-2/3 animate-pulse motion-reduce:animate-none rounded shimmer-bg" />
            </div>
          ) : (
            <p className="text-sm leading-relaxed text-ink-900">{variant}</p>
          )}
        </div>

        {precheckState && (
          <div
            role="status"
            className={cn(
              "mt-3 flex items-start gap-2 rounded-[var(--radius-card)] border px-3 py-2 text-xs leading-relaxed",
              precheckState.status === "done" && precheckState.result.status === "flagged"
                ? "border-severity-moderate-line bg-severity-moderate-bg text-severity-moderate"
                : precheckState.status === "done"
                  ? "border-success/20 bg-success-bg text-success"
                  : "border-line bg-surface-muted text-ink-500",
            )}
          >
            {precheckState.status === "checking" && (
              <>
                <ArrowClockwise size={14} className="mt-0.5 shrink-0 animate-spin motion-reduce:animate-none" />
                <span>{t("Checking the rewrite against this report's sources...")}</span>
              </>
            )}
            {precheckState.status === "error" && (
              <span>{t("Couldn't check the rewrite right now. Your score will be marked as estimated.")}</span>
            )}
            {precheckState.status === "done" && precheckState.result.status === "clean" && (
              <>
                <CheckCircle size={14} weight="fill" className="mt-0.5 shrink-0" />
                <span>{t("No overlap with any source in this report.")}</span>
              </>
            )}
            {precheckState.status === "done" && precheckState.result.status === "flagged" && (
              <>
                <WarningCircle size={14} weight="fill" className="mt-0.5 shrink-0" />
                <span>
                  {t("Still overlaps \"{{title}}\". Try Regenerate, or edit it yourself after accepting.", {
                    title: precheckState.result.hits[0]?.source_title || t("a source"),
                  })}
                </span>
              </>
            )}
          </div>
        )}

        <p className="mt-3 text-xs text-ink-500">
          {t("Accepting this rewrite replaces the flagged passage in your document and recalculates your similarity score.")}</p>
      </div>

      <div className="flex items-center gap-3 border-t border-line px-6 py-5">
        <Button
          variant="outline"
          onClick={handleCopy}
          disabled={regenerating || failed || !variant}
          iconLeft={copied ? <Check size={16} /> : <Copy size={16} />}
        >
          {copied ? t("Copied") : t("Copy")}
        </Button>
        <Button
          fullWidth
          disabled={regenerating || failed || !variant.trim()}
          onClick={() => {
            if (onAccept(match, variant.trim()) === false) return;
            onClose();
          }}
        >
          {t("Accept & replace")}</Button>
      </div>
    </SlideOver>
  );
}