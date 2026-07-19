import { useEffect, useState, type FormEvent } from "react";
import { Modal, ModalCloseButton } from "../../components/ui/Modal";
import { Button } from "../../components/ui/Button";

interface PromptModalProps {
  open: boolean;
  title: string;
  description?: string;
  label: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  onClose: () => void;
  onSubmit: (value: string) => void;
}

export function PromptModal({
  open,
  title,
  description,
  label,
  initialValue = "",
  placeholder,
  confirmLabel = "Save",
  onClose,
  onSubmit,
}: PromptModalProps) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setValue(initialValue);
      setError(null);
    }
  }, [open, initialValue]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) {
      setError("This field can't be empty.");
      return;
    }
    onSubmit(trimmed);
  }

  return (
    <Modal open={open} onClose={onClose} maxWidth="max-w-md" labelledBy="prompt-modal-title">
      <form onSubmit={handleSubmit} className="relative p-6">
        <ModalCloseButton onClose={onClose} />
        <h2 id="prompt-modal-title" className="text-h3 font-bold text-navy-900">
          {title}
        </h2>
        {description && <p className="mt-1.5 text-sm text-ink-500">{description}</p>}

        <label className="mt-5 block text-xs font-semibold uppercase tracking-wide text-ink-400">
          {label}
        </label>
        <input
          autoFocus
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          placeholder={placeholder}
          className="mt-1.5 w-full rounded-[var(--radius-control)] border border-line bg-white px-3.5 py-2.5 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-200"
        />
        {error && <p className="mt-1.5 text-xs font-medium text-severity-high">{error}</p>}

        <div className="mt-6 flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary">
            {confirmLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
