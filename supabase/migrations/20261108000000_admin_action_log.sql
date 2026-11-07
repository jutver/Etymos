-- Admin action log: one row for everything an admin does, shown in the admin
-- portal under Logs > Admin actions.
--
-- Written two ways, so nothing depends on the admin app remembering to log:
--   - database (source 'portal'): AFTER triggers on every table an admin can
--     change from the portal, directly or through an admin_* function. A row
--     is logged when the change was made by a signed-in admin (auth.uid() is
--     an admin with an authenticator code), with the changed columns as
--     {column: {from, to}}. Admin sign-ins are logged from auth.users.
--   - backend (source 'backend'): the Python API logs what it does for an
--     admin with the service role (support replies, force-deleting a user,
--     server actions, reading another user's report) through
--     log_admin_action(), passing the admin's id.
--
-- The existing audit_log rows (a few actions the admin app wrote by hand)
-- are copied in once, so the history starts from the beginning.
--
-- Nobody can edit or delete entries: there are no write policies or grants,
-- and target_user_id has no foreign key, so a deleted account's history stays.
-- Logging never blocks the change it describes: errors are swallowed.

-- ---------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------

create table public.admin_action_log (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  -- The admin. No foreign key: the entry outlives the admin's account.
  actor_id uuid,
  actor_email text,
  source text not null check (source in ('portal', 'backend')),
  -- <table>.<insert|update|delete> for portal changes, e.g. profiles.update;
  -- <area>.<verb> for backend actions, e.g. support.reply, server.restart_api.
  action text not null,
  target_table text,
  target_id text,
  -- The account the action was about, when there is one.
  target_user_id uuid,
  -- What it was about, as shown in the log: an email, a title, a code...
  summary text,
  -- {column: {from, to}} for updates; {column: {to}} / {column: {from}} for
  -- inserts and deletes (long values cut to 300 characters).
  changes jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb
);

create index admin_action_log_created_idx on public.admin_action_log (created_at desc, id desc);
create index admin_action_log_actor_idx on public.admin_action_log (actor_id, created_at desc);
create index admin_action_log_target_user_idx on public.admin_action_log (target_user_id, created_at desc);
create index admin_action_log_table_idx on public.admin_action_log (target_table, created_at desc);

alter table public.admin_action_log enable row level security;

create policy "admin_action_log_select_admin_only"
  on public.admin_action_log for select
  to authenticated
  using (public.is_admin(auth.uid()));

revoke insert, update, delete, truncate on public.admin_action_log from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Writer (also called by the backend, with the service role)
-- ---------------------------------------------------------------------------

create or replace function public.log_admin_action(
  p_actor_id uuid,
  p_source text,
  p_action text,
  p_target_table text default null,
  p_target_id text default null,
  p_target_user_id uuid default null,
  p_summary text default null,
  p_changes jsonb default '{}'::jsonb,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.admin_action_log
    (actor_id, actor_email, source, action, target_table, target_id, target_user_id, summary, changes, metadata)
  values (
    p_actor_id,
    (select email from public.profiles where id = p_actor_id),
    p_source, p_action, p_target_table, p_target_id, p_target_user_id,
    left(p_summary, 300),
    coalesce(p_changes, '{}'::jsonb),
    coalesce(p_metadata, '{}'::jsonb)
  );
exception when others then
  raise warning 'admin_action_log: could not record %: %', p_action, sqlerrm;
end;
$$;

revoke all on function public.log_admin_action(uuid, text, text, text, text, uuid, text, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.log_admin_action(uuid, text, text, text, text, uuid, text, jsonb, jsonb)
  to service_role;

-- A value as stored in the log: long text cut to 300 characters, big
-- objects/arrays replaced by a note of their size.
create or replace function public.admin_log_value(p_value jsonb)
returns jsonb
language sql
immutable
as $$
  select case
    when p_value is null then 'null'::jsonb
    when jsonb_typeof(p_value) = 'string' and length(p_value #>> '{}') > 300
      then to_jsonb(left(p_value #>> '{}', 300) || '…')
    when jsonb_typeof(p_value) in ('object', 'array') and length(p_value::text) > 600
      then to_jsonb('(' || length(p_value::text) || ' characters of ' || jsonb_typeof(p_value) || ')')
    else p_value
  end
$$;

-- ---------------------------------------------------------------------------
-- 3. Trigger for portal changes
-- ---------------------------------------------------------------------------

-- Columns that change on every write and say nothing about what the admin did.
create or replace function public.admin_log_ignored_column(p_column text)
returns boolean
language sql
immutable
as $$
  select p_column in ('updated_at', 'search_vector', 'last_seen_at')
$$;

create or replace function public.log_admin_row_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_old jsonb;
  v_new jsonb;
  v_row jsonb;
  v_changes jsonb := '{}'::jsonb;
  v_key text;
  v_target_user uuid;
  v_target_id text;
  v_summary text;
begin
  if v_actor is null or not public.is_admin(v_actor) then
    return null;
  end if;

  v_old := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_new := case when tg_op in ('UPDATE', 'INSERT') then to_jsonb(new) end;
  v_row := coalesce(v_new, v_old);

  if tg_op = 'UPDATE' then
    for v_key in select jsonb_object_keys(v_new) loop
      if not public.admin_log_ignored_column(v_key) and (v_new -> v_key) is distinct from (v_old -> v_key) then
        v_changes := v_changes || jsonb_build_object(v_key, jsonb_build_object(
          'from', public.admin_log_value(v_old -> v_key), 'to', public.admin_log_value(v_new -> v_key)));
      end if;
    end loop;
    if v_changes = '{}'::jsonb then
      return null;  -- only bookkeeping columns changed
    end if;
  else
    for v_key in select jsonb_object_keys(v_row) loop
      if not public.admin_log_ignored_column(v_key) and (v_row -> v_key) <> 'null'::jsonb then
        v_changes := v_changes || jsonb_build_object(v_key, jsonb_build_object(
          case when tg_op = 'INSERT' then 'to' else 'from' end, public.admin_log_value(v_row -> v_key)));
      end if;
    end loop;
  end if;

  -- Which account it was about.
  begin
    v_target_user := case
      when tg_table_name = 'profiles' then (v_row ->> 'id')::uuid
      else coalesce((v_row ->> 'user_id')::uuid, (v_row ->> 'target_user_id')::uuid)
    end;
  exception when others then
    v_target_user := null;
  end;
  if v_target_user is null and v_row ? 'email' then
    select id into v_target_user from public.profiles where lower(email) = lower(v_row ->> 'email') limit 1;
  end if;

  -- The admin's own documents and checks are their own use of the product,
  -- already in their user activity log, not an admin action.
  if v_target_user = v_actor and tg_table_name <> 'profiles' then
    return null;
  end if;

  v_target_id := coalesce(v_row ->> 'id', v_row ->> 'key', v_row ->> 'code',
                          nullif(concat_ws('/', v_row ->> 'announcement_id', v_row ->> 'user_id', v_row ->> 'email'), ''));
  v_summary := coalesce(v_row ->> 'email', v_row ->> 'title', v_row ->> 'subject', v_row ->> 'name',
                        v_row ->> 'code', v_row ->> 'key', v_row ->> 'file_name', v_row ->> 'payment_code',
                        v_row ->> 'label');
  if v_summary is null and v_target_user is not null then
    select email into v_summary from public.profiles where id = v_target_user;
  end if;

  perform public.log_admin_action(
    v_actor, 'portal', tg_table_name || '.' || lower(tg_op), tg_table_name, v_target_id, v_target_user,
    v_summary, v_changes, '{}'::jsonb);
  return null;
exception when others then
  raise warning 'admin_action_log: trigger on % failed: %', tg_table_name, sqlerrm;
  return null;
end;
$$;

revoke all on function public.log_admin_row_change() from public, anon, authenticated;

-- Every table an admin can change from the portal. support_messages only on
-- insert/update: deleting a ticket removes its messages too, and the ticket's
-- own entry already says so.
do $$
declare
  v_table text;
  v_events text;
begin
  foreach v_table in array array[
    'profiles', 'documents', 'document_versions',
    'announcements', 'announcement_emails', 'announcement_views',
    'plan_definitions', 'plan_discounts', 'discount_codes', 'credit_packs',
    'feature_flags', 'maintenance_bypass',
    'student_verification_requests',
    'checkout_events', 'payment_transactions',
    'support_tickets', 'support_messages',
    'referral_survey_responses'
  ] loop
    if to_regclass('public.' || v_table) is null then
      continue;
    end if;
    v_events := case when v_table = 'support_messages' then 'insert or update' else 'insert or update or delete' end;
    execute format(
      'create trigger admin_action_log after %s on public.%I for each row execute function public.log_admin_row_change()',
      v_events, v_table);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Admin sign-ins
-- ---------------------------------------------------------------------------

create or replace function public.log_admin_sign_in()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.last_sign_in_at is distinct from old.last_sign_in_at and new.last_sign_in_at is not null
     and exists (select 1 from public.profiles where id = new.id and role = 'admin') then
    perform public.log_admin_action(new.id, 'portal', 'auth.sign_in', 'auth.users', new.id::text, new.id,
      new.email, '{}'::jsonb, jsonb_build_object('provider', new.raw_app_meta_data ->> 'provider'));
  end if;
  return null;
exception when others then
  return null;
end;
$$;

revoke all on function public.log_admin_sign_in() from public, anon, authenticated;

do $$
begin
  if (select count(*) from information_schema.columns
      where table_schema = 'auth' and table_name = 'users'
        and column_name in ('last_sign_in_at', 'raw_app_meta_data')) = 2 then
    create trigger on_admin_sign_in
      after update on auth.users
      for each row execute function public.log_admin_sign_in();
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. History so far: what the admin app wrote to audit_log by hand
-- ---------------------------------------------------------------------------

insert into public.admin_action_log
  (created_at, actor_id, actor_email, source, action, target_table, target_id, target_user_id, summary, metadata)
select a.created_at, a.actor_id, actor.email, 'portal', 'audit.' || a.action, 'profiles',
       a.target_user_id::text, a.target_user_id, target.email,
       coalesce(a.metadata, '{}'::jsonb) || jsonb_build_object('from_audit_log', true)
from public.audit_log a
left join public.profiles actor on actor.id = a.actor_id
left join public.profiles target on target.id = a.target_user_id
order by a.created_at;
