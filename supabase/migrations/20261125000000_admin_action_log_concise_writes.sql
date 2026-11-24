-- Concise admin action logging at write time:
--   1. Make public.set_announcement_emails diff against existing rows so saving
--      an announcement whose recipient/bypass list didn't change writes 0
--      announcement_emails delete/insert audit rows instead of 2N false entries.
--   2. Give announcements a summary fallback (title -> title_vi -> message ->
--      message_vi) in public.log_admin_row_change so top bars and Vietnamese-only
--      announcements carry a readable name in the admin action log.

create or replace function public.set_announcement_emails(p_announcement uuid, p_emails text[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_desired text[];
  v_deleted integer := 0;
  v_inserted integer := 0;
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'admins only' using errcode = '42501';
  end if;

  select coalesce(array_agg(distinct normalized), '{}'::text[])
  into v_desired
  from (
    select lower(btrim(e)) as normalized
    from unnest(coalesce(p_emails, '{}'::text[])) as e
    where length(btrim(e)) > 0
  ) as clean;

  delete from public.announcement_emails
  where announcement_id = p_announcement
    and not (lower(btrim(email)) = any(v_desired));
  get diagnostics v_deleted = row_count;

  insert into public.announcement_emails (announcement_id, email)
  select p_announcement, e
  from unnest(v_desired) as e
  where not exists (
    select 1
    from public.announcement_emails ae
    where ae.announcement_id = p_announcement
      and lower(btrim(ae.email)) = e
  )
  on conflict do nothing;
  get diagnostics v_inserted = row_count;

  if v_deleted > 0 or v_inserted > 0 then
    update public.announcements set updated_at = now() where id = p_announcement;
  end if;
end
$$;

revoke execute on function public.set_announcement_emails(uuid, text[]) from public, anon;
grant execute on function public.set_announcement_emails(uuid, text[]) to authenticated;

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
  if tg_table_name = 'announcements' then
    v_summary := coalesce(
      nullif(btrim(v_row ->> 'title'), ''),
      nullif(btrim(v_row ->> 'title_vi'), ''),
      left(nullif(btrim(v_row ->> 'message'), ''), 120),
      left(nullif(btrim(v_row ->> 'message_vi'), ''), 120)
    );
  else
    v_summary := coalesce(v_row ->> 'email', v_row ->> 'title', v_row ->> 'subject', v_row ->> 'name',
                          v_row ->> 'code', v_row ->> 'key', v_row ->> 'file_name', v_row ->> 'payment_code',
                          v_row ->> 'label');
  end if;
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
