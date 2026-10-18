import { supabase } from "@etymos/shared";
import { t } from "./i18n";

/** What an admin chose to delete: picked rows, every row with one status, or all. */
export type DeleteScope = { kind: "ids"; ids: string[] } | { kind: "status"; status: string } | { kind: "all" };

export interface DeleteResult {
  deleted: number;
  /** Files whose record is gone but which Storage didn't remove. */
  filesLeft: number;
}

/** Arguments for the admin_delete_* database functions. */
export function deleteScopeArgs(scope: DeleteScope): Record<string, unknown> {
  if (scope.kind === "ids") return { p_ids: scope.ids };
  if (scope.kind === "status") return { p_status: scope.status };
  return { p_all: true };
}

/** Deletes rows through an admin_delete_* function, which returns the
 * Storage paths of their files, then removes those files. A file that
 * can't be removed is counted rather than failing the delete: its record
 * is already gone. */
export async function deleteRecordsWithFiles(
  fn: string,
  bucket: string,
  scope: DeleteScope,
): Promise<DeleteResult> {
  const { data, error } = await supabase.rpc(fn, deleteScopeArgs(scope));
  if (error) throw error;
  const { deleted, paths } = data as { deleted: number; paths: string[] };
  let filesLeft = 0;
  // Storage takes a limited number of paths per request. It skips paths
  // that are already gone, so only a failed request leaves files behind.
  for (let i = 0; i < paths.length; i += 100) {
    const chunk = paths.slice(i, i + 100);
    const { error: removeError } = await supabase.storage.from(bucket).remove(chunk);
    if (removeError) filesLeft += chunk.length;
  }
  return { deleted, filesLeft };
}

/** "Deleted 3." — plus how many files are left behind, if any. */
export function deleteResultMessage({ deleted, filesLeft }: DeleteResult): string {
  return filesLeft > 0
    ? t("Deleted {{count}}. {{files}} file(s) couldn't be removed from storage.", { count: deleted, files: filesLeft })
    : t("Deleted {{count}}.", { count: deleted });
}
