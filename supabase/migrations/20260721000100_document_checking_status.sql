-- Persistent "checking" job list.
--
-- Before this, a document row only appeared in `documents` once the backend
-- finished analysing and `save_report()` upserted it (see
-- backend/api/report_store.py::_persist_to_supabase). Navigating away from the
-- Analyzing screen therefore lost every trace of an in-flight check.
--
-- The web app now inserts a placeholder row the moment the user presses
-- "Check for plagiarism", and resolves it once the backend job settles.
--
-- `check_state` is a NEW column rather than a new value on `status`, because
-- `status` is the *similarity severity* (clean/low/moderate/high) and is read
-- by the admin portal and by report_store.py. Those callers never write
-- `check_state`, so the 'completed' default keeps every backend-created and
-- pre-existing row behaving exactly as before.
alter table public.documents
  add column check_state text not null default 'completed'
    check (check_state in ('checking', 'completed', 'failed')),
  -- backend/api/job_manager.py job ids look like "job_<uuid4hex>" — text, not uuid.
  add column check_job_id text,
  -- Populated when a job settles as failed/interrupted, shown in the UI.
  add column check_error text;

-- `status` must be nullable for a placeholder row: a still-running check has no
-- similarity severity yet. It already is (plain `check` constraints pass on
-- NULL), asserted here so a future migration doesn't silently break inserts.
alter table public.documents alter column status drop not null;

-- Reconciliation on app mount only ever looks at the caller's unsettled rows.
create index documents_user_check_state_idx
  on public.documents (user_id, check_state)
  where check_state <> 'completed';
