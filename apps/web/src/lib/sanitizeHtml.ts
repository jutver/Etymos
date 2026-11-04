import DOMPurify from "dompurify";

/**
 * Strips anything that can run script (event-handler attributes, <script>,
 * javascript: links, <iframe>, ...) from HTML before it is put into the page
 * with innerHTML.
 *
 * Every HTML string we insert ultimately comes from a user: the marker-pdf
 * preview is the uploader's own PDF text run through Markdown (which keeps raw
 * HTML and javascript: links as-is), and saved versions are editor HTML stored
 * in document_versions. Admins can open any user's report, so unsanitized
 * HTML there would let a crafted PDF run code in an admin's session.
 *
 * Formatting, tables, data-* attributes (data-block-id) and data: images
 * (marker inlines figures that way) are kept.
 */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, { ADD_ATTR: ["contenteditable"] });
}
