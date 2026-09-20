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

/** Text of a highlight `<mark>`, without its superscript index badge. */
export function markText(mark: Element): string {
  const clone = mark.cloneNode(true) as Element;
  clone.querySelectorAll("sup").forEach((badge) => badge.remove());
  return clone.textContent ?? "";
}

/** Style of text that has been replaced by a rewrite: a soft green wash rather
 * than a plagiarism colour, so it reads as "fixed". */
export const REWRITTEN_CLASS = "rounded-[3px] bg-success-bg px-[1px]";

/**
 * Replaces the highlight for `matchId` with `newText`.
 *
 * Refuses (returns false, touching nothing) unless the highlight's current text
 * is exactly `expectedSnippet`. That guard is what keeps a rewrite of one
 * sentence from overwriting a different or partly-edited span — e.g. when the
 * whole paragraph was highlighted because the sentence couldn't be located, or
 * when the reader has already edited the words.
 */
export function replaceMarkWithText(
  editor: HTMLElement,
  matchId: string,
  newText: string,
  expectedSnippet: string,
): boolean {
  const mark = editor.querySelector<HTMLElement>(`mark[data-match-id="${CSS.escape(matchId)}"]`);
  if (!mark) return false;
  if (normalizeWhitespace(markText(mark)) !== normalizeWhitespace(expectedSnippet)) return false;

  const replacement = document.createElement("span");
  replacement.dataset.rewritten = "true";
  replacement.className = REWRITTEN_CLASS;
  replacement.textContent = newText;
  mark.replaceWith(replacement);
  return true;
}
