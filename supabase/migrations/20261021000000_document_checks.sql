-- Save & re-check (PLAN.md): a user edits a checked document in the Report
-- editor and re-checks only the paragraphs that changed. Small edits are free
-- within per-tier limits; bigger ones use one check.
--
-- document_checks is the history of real checks run after the original upload.
-- Only the backend (service role) writes it, so the free re-check count and the
-- baseline text are both derived from rows a user can't touch:
--   - free re-checks used = free_recheck rows since the newest paid_recheck
--   - baseline text       = the newest paid_recheck's text, else the oldest
--                           row's previous_text (the upload, before any re-check
--                           replaced the stored passages)
-- document_versions stays user-writable and holds no scores; a version links
-- to its check through document_checks.version_id.

create table public.document_checks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  version_id uuid references public.document_versions(id) on delete set null,
  kind text not null check (kind in ('free_recheck', 'paid_recheck')),
  -- plan | standard | premium; only for paid re-checks.
  balance_source text check (balance_source in ('plan', 'standard', 'premium')),
  -- Added or replaced words vs the baseline, 0..1.
  changed_ratio numeric not null check (changed_ratio >= 0 and changed_ratio <= 1),
  similarity_score numeric not null,
  -- AI-writing score of the re-checked text (0..100), null when AI detection
  -- was unavailable or switched off.
  ai_score numeric,
  -- The scores and text of the report this re-check replaced, so Version
  -- History can show what went up or down.
  previous_score numeric,
  previous_ai_score numeric,
  previous_text text,
  -- The text this check ran on; becomes the baseline when kind = 'paid_recheck'.
  baseline_text text not null,
  -- Matches, passages and scoring, so Version History can restore this check.
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check ((kind = 'paid_recheck') = (balance_source is not null))
);

create index document_checks_document_id_idx
  on public.document_checks (document_id, created_at desc);

alter table public.document_checks enable row level security;

-- Read-only for the owner and admins. No insert/update/delete policies: the
-- backend writes with the service role, which bypasses RLS.
create policy "document_checks_select_self_or_admin"
  on public.document_checks for select
  using (
    public.is_admin(auth.uid())
    or exists (select 1 from public.documents d where d.id = document_id and d.user_id = auth.uid())
  );

-- How much of the text a saved version changed compared with the version
-- before it (added or replaced words / previous words, 0..1), computed by the
-- web app at save time. Display only: pricing never reads it, so it can live
-- on this user-writable table.
alter table public.document_versions
  add column changed_ratio numeric check (changed_ratio is null or (changed_ratio >= 0 and changed_ratio <= 1));

-- Free re-check limits per tier, editable from the admin Pricing screen
-- without a deploy. The tier is the higher of the user's plan and the
-- document's own unlocked_tier.
alter table public.plan_definitions
  add column recheck_free_limit integer not null default 3 check (recheck_free_limit >= 0),
  add column recheck_change_limit numeric not null default 0.30
    check (recheck_change_limit >= 0 and recheck_change_limit <= 1);

update public.plan_definitions set recheck_free_limit = 3, recheck_change_limit = 0.30 where id = 'free';
update public.plan_definitions set recheck_free_limit = 6, recheck_change_limit = 0.50 where id = 'student';
update public.plan_definitions set recheck_free_limit = 10, recheck_change_limit = 0.65 where id = 'professional';

-- Activity log (20261018020000_user_activity_log.sql): one entry per finished
-- re-check, free or paid, on the document owner's timeline.
create or replace function public.log_document_check_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_doc public.documents;
begin
  if public.activity_log_suppressed() then
    return null;
  end if;
  select * into v_doc from public.documents where id = new.document_id;
  if found then
    perform public.log_user_activity(v_doc.user_id, 'document', 'document.rechecked',
      coalesce(v_doc.title, v_doc.file_name), v_doc.id::text,
      jsonb_build_object('kind', new.kind, 'balance_source', new.balance_source,
                         'changed_ratio', new.changed_ratio, 'similarity_score', new.similarity_score,
                         'previous_score', new.previous_score, 'ai_score', new.ai_score));
  end if;
  return null;
end;
$$;

create trigger document_checks_log_activity
  after insert on public.document_checks
  for each row execute function public.log_document_check_activity();
