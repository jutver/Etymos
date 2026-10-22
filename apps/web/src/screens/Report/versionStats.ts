// Numbers the Version History menu shows for each saved version.
import { t } from "../../lib/i18n";
import { changedRatio, htmlToText } from "../../lib/textChange";
import type { DocumentVersion } from "./VersionHistoryMenu";

/**
 * Share of each version's text changed since the version before it, by id.
 * Uses the value stored at save time; for versions saved before that existed,
 * compares with the next older version in the list (the oldest has none).
 */
export function versionChanges(versions: DocumentVersion[]): Map<string, number> {
  const changes = new Map<string, number>();
  versions.forEach((v, i) => {
    if (v.changedRatio != null) {
      changes.set(v.id, v.changedRatio);
      return;
    }
    const older = versions[i + 1];
    if (older) changes.set(v.id, changedRatio(htmlToText(older.html), htmlToText(v.html)));
  });
  return changes;
}

/** A score and how far it moved, e.g. {value: 14, delta: -3}; delta null when there is nothing to compare with. */
export function scoreChange(value: number | null, previous: number | null): { value: number; delta: number | null } | null {
  if (value === null) return null;
  const rounded = Math.round(value);
  return { value: rounded, delta: previous === null ? null : rounded - Math.round(previous) };
}

/** "Checked · 14%" for a re-checked version, "Draft" otherwise. */
export function versionTag(version: DocumentVersion): string {
  return version.check ? t("Checked · {{score}}%", { score: Math.round(version.check.score) }) : t("Draft");
}
