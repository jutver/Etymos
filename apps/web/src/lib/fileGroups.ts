/** One source file's check history: every check that shares the same
 * `fileName` (or `title`, for pasted-text checks with no file), newest first. */
export interface FileGroup<T> {
  key: string;
  latest: T;
  versions: T[];
}

interface Groupable {
  title: string;
  fileName?: string;
  date: string;
}

const newestFirst = (a: { date: string }, b: { date: string }) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0);

/** Group checks by source file (falling back to title for pasted-text
 * checks, which have no file) — this is check-history grouping, not exact
 * content dedup. Groups sort by most-recent check descending; versions
 * within a group sort newest-first. */
export function groupByFile<T extends Groupable>(entries: T[]): FileGroup<T>[] {
  const byKey = new Map<string, T[]>();
  for (const h of entries) {
    const key = h.fileName?.trim() || h.title;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(h);
  }
  return [...byKey.entries()]
    .map(([key, list]) => {
      const versions = [...list].sort(newestFirst);
      return { key, latest: versions[0], versions };
    })
    .sort((a, b) => newestFirst(a.latest, b.latest));
}
