-- Personal messages: a pop-up an admin sends to one account from that user's
-- page (admin app > Users > a user > Messages). They live in the
-- announcements table, so the site shows them like any other pop-up:
--   personal = true, kind = 'popup', audience = 'emails', the recipient's
--   email as the only entry in announcement_emails.
-- The admin app keeps them in their own tab (Announcements > Personal
-- messages), apart from the global list.
--
-- announcement_views records when the recipient closed one, so the admin
-- sees "Seen" instead of guessing. A seen personal message isn't returned by
-- my_announcements() again, so it shows once per account, not once per
-- browser.
--
-- Activity log (support category): "support.personal_message_sent" when its recipient is set,
-- "support.personal_message_seen" when the recipient closes it.

alter table public.announcements
  add column personal boolean not null default false,
  add constraint announcements_personal_is_popup
    check (not personal or (kind = 'popup' and audience = 'emails'));

create index announcements_personal_idx on public.announcements (personal, created_at desc);

create table public.announcement_views (
  announcement_id uuid not null references public.announcements(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade default auth.uid(),
  seen_at timestamptz not null default now(),
  primary key (announcement_id, user_id)
);

create index announcement_views_user_idx on public.announcement_views (user_id);

alter table public.announcement_views enable row level security;

-- A signed-in user records their own view, and only of an announcement
-- aimed at them (my_announcements() decides what that is).
create policy "announcement_views_insert_self"
  on public.announcement_views for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.my_announcements() a where a.id = announcement_id)
  );

create policy "announcement_views_select_admin_only"
  on public.announcement_views for select
  to authenticated
  using (public.is_admin(auth.uid()));

create policy "announcement_views_delete_admin_only"
  on public.announcement_views for delete
  to authenticated
  using (public.is_admin(auth.uid()));

-- Same as 20261106000000_popup_placement_and_button.sql, plus: a personal
-- message its recipient has already seen is left out.
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
    and not (a.personal and exists (
      select 1 from public.announcement_views v
      where v.announcement_id = a.id and v.user_id = auth.uid()
    ))
  order by a.created_at desc
$$;

grant execute on function public.my_announcements() to anon, authenticated;

-- Activity log entries.
create or replace function public.log_personal_message_sent()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_title text;
  v_user uuid;
begin
  if public.activity_log_suppressed() then
    return new;
  end if;
  select coalesce(nullif(btrim(a.title_vi), ''), nullif(btrim(a.title), ''), left(coalesce(nullif(btrim(a.message_vi), ''), a.message), 80))
    into v_title
    from public.announcements a
    where a.id = new.announcement_id and a.personal;
  if not found then
    return new;
  end if;
  select p.id into v_user from public.profiles p where lower(btrim(p.email)) = new.email limit 1;
  -- set_announcement_emails rewrites the list on every edit; log the send once.
  if exists (
    select 1 from public.user_activity_log l
    where l.user_id = v_user and l.action = 'support.personal_message_sent' and l.ref_id = new.announcement_id::text
  ) then
    return new;
  end if;
  perform public.log_user_activity(v_user, 'support', 'support.personal_message_sent', v_title, new.announcement_id::text);
  return new;
end;
$$;

create trigger announcement_emails_log_personal
  after insert on public.announcement_emails
  for each row execute function public.log_personal_message_sent();

create or replace function public.log_personal_message_seen()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_title text;
begin
  if public.activity_log_suppressed() then
    return new;
  end if;
  select coalesce(nullif(btrim(a.title_vi), ''), nullif(btrim(a.title), ''), left(coalesce(nullif(btrim(a.message_vi), ''), a.message), 80))
    into v_title
    from public.announcements a
    where a.id = new.announcement_id and a.personal;
  if not found then
    return new;
  end if;
  perform public.log_user_activity(new.user_id, 'support', 'support.personal_message_seen', v_title, new.announcement_id::text);
  return new;
end;
$$;

create trigger announcement_views_log_personal
  after insert on public.announcement_views
  for each row execute function public.log_personal_message_seen();
