// Save & re-check helpers (PLAN.md): what the editor sends, and the words the
// confirm dialog uses for a quote from backend/api/recheck_quota.py.
import type { RecheckBlock, RecheckQuote } from "../../lib/api";
import { t } from "../../lib/i18n";

/** The editor's blocks in reading order. Block ids are the passage ids the
 * editor was rendered from, so the backend can tell which ones changed;
 * images send no text and keep their stored position. */
export function collectEditorBlocks(editor: HTMLElement): RecheckBlock[] {
  const blocks: RecheckBlock[] = [];
  editor.querySelectorAll<HTMLElement>("[data-block-id]").forEach((el) => {
    const id = el.dataset.blockId;
    // Only top-level blocks: a block nested in another is part of its text.
    if (!id || el.parentElement?.closest("[data-block-id]")) return;
    blocks.push({ block_id: id, text: (el.innerText ?? el.textContent ?? "").trim() });
  });
  return blocks;
}

export function changedPercent(quote: RecheckQuote): number {
  return Math.round(quote.changed_ratio * 100);
}

/** One line on what changed and what it costs. */
export function recheckSummary(quote: RecheckQuote): string {
  const changed = t("{{percent}}% changed since your last full check", { percent: changedPercent(quote) });
  if (quote.cost === "free") {
    return t("{{changed}} · Free re-check ({{left}} of {{limit}} left)", {
      changed,
      left: quote.free_left,
      limit: quote.free_limit,
    });
  }
  return t("{{changed}} — this re-check uses 1 check", { changed });
}

/** Why a re-check isn't free, or null when it is. */
export function recheckCostReason(quote: RecheckQuote): string | null {
  if (quote.cost === "free") return null;
  if (quote.changed_ratio >= quote.change_limit) {
    return t("Free re-checks cover edits under {{limit}}% of the text. A paid re-check starts a fresh count.", {
      limit: Math.round(quote.change_limit * 100),
    });
  }
  return t("You've used all {{limit}} free re-checks since your last full check.", { limit: quote.free_limit });
}
