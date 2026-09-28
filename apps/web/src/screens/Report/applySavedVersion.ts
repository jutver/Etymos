// Puts a saved Version History snapshot back into the live Document/Edit
// editor. The editor is rebuilt from the check result (`doc.passages`) every
// time it mounts — on reload, or after visiting the Original tab — so without
// this a saved edit only lived in the Version History menu.
//
// It copies text block by block instead of replacing the editor's whole
// innerHTML: React keeps owning each block's wrapper and editable element, so
// the Document tab stays read-only, the Edit tab editable, and the drag
// handles keep working — the result is the same as if the user had typed the
// saved text in again. Block ids are passage ids, so they match across mounts.
// Tables (React state) and block order are not restored.

const EDITABLE_SELECTOR =
  ":scope > p, :scope > h1, :scope > h2, :scope > h3, :scope > ul > li, :scope > ol > li";

/** Returns true when at least one block's text was taken from `savedHtml`. */
export function applySavedVersion(editor: HTMLElement, savedHtml: string): boolean {
  const saved = document.createElement("div");
  saved.innerHTML = savedHtml;
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
