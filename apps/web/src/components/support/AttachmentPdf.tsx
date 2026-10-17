import { useEffect, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import { Skeleton } from "../ui/Skeleton";
import { t } from "../../lib/i18n";

pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

/** Every page of a PDF attachment, fitted to the viewer's width. Loaded
 * lazily by AttachmentViewer so image-only threads don't pull in pdf.js. */
export default function AttachmentPdf({ url, onError }: { url: string; onError: () => void }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number>(0);
  const [pages, setPages] = useState(0);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  const placeholder = <Skeleton className="aspect-[1/1.414] w-full" rounded="md" />;

  return (
    <div ref={boxRef} className="w-full">
      {width > 0 && (
        <Document
          file={url}
          loading={placeholder}
          error={<p className="py-10 text-center text-sm text-ink-500">{t("Couldn't open this PDF.")}</p>}
          onLoadSuccess={(pdf) => setPages(pdf.numPages)}
          onLoadError={onError}
        >
          <div className="flex flex-col gap-4">
            {Array.from({ length: pages }, (_, i) => (
              <Page
                key={i}
                pageNumber={i + 1}
                width={width}
                loading={placeholder}
                renderAnnotationLayer={false}
                renderTextLayer={false}
                className="overflow-hidden rounded-[var(--radius-control)] border border-line shadow-[var(--shadow-card)]"
              />
            ))}
          </div>
        </Document>
      )}
    </div>
  );
}
