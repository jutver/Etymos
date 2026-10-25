-- Every version of a document's check result can be restored (PLAN.md,
-- Phase 8).
--
-- A re-check used to overwrite the upload's result with nothing keeping a
-- copy, so the original could never be restored. The backend now stores the
-- report a document had before its first re-check as a document_checks row of
-- kind 'upload' (the re-check refuses to run if that fails), so every result
-- the document ever had is a document_checks row.
--
-- documents.current_check_id is the row whose result is the current report,
-- so after restoring an older version the next re-check compares against that
-- version rather than the newest re-check. Set by the backend only, in the
-- same update that writes the restored score.
--
-- Apply before deploying the backend that writes 'upload' rows.

alter table public.document_checks
  drop constraint if exists document_checks_kind_check;
alter table public.document_checks
  add constraint document_checks_kind_check
    check (kind in ('upload', 'free_recheck', 'paid_recheck'));

alter table public.documents
  add column if not exists current_check_id uuid
    references public.document_checks(id) on delete set null;

-- Storing the upload's result is not a re-check: keep it out of the
-- activity log.
drop trigger if exists document_checks_log_activity on public.document_checks;
create trigger document_checks_log_activity
  after insert on public.document_checks
  for each row
  when (new.kind <> 'upload')
  execute function public.log_document_check_activity();

-- PostgREST caches the schema; reload it so the new column is usable at once.
notify pgrst, 'reload schema';
