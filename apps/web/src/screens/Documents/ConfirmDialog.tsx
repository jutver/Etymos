import { Modal, ModalCloseButton } from "../../components/ui/Modal";
import { Button } from "../../components/ui/Button";
import { t, tr } from "../../lib/i18n";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  onClose: () => void;
  onConfirm: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = tr("Delete"),
  onClose,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Modal open={open} onClose={onClose} maxWidth="max-w-md" labelledBy="confirm-dialog-title">
      <div className="relative p-6">
        <ModalCloseButton onClose={onClose} />
        <h2 id="confirm-dialog-title" className="text-h3 font-bold text-navy-900">
          {t(title)}
        </h2>
        <p className="mt-2 text-sm text-ink-500">{t(description)}</p>
        <div className="mt-6 flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("Cancel")}</Button>
          <Button variant="danger" onClick={onConfirm}>
            {t(confirmLabel)}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
