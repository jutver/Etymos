-- Who sees a top bar or pop-up (admin app > Announcements):
--   everyone   anyone, signed in or not (the default, and what existing rows get)
--   signed_in  anyone signed in
--   plans      signed-in users on one of audience_plans; a paid plan past its
--              end date counts as free, like everywhere else
--   emails     signed-in users whose email is listed for it
-- Maintenance is always for everyone; its email list means "let through"
-- instead (20261019000000_maintenance_bypass.sql).
--
-- An announcement aimed at some people shouldn't be readable by the rest, so
-- the table is no longer public. The site reads my_announcements(), which
-- returns only the active announcements meant for the caller. Admins keep full
-- access through announcements_write_admin_only.
--
-- maintenance_bypass becomes announcement_emails, one list per announcement
-- for both meanings, and set_maintenance_bypass becomes set_announcement_emails.

alter table public.announcements
  add column audience text not null default 'everyone'
    check (audience in ('everyone', 'signed_in', 'plans', 'emails')),
  add column audience_plans text[]
    check (audience_plans is null or (cardinality(audience_plans) > 0
      and audience_plans <@ array['free', 'student', 'professional'])),
  add constraint announcements_audience_plans_match
    check ((audience = 'plans') = (audience_plans is not null)),
  add constraint announcements_maintenance_for_everyone
    check (kind <> 'maintenance' or audience = 'everyone');

alter table public.maintenance_bypass rename to announcement_emails;
alter policy "maintenance_bypass_admin_only" on public.announcement_emails rename to "announcement_emails_admin_only";

drop function public.set_maintenance_bypass(uuid, text[]);

-- Replaces an announcement's email list in one go. Also bumps the
-- announcement's updated_at, so open pages notice on their next refresh.
create or replace function public.set_announcement_emails(p_announcement uuid, p_emails text[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'admins only' using errcode = '42501';
  end if;

  delete from public.announcement_emails where announcement_id = p_announcement;

  insert into public.announcement_emails (announcement_id, email)
  select distinct p_announcement, lower(btrim(e))
  from unnest(coalesce(p_emails, '{}')) e
  where length(btrim(e)) > 0;

  update public.announcements set updated_at = now() where id = p_announcement;
end
$$;

revoke execute on function public.set_announcement_emails(uuid, text[]) from public, anon;
grant execute on function public.set_announcement_emails(uuid, text[]) to authenticated;

-- Same rule as before, against the renamed table.
create or replace function public.my_maintenance_bypass(p_announcement uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null and (
    public.is_admin(auth.uid())
    or exists (
      select 1
      from public.announcement_emails b
      join public.profiles p on p.id = auth.uid()
      where b.announcement_id = p_announcement
        and b.email = lower(btrim(p.email))
    )
  )
$$;

drop policy "announcements_select_all" on public.announcements;

-- The active announcements meant for the caller, newest first. Signed out,
-- only those for everyone. Scheduling (starts_at, ends_at, countdown) is still
-- applied by the site, which wakes up exactly when one starts or ends.
create or replace function public.my_announcements()
returns setof public.announcements
language sql
stable
security definer
set search_path = public
as $$
  with me as (
    select
      lower(btrim(p.email)) as email,
      case
        when p.plan_tier <> 'free' and p.plan_expires_at is not null and p.plan_expires_at <= now() then 'free'
        else p.plan_tier
      end as plan
    from public.profiles p
    where p.id = auth.uid()
  )
  select a.*
  from public.announcements a
  left join me on true
  where a.is_active
    and (
      a.audience = 'everyone'
      or (a.audience = 'signed_in' and auth.uid() is not null)
      or (a.audience = 'plans' and me.plan = any (a.audience_plans))
      or (a.audience = 'emails' and exists (
        select 1 from public.announcement_emails e
        where e.announcement_id = a.id and e.email = me.email
      ))
    )
  order by a.created_at desc
$$;

grant execute on function public.my_announcements() to anon, authenticated;
