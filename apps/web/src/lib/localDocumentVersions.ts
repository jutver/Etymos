// Fallback store for the Report page's Version History when Supabase refuses
// the insert (document_versions migration not applied, a local-only
// `check-<ts>` document id that isn't a uuid, RLS, offline...). Snapshots
// are kept in this browser's localStorage, per document, so pressing Save
// still keeps the edited text (e.g. an accepted rewrite) across reloads.
// Every storage access is wrapped: private windows / blocked storage just
// behave as "nothing saved locally".
import type { DocumentVersion } from "../screens/Report/VersionHistoryMenu";

const KEY_PREFIX = "etymos.documentVersions.";
const MAX_VERSIONS = 20;

interface StoredVersion {
  id: string;
  label: string;
  html: string;
  wordCount: number;
  createdAt: string;
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

function toVersion(v: StoredVersion): DocumentVersion {
  return {
    id: v.id,
    label: v.label,
    savedAt: new Date(v.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    wordCount: v.wordCount,
    html: v.html,
  };
}

/** Versions saved on this device for `documentId`, newest first. */
export function loadLocalDocumentVersions(documentId: string): DocumentVersion[] {
  return readStored(documentId).map(toVersion);
}

/** Saves a snapshot locally; returns it, or null when storage is unavailable. */
export function saveLocalDocumentVersion(
  documentId: string,
  version: { label: string; html: string; wordCount: number },
): DocumentVersion | null {
  const stored: StoredVersion = {
    id: `local-${Date.now()}`,
    label: version.label,
    html: version.html,
    wordCount: version.wordCount,
    createdAt: new Date().toISOString(),
  };
  try {
    const next = [stored, ...readStored(documentId)].slice(0, MAX_VERSIONS);
    window.localStorage.setItem(KEY_PREFIX + documentId, JSON.stringify(next));
    return toVersion(stored);
  } catch {
    return null;
  }
}
