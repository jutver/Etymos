import { useEffect, useState } from "react";
import { ArrowClockwise, Check, Copy, MagicWand } from "@phosphor-icons/react";
import { SlideOver } from "../../components/ui/SlideOver";
import { ModalCloseButton } from "../../components/ui/Modal";
import { Button } from "../../components/ui/Button";
import { SeverityTag } from "../../components/Severity";
import type { MatchedSource } from "@etymos/shared";
import { cn } from "@etymos/shared";
import { rewriteText } from "../../lib/api";
import { t } from "../../lib/i18n";

export function RewritePanel({
  match,
  open,
  onClose,
  onAccept,
}: {
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

  if (!match) return null;

  async function handleRegenerate() {
    if (!match) return;
    
    setRegenerating(true);
    setCopied(false);
    setFailed(false);

    try {
      // Gọi API Rewrite mới tạo ở Backend
      const data = await rewriteText(match.userSnippet, match.sourceSnippet);
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