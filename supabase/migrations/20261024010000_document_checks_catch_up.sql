-- Catch-up for databases that got an earlier draft of
-- 20261021000000_document_checks.sql: document_checks exists there without
-- the score/text columns, so Save & re-check failed to load the check history
-- ("column document_checks.previous_text does not exist") and every
-- re-check quote answered 503. Safe to run on a database that already has
-- the full migration: every statement is idempotent.

alter table public.document_checks
  add column if not exists ai_score numeric,
  add column if not exists previous_score numeric,
  add column if not exists previous_ai_score numeric,
  add column if not exists previous_text text;

alter table public.document_versions
  add column if not exists changed_ratio numeric
    check (changed_ratio is null or (changed_ratio >= 0 and changed_ratio <= 1));

alter table public.plan_definitions
  add column if not exists recheck_free_limit integer not null default 3 check (recheck_free_limit >= 0),
  add column if not exists recheck_change_limit numeric not null default 0.30
    check (recheck_change_limit >= 0 and recheck_change_limit <= 1);

-- Same as in 20261021000000_document_checks.sql; reads the columns above.
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

drop trigger if exists document_checks_log_activity on public.document_checks;
create trigger document_checks_log_activity
  after insert on public.document_checks
  for each row execute function public.log_document_check_activity();

-- PostgREST caches the schema; reload it so the new columns are usable at once.
notify pgrst, 'reload schema';
