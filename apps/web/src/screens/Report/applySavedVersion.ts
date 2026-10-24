// Puts a saved Version History snapshot back into the live Document/Edit
// editor. The editor is rebuilt from the check result (`doc.passages`) every
// time it mounts — on reload, or after visiting the Original tab — so without
// this a saved edit only lived in the Version History menu.
//
// It copies text block by block instead of replacing the editor's whole
// innerHTML: React keeps owning each block's wrapper and editable element, so
// reading mode stays read-only, editing stays editable, and the drag
// handles keep working — the result is the same as if the user had typed the
// saved text in again. Block ids are passage ids, so they match across mounts.
// Tables (React state) and block order are not restored.

const EDITABLE_SELECTOR =
  ":scope > p, :scope > h1, :scope > h2, :scope > h3, :scope > ul > li, :scope > ol > li";

/** Versions saved before highlight numbers moved to CSS (renderPassageText.tsx)
 * carry each number as a <sup> inside its <mark>; drop them so they don't come
 * back as text. */
export function withoutLegacyBadges(html: string): string {
  const root = document.createElement("div");
  root.innerHTML = html;
  root.querySelectorAll("mark > sup").forEach((badge) => badge.remove());
  return root.innerHTML;
}

/** Returns true when at least one block's text was taken from `savedHtml`. */
export function applySavedVersion(editor: HTMLElement, savedHtml: string): boolean {
  const saved = document.createElement("div");
  saved.innerHTML = withoutLegacyBadges(savedHtml);
  let applied = false;
  saved.querySelectorAll<HTMLElement>("[data-block-id]").forEach((savedBlock) => {
    const id = savedBlock.dataset.blockId;
    if (!id) return;
    const liveBlock = editor.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(id)}"]`);
    const from = savedBlock.querySelector<HTMLElement>(EDITABLE_SELECTOR);
    const to = liveBlock?.querySelector<HTMLElement>(EDITABLE_SELECTOR);
    if (!from || !to) return;
    if (to.innerHTML !== from.innerHTML) to.innerHTML = from.innerHTML;
    applied = true;
  });
  return applied;
}
