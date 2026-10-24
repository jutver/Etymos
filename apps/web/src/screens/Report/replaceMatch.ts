/**
 * DOM helpers for "Accept & replace": swapping a highlighted passage in the
 * Document view for the AI rewrite.
 *
 * The Document view is a contentEditable block editor whose text lives in the
 * DOM (edits are read back via `innerText`), so the replacement is done on the
 * DOM directly — exactly like a user typing over the sentence. These helpers do
 * not know about reading mode; the caller (Report/index.tsx) refuses to call
 * them while the document is locked.
 */

/** Collapses whitespace runs so comparisons ignore PDF line breaks and
 * double spaces. */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Text of a highlight `<mark>`. The source number is CSS-generated (not text);
 * a `<sup>` badge only appears in versions saved before that change. */
export function markText(mark: Element): string {
  const clone = mark.cloneNode(true) as Element;
  clone.querySelectorAll("sup").forEach((badge) => badge.remove());
  return clone.textContent ?? "";
}

/** Style of text that has been replaced by a rewrite: a soft green wash rather
 * than a plagiarism colour, so it reads as "fixed". */
export const REWRITTEN_CLASS = "rounded-[3px] bg-success-bg px-[1px]";

/** Rewritten text the quick check found still overlapping a source. */
export const REWRITTEN_FLAGGED_CLASS = "rounded-[3px] bg-severity-moderate-bg px-[1px]";

/**
 * Where `snippet` sits in `text`, ignoring whitespace differences: [start, end)
 * offsets into `text`. Null when it isn't there, or when it would start or end
 * inside a word — a cut-off match ("ic vectors…") whose replacement would leave
 * half a word behind.
 */
export function locateSnippet(text: string, snippet: string): { start: number; end: number } | null {
  const needle = normalizeWhitespace(snippet);
  if (!needle) return null;
  // `text` with whitespace runs collapsed, and where each of its characters came from.
  let flat = "";
  const from: number[] = [];
  let space = false;
  for (let i = 0; i < text.length; i += 1) {
    if (/\s/.test(text[i])) {
      space = flat.length > 0;
      continue;
    }
    if (space) {
      flat += " ";
      from.push(i - 1);
      space = false;
    }
    flat += text[i];
    from.push(i);
  }
  const at = flat.indexOf(needle);
  if (at === -1) return null;
  const start = from[at];
  const end = from[at + needle.length - 1] + 1;
  const word = /[\p{L}\p{N}]/u;
  if (start > 0 && word.test(text[start - 1]) && word.test(text[start])) return null;
  if (end < text.length && word.test(text[end]) && word.test(text[end - 1])) return null;
  return { start, end };
}

/** True once a highlight's words differ from the passage it was drawn for. */
export function isEditedHighlight(current: string, original: string): boolean {
  return normalizeWhitespace(current).toLowerCase() !== normalizeWhitespace(original).toLowerCase();
}

/** The DOM position `offset` characters into `markText(root)`. `atEnd` picks
 * the end of a text node over the start of the next when both fit. */
function positionIn(root: Element, offset: number, atEnd: boolean): { node: Text; offset: number } | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let seen = 0;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (node.parentElement?.closest("sup")) continue;
    const length = node.data.length;
    if (atEnd ? offset <= seen + length : offset < seen + length) return { node, offset: offset - seen };
    seen += length;
  }
  return null;
}

/** Removes a highlight left holding only whitespace, keeping that whitespace. */
function unwrapIfBlank(mark: HTMLElement) {
  if (normalizeWhitespace(markText(mark))) return;
  mark.querySelectorAll("sup").forEach((badge) => badge.remove());
  mark.replaceWith(...Array.from(mark.childNodes));
}

function marksFor(editor: HTMLElement, matchId: string): HTMLElement[] {
  return Array.from(editor.querySelectorAll<HTMLElement>(`mark[data-match-id="${CSS.escape(matchId)}"]`));
}

function rewriteSpan(newText: string, rewrittenFrom: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.dataset.rewritten = "true";
  // Which highlight this rewrite replaced, so a later hand edit of the
  // rewritten words can be quick-checked again (useQuickCheck.ts).
  span.dataset.rewrittenFrom = rewrittenFrom;
  span.className = REWRITTEN_CLASS;
  span.textContent = newText;
  return span;
}

/**
 * Replaces `expectedSnippet` in the highlight for `matchId` with `newText`.
 *
 * - "whole": the highlight reads exactly `expectedSnippet` and is replaced.
 * - "part": the highlight is a merged one (several matches drawn as one) that
 *   contains `expectedSnippet`; only those words are replaced, and the rest
 *   stays highlighted. The rewrite is tagged with `partKey`, the match it
 *   belongs to, rather than the whole highlight.
 * - null, touching nothing: the snippet isn't in the highlight word for word
 *   (the reader already edited it), or the highlight spans several blocks.
 *   That guard keeps a rewrite of one sentence from overwriting different text.
 */
export function replaceMarkWithText(
  editor: HTMLElement,
  matchId: string,
  newText: string,
  expectedSnippet: string,
  partKey: string = matchId,
): "whole" | "part" | null {
  const marks = marksFor(editor, matchId);
  if (marks.length !== 1) return null;
  const [mark] = marks;
  const text = markText(mark);

  if (normalizeWhitespace(text) === normalizeWhitespace(expectedSnippet)) {
    mark.replaceWith(rewriteSpan(newText, matchId));
    return "whole";
  }

  const at = locateSnippet(text, expectedSnippet);
  const start = at && positionIn(mark, at.start, false);
  const end = at && positionIn(mark, at.end, true);
  if (!start || !end) return null;

  // Split the mark into [before][rewrite][after]; both halves stay highlighted.
  const tail = document.createRange();
  tail.setStart(end.node, end.offset);
  tail.setEnd(mark, mark.childNodes.length);
  const after = mark.cloneNode(false) as HTMLElement;
  after.append(tail.extractContents());
  // One source number per highlight is enough.
  delete after.dataset.badge;

  const middle = document.createRange();
  middle.setStart(start.node, start.offset);
  middle.setEnd(mark, mark.childNodes.length);
  middle.deleteContents();

  mark.after(rewriteSpan(newText, partKey), after);
  unwrapIfBlank(after);
  if (!normalizeWhitespace(markText(mark)) && after.isConnected && mark.dataset.badge) {
    after.dataset.badge = mark.dataset.badge;
  }
  unwrapIfBlank(mark);
  return "part";
}

/**
 * Selects the highlight for `matchId` (just `snippet` inside it when it can be
 * found) and scrolls it into view, for the reader to paste a rewrite over it.
 * The fallback when replaceMarkWithText refuses, e.g. a passage that spans
 * several paragraphs. False when the highlight is gone.
 */
export function selectMatchText(editor: HTMLElement, matchId: string, snippet: string): boolean {
  const marks = marksFor(editor, matchId);
  if (marks.length === 0) return false;
  const range = document.createRange();
  const at = marks.length === 1 ? locateSnippet(markText(marks[0]), snippet) : null;
  const start = at && positionIn(marks[0], at.start, false);
  const end = at && positionIn(marks[0], at.end, true);
  if (start && end) {
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
  } else {
    range.setStartBefore(marks[0]);
    range.setEndAfter(marks[marks.length - 1]);
  }
  editor.focus({ preventScroll: true });
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  marks[0].scrollIntoView({ behavior: "smooth", block: "center" });
  return true;
}
