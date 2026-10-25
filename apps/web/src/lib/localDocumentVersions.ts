// Fallback store for the Report page's Version History when Supabase refuses
// the insert (document_versions migration not applied, a local-only
// `check-<ts>` document id that isn't a uuid, RLS, offline...). Snapshots
// are kept in this browser's localStorage, per document, so pressing Save
// still keeps the edited text (e.g. an accepted rewrite) across reloads, and
// are moved to the database on the next load that can save them
// (uploadLocalDocumentVersions).
// Every storage access is wrapped: private windows / blocked storage just
// behave as "nothing saved locally".
import type { DocumentVersion } from "../screens/Report/VersionHistoryMenu";
import { saveDocumentVersion } from "./documentsQueries";

const KEY_PREFIX = "etymos.documentVersions.";

interface StoredVersion {
  id: string;
  label: string;
  html: string;
  wordCount: number;
  createdAt: string;
  changedRatio?: number;
}

function readStored(documentId: string): StoredVersion[] {
  try {
    const raw = window.localStorage.getItem(KEY_PREFIX + documentId);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStored(documentId: string, versions: StoredVersion[]) {
  if (versions.length === 0) window.localStorage.removeItem(KEY_PREFIX + documentId);
  else window.localStorage.setItem(KEY_PREFIX + documentId, JSON.stringify(versions));
}

function toVersion(v: StoredVersion): DocumentVersion {
  return {
    id: v.id,
    label: v.label,
    savedAt: new Date(v.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    wordCount: v.wordCount,
    html: v.html,
    changedRatio: v.changedRatio ?? null,
  };
}

/** Versions saved on this device for `documentId`, newest first. */
export function loadLocalDocumentVersions(documentId: string): DocumentVersion[] {
  return readStored(documentId).map(toVersion);
}

/** Saves a snapshot locally; returns it, or null when storage is unavailable. */
export function saveLocalDocumentVersion(
  documentId: string,
  version: { label: string; html: string; wordCount: number; changedRatio?: number },
): DocumentVersion | null {
  const stored: StoredVersion = {
    // Unique even for two saves in the same millisecond: uploading one
    // removes it by id.
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    label: version.label,
    html: version.html,
    wordCount: version.wordCount,
    changedRatio: version.changedRatio,
    createdAt: new Date().toISOString(),
  };
  try {
    // No cap: each one is a version the database doesn't have yet.
    writeStored(documentId, [stored, ...readStored(documentId)]);
    return toVersion(stored);
  } catch {
    return null;
  }
}

/**
 * Saves the versions kept on this device to the database, oldest first and
 * with their original save time, removing each one locally once it is
 * stored. Stops at the first refusal: the rest stay here for the next try.
 */
export function uploadLocalDocumentVersions(documentId: string): Promise<void> {
  // One upload per document at a time, or a version could be inserted twice.
  let running = uploads.get(documentId);
  if (!running) {
    running = uploadAll(documentId).finally(() => uploads.delete(documentId));
    uploads.set(documentId, running);
  }
  return running;
}

const uploads = new Map<string, Promise<void>>();

async function uploadAll(documentId: string): Promise<void> {
  for (const version of readStored(documentId).reverse()) {
    try {
      await saveDocumentVersion(documentId, {
        label: version.label,
        html: version.html,
        wordCount: version.wordCount,
        changedRatio: version.changedRatio,
        createdAt: version.createdAt,
      });
    } catch {
      return;
    }
    try {
      writeStored(documentId, readStored(documentId).filter((v) => v.id !== version.id));
    } catch {
      return;
    }
  }
}
