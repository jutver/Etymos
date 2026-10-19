-- Let chosen people through maintenance mode, not only admins.
--
-- An admin lists emails on a maintenance announcement (admin app >
-- Announcements); people signed in with one of those emails use the site as
-- normal while everyone else sees the maintenance page. Emails rather than
-- user ids, so an account can be added before it exists.
--
-- announcements is readable by everyone, so the list lives in its own
-- admin-only table. The site asks my_maintenance_bypass() whether the caller
-- is on the list, and never sees the list itself.

create table public.maintenance_bypass (
  announcement_id uuid not null references public.announcements (id) on delete cascade,
  email text not null check (email = lower(btrim(email)) and length(email) > 0),
  created_at timestamptz not null default now(),
  primary key (announcement_id, email)
);

alter table public.maintenance_bypass enable row level security;

create policy "maintenance_bypass_admin_only"
  on public.maintenance_bypass for all to authenticated
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

grant select, insert, update, delete on public.maintenance_bypass to authenticated;

-- Whether the caller may use the site during this maintenance announcement:
-- an admin, or signed in with an email on its list.
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
      from public.maintenance_bypass b
      join public.profiles p on p.id = auth.uid()
      where b.announcement_id = p_announcement
        and b.email = lower(btrim(p.email))
    )
  )
$$;

revoke execute on function public.my_maintenance_bypass(uuid) from public, anon;
grant execute on function public.my_maintenance_bypass(uuid) to authenticated;

-- Replaces an announcement's list in one go. Also bumps the announcement's
-- updated_at, so open pages notice on their next refresh and check again.
create or replace function public.set_maintenance_bypass(p_announcement uuid, p_emails text[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'admins only' using errcode = '42501';
  end if;

  delete from public.maintenance_bypass where announcement_id = p_announcement;

  insert into public.maintenance_bypass (announcement_id, email)
  select distinct p_announcement, lower(btrim(e))
  from unnest(coalesce(p_emails, '{}')) e
  where length(btrim(e)) > 0;

  update public.announcements set updated_at = now() where id = p_announcement;
end
$$;

revoke execute on function public.set_maintenance_bypass(uuid, text[]) from public, anon;
grant execute on function public.set_maintenance_bypass(uuid, text[]) to authenticated;
