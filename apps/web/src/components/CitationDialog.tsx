import { useState } from "react";
import { Check, Copy } from "@phosphor-icons/react";
import type { MatchedSource } from "@etymos/shared";
import { cn } from "@etymos/shared";
import { Modal, ModalCloseButton } from "./ui/Modal";
import { Button } from "./ui/Button";
import { formatCitationText, formatCitationBibtex } from "../lib/citation";

type CitationVariant = "text" | "bibtex";

export function CitationDialog({
  match,
  open,
  onClose,
}: {
  match: MatchedSource | null;
  open: boolean;
  onClose: () => void;
}) {
  const [variant, setVariant] = useState<CitationVariant>("text");
  const [copied, setCopied] = useState(false);

  if (!match) return null;

  const rendered = variant === "text" ? formatCitationText(match) : formatCitationBibtex(match);

  function handleCopy() {
    navigator.clipboard?.writeText(rendered).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      maxWidth="max-w-lg"
      labelledBy="citation-dialog-title"
    >
      <div className="p-6 sm:p-8">
        <ModalCloseButton onClose={onClose} />
        <h2 id="citation-dialog-title" className="text-h3 font-bold text-navy-900">
          Copy citation
        </h2>
        <p className="mt-1 text-sm text-ink-500">{match.sourceTitle}</p>

        <div className="mt-5 flex gap-1.5 rounded-[var(--radius-card)] bg-surface-tint p-1">
          {(
            [
              { id: "text" as const, label: "Text (Word/Docs)" },
              { id: "bibtex" as const, label: "BibTeX" },
            ]
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setVariant(tab.id)}
              className={cn(
                "flex-1 rounded-[var(--radius-card)] px-3 py-1.5 text-xs font-semibold transition-colors",
                variant === tab.id
                  ? "bg-white text-navy-900 shadow-sm"
                  : "text-ink-500 hover:text-ink-900",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <pre className="mt-4 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-card)] border border-line bg-surface-tint p-4 text-sm leading-relaxed text-ink-700">
          {rendered}
        </pre>

        <Button
          className="mt-4 w-full"
          onClick={handleCopy}
          iconLeft={copied ? <Check size={16} /> : <Copy size={16} />}
        >
          {copied ? "Copied" : "Copy to clipboard"}
        </Button>
      </div>
    </Modal>
  );
}
