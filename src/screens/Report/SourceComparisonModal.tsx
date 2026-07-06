import { GraduationCap, Globe } from "@phosphor-icons/react";
import { Modal, ModalCloseButton } from "../../components/ui/Modal";
import { SeverityTag } from "../../components/Severity";
import { tokenizeWithOverlap } from "../../lib/textOverlap";
import type { MatchedSource } from "../../lib/types";

function OverlapText({ text, otherText }: { text: string; otherText: string }) {
  const tokens = tokenizeWithOverlap(text, otherText);
  return (
    <p className="text-sm leading-relaxed text-ink-700">
      {tokens.map((t, i) =>
        t.matched ? (
          <mark key={i} className="rounded bg-severity-moderate-bg text-ink-900">
            {t.text}
          </mark>
        ) : (
          <span key={i}>{t.text}</span>
        ),
      )}
    </p>
  );
}

export function SourceComparisonModal({
  match,
  open,
  onClose,
}: {
  match: MatchedSource | null;
  open: boolean;
  onClose: () => void;
}) {
  if (!match) return null;

  return (
    <Modal open={open} onClose={onClose} maxWidth="max-w-4xl" labelledBy="comparison-title">
      <div className="p-6 sm:p-8">
        <ModalCloseButton onClose={onClose} />
        <div className="flex flex-wrap items-center gap-3">
          <h2 id="comparison-title" className="text-h3 font-bold text-navy-900">
            Source comparison
          </h2>
          <SeverityTag severity={match.severity} />
          <span className="text-sm font-semibold text-ink-500">{match.matchPercent}% match</span>
        </div>
        <p className="mt-1 flex items-center gap-1.5 text-sm text-ink-500">
          {match.sourceKind === "academic" ? <GraduationCap size={15} /> : <Globe size={15} />}
          {match.sourceTitle} · {match.citation}
        </p>

        <div className="mt-6 grid grid-cols-1 gap-5 md:grid-cols-2">
          <div className="rounded-[var(--radius-card)] border border-line bg-surface-tint p-5">
            <p className="text-[0.6875rem] font-bold uppercase tracking-wide text-ink-500">
              Your document
            </p>
            <div className="mt-3">
              <OverlapText text={match.userSnippet} otherText={match.sourceSnippet} />
            </div>
          </div>
          <div className="rounded-[var(--radius-card)] border border-line bg-white p-5">
            <p className="text-[0.6875rem] font-bold uppercase tracking-wide text-ink-500">
              {match.sourceAuthor}
            </p>
            <div className="mt-3">
              <OverlapText text={match.sourceSnippet} otherText={match.userSnippet} />
            </div>
          </div>
        </div>

        <p className="mt-4 text-xs text-ink-400">
          Highlighted words appear in both passages. Overlap is measured at the phrase level, not
          just individual words.
        </p>
      </div>
    </Modal>
  );
}
