import { useRef } from "react";
import { FilePdf, Image as ImageIcon, Paperclip, X } from "@phosphor-icons/react";
import { SUPPORT_FILE_ACCEPT, SUPPORT_MAX_FILE_BYTES, SUPPORT_MAX_FILES } from "../../lib/api";
import { t } from "../../lib/i18n";
import { formatBytes } from "./labels";

const ALLOWED = SUPPORT_FILE_ACCEPT.split(",");

/** Screenshots and PDFs for a support message. Checks type, size and count
 * up front; the backend checks the real file content again. */
export function AttachmentPicker({
  files,
  onChange,
  onError,
}: {
  files: File[];
  onChange: (files: File[]) => void;
  onError: (message: string | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);

  function add(picked: FileList | null) {
    if (!picked) return;
    const next = [...files];
    for (const file of Array.from(picked)) {
      if (!ALLOWED.includes(file.type)) {
        onError(t("Only images (PNG, JPG, GIF, WebP) and PDFs can be attached."));
        continue;
      }
      if (file.size > SUPPORT_MAX_FILE_BYTES) {
        onError(t("Each file must be 5 MB or smaller."));
        continue;
      }
      if (next.length >= SUPPORT_MAX_FILES) {
        onError(t("Attach up to 5 files."));
        break;
      }
      next.push(file);
    }
    onChange(next);
    if (input.current) input.current.value = "";
  }

  return (
    <div>
      {files.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-2">
          {files.map((file, i) => (
            <li
              key={`${file.name}-${i}`}
              className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-surface-tint py-1 pl-2.5 pr-1 text-xs text-ink-700"
            >
              {file.type === "application/pdf" ? <FilePdf size={14} /> : <ImageIcon size={14} />}
              <span className="max-w-[12rem] truncate">{file.name}</span>
              <span className="text-ink-400">{formatBytes(file.size)}</span>
              <button
                type="button"
                aria-label={t("Remove {{name}}", { name: file.name })}
                onClick={() => {
                  onError(null);
                  onChange(files.filter((_, j) => j !== i));
                }}
                className="flex size-5 items-center justify-center rounded-full text-ink-400 hover:bg-white hover:text-ink-700"
              >
                <X size={11} weight="bold" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {files.length < SUPPORT_MAX_FILES && (
        <button
          type="button"
          onClick={() => input.current?.click()}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand-600 hover:text-brand-700"
        >
          <Paperclip size={15} />
          {t("Attach screenshots or PDFs")}
        </button>
      )}
      <input
        ref={input}
        type="file"
        multiple
        accept={SUPPORT_FILE_ACCEPT}
        className="hidden"
        onChange={(e) => add(e.target.files)}
      />
    </div>
  );
}
