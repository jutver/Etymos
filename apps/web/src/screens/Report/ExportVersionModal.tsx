import { CheckCircle, DownloadSimple, FilePdf, FileText, PencilSimpleLine } from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import { Modal, ModalCloseButton } from "../../components/ui/Modal";
import { Button } from "../../components/ui/Button";
import { t } from "../../lib/i18n";

export interface ExportVersionOption {
  key: string;
  kind: "original" | "saved" | "draft";
  versionId: string | null;
  label: string;
  createdAt: string | null;
  similarityScore: number | null;
  aiScore: number | null;
  isChecked: boolean;
  html: string | null;
}

interface ExportVersionModalProps {
  open: boolean;
  options: ExportVersionOption[];
  selectedKey: string;
  exporting: boolean;
  onSelect: (key: string) => void;
  onConfirm: () => void;
  onClose: () => void;
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ExportVersionModal({
  open,
  options,
  selectedKey,
  exporting,
  onSelect,
  onConfirm,
  onClose,
}: ExportVersionModalProps) {
  return (
    <Modal
      open={open}
      onClose={() => {
        if (!exporting) onClose();
      }}
      maxWidth="max-w-lg"
      labelledBy="export-version-modal-title"
    >
      <div className="relative p-6">
        <ModalCloseButton onClose={() => { if (!exporting) onClose(); }} />
        <div className="flex items-center gap-2.5">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-600">
            <FilePdf size={19} weight="duotone" />
          </div>
          <div>
            <h2 id="export-version-modal-title" className="text-h3 font-bold text-navy-900">
              {t("Choose version to export")}
            </h2>
            <p className="text-xs text-ink-500">
              {t("Your PDF will include the selected document plus similarity, AI, and matched sources pages at the end.")}
            </p>
          </div>
        </div>

        <div className="mt-4 max-h-72 space-y-2 overflow-y-auto pr-0.5" role="radiogroup" aria-labelledby="export-version-modal-title">
          {options.map((opt) => {
            const selected = opt.key === selectedKey;
            const dateLabel = formatDate(opt.createdAt);
            return (
              <button
                key={opt.key}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={exporting}
                onClick={() => onSelect(opt.key)}
                className={cn(
                  "flex w-full items-start justify-between gap-3 rounded-[var(--radius-card)] border px-3.5 py-3 text-left transition-colors",
                  selected
                    ? "border-brand-500 bg-brand-50/50 ring-1 ring-brand-500"
                    : "border-line bg-white hover:bg-surface-muted",
                  exporting && "cursor-not-allowed opacity-70",
                )}
              >
                <div className="flex items-start gap-2.5 min-w-0">
                  <span className={cn("mt-0.5 shrink-0", selected ? "text-brand-600" : "text-ink-400")}>
                    {opt.kind === "draft" ? (
                      <PencilSimpleLine size={17} />
                    ) : opt.kind === "original" ? (
                      <FileText size={17} />
                    ) : (
                      <CheckCircle size={17} weight={selected ? "fill" : "regular"} />
                    )}
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-sm font-semibold text-navy-900">{opt.label}</span>
                      {opt.kind === "draft" && (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                          {t("Unsaved")}
                        </span>
                      )}
                      {opt.kind !== "original" && !opt.isChecked && (
                        <span className="rounded-full bg-surface-tint px-2 py-0.5 text-[11px] font-medium text-ink-500">
                          {t("Not re-checked")}
                        </span>
                      )}
                    </div>
                    {dateLabel && <p className="mt-0.5 text-xs text-ink-400">{dateLabel}</p>}
                  </div>
                </div>

                <div className="flex shrink-0 flex-col items-end gap-0.5 text-xs tabular-nums">
                  {opt.similarityScore !== null && (
                    <span className="font-semibold text-navy-800">
                      {t("Similarity {{score}}%", { score: Math.round(opt.similarityScore) })}
                    </span>
                  )}
                  {opt.aiScore !== null && (
                    <span className="text-ink-500">
                      {t("AI {{score}}%", { score: Math.round(opt.aiScore) })}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={exporting} onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button size="sm" disabled={exporting || !selectedKey} onClick={onConfirm}>
            <DownloadSimple size={15} />
            {exporting ? t("Exporting PDF…") : t("Export PDF")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
