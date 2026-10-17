import { lazy, Suspense, useState } from "react";
import { DownloadSimple, FilePdf, Image as ImageIcon } from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import { Modal, ModalCloseButton } from "../ui/Modal";
import { Skeleton } from "../ui/Skeleton";
import { formatBytes } from "./labels";
import type { SupportAttachment } from "../../lib/api";
import { t } from "../../lib/i18n";

const AttachmentPdf = lazy(() => import("./AttachmentPdf"));

const isImage = (a: SupportAttachment) => a.content_type.startsWith("image/");

/** The signed URL with `download=` set, so storage answers with
 * Content-Disposition: attachment and the browser saves the file instead of
 * leaving the page. */
function downloadUrl(a: SupportAttachment) {
  if (!a.url) return undefined;
  return `${a.url}${a.url.includes("?") ? "&" : "?"}download=${encodeURIComponent(a.filename)}`;
}

/** Shown when a link can't load: signed links last 10 minutes. */
function Expired() {
  return <p className="px-2 py-10 text-center text-sm text-ink-500">{t("This file couldn't be loaded. Reload the page and try again.")}</p>;
}

function AttachmentViewer({ attachment, onClose }: { attachment: SupportAttachment | null; onClose: () => void }) {
  const [failed, setFailed] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const a = attachment;
  const broken = !a?.url || failed === a.id;

  return (
    <Modal open={a !== null} onClose={onClose} maxWidth="max-w-4xl" labelledBy="attachment-viewer-title">
      {a && (
        <div className="flex flex-col">
          <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-line bg-white py-3 pl-5 pr-16">
            {isImage(a) ? <ImageIcon size={18} className="shrink-0 text-ink-500" /> : <FilePdf size={18} className="shrink-0 text-ink-500" />}
            <div className="min-w-0 flex-1">
              <p id="attachment-viewer-title" className="truncate text-sm font-semibold text-navy-900">{a.filename}</p>
              <p className="text-xs text-ink-500">{formatBytes(a.size_bytes)}</p>
            </div>
            {!broken && (
              <a
                href={downloadUrl(a)}
                className="inline-flex items-center gap-1.5 rounded-[var(--radius-control)] border border-line px-3 py-1.5 text-xs font-semibold text-ink-700 hover:border-brand-300 hover:text-brand-700"
              >
                <DownloadSimple size={14} weight="bold" />
                {t("Download")}
              </a>
            )}
            <ModalCloseButton onClose={onClose} />
          </div>
          <div className="bg-surface-tint p-4 sm:p-6">
            {broken ? (
              <Expired />
            ) : isImage(a) ? (
              <div className="relative flex min-h-48 justify-center">
                {loaded !== a.id && <Skeleton className="absolute inset-0" rounded="md" />}
                <img
                  src={a.url!}
                  alt={a.filename}
                  onLoad={() => setLoaded(a.id)}
                  onError={() => setFailed(a.id)}
                  className={cn("relative max-h-[75dvh] max-w-full rounded-[var(--radius-control)] object-contain", loaded !== a.id && "opacity-0")}
                />
              </div>
            ) : (
              <Suspense fallback={<Skeleton className="aspect-[1/1.414] w-full" rounded="md" />}>
                <AttachmentPdf url={a.url!} onError={() => setFailed(a.id)} />
              </Suspense>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

function ImageThumb({ attachment, onOpen }: { attachment: SupportAttachment; onOpen: () => void }) {
  const [state, setState] = useState<"loading" | "ready" | "failed">(attachment.url ? "loading" : "failed");
  if (state === "failed") return <FileChip attachment={attachment} onOpen={onOpen} />;
  return (
    <button
      type="button"
      onClick={onOpen}
      title={attachment.filename}
      className="group relative block h-36 w-48 overflow-hidden rounded-xl border border-line bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-300"
    >
      {state === "loading" && <Skeleton className="absolute inset-0" rounded="sm" />}
      <img
        src={attachment.url!}
        alt={attachment.filename}
        loading="lazy"
        onLoad={() => setState("ready")}
        onError={() => setState("failed")}
        className={cn("h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]", state === "loading" && "opacity-0")}
      />
      <span className="sr-only">{t("Open {{name}}", { name: attachment.filename })}</span>
    </button>
  );
}

function FileChip({ attachment, onOpen }: { attachment: SupportAttachment; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="inline-flex items-center gap-1.5 rounded-full border border-line bg-white px-2.5 py-1 text-xs text-ink-700 hover:border-brand-300"
    >
      {isImage(attachment) ? <ImageIcon size={14} /> : <FilePdf size={14} />}
      <span className="max-w-[12rem] truncate">{attachment.filename}</span>
      <span className="text-ink-400">{formatBytes(attachment.size_bytes)}</span>
    </button>
  );
}

/** A message's attachments: images as thumbnails, PDFs as chips. Either
 * opens in a viewer on the page rather than at the storage link. */
export function Attachments({ attachments, alignEnd }: { attachments: SupportAttachment[]; alignEnd?: boolean }) {
  const [open, setOpen] = useState<SupportAttachment | null>(null);
  const images = attachments.filter(isImage);
  const files = attachments.filter((a) => !isImage(a));

  return (
    <>
      {images.length > 0 && (
        <ul className={cn("flex flex-wrap gap-2", alignEnd && "justify-end")}>
          {images.map((a) => (
            <li key={a.id}>
              <ImageThumb attachment={a} onOpen={() => setOpen(a)} />
            </li>
          ))}
        </ul>
      )}
      {files.length > 0 && (
        <ul className={cn("flex flex-wrap gap-2", alignEnd && "justify-end")}>
          {files.map((a) => (
            <li key={a.id}>
              <FileChip attachment={a} onOpen={() => setOpen(a)} />
            </li>
          ))}
        </ul>
      )}
      <AttachmentViewer attachment={open} onClose={() => setOpen(null)} />
    </>
  );
}
