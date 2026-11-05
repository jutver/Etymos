-- Pop-up announcements: where they show, and what their button does
-- (admin app > Announcements).
--
-- popup_placement
--   home     the signed-in home page (/upload)
--   landing  the signed-out landing page (/)
--   both     either of the two (the default, and what existing rows get)
-- The landing page is only ever seen signed out, so "landing" needs an
-- audience of everyone; any other audience would never see it.
--
-- The button reads "Got it" and closes the pop-up unless an admin sets:
--   button_label / button_label_vi  its text in each language (blank falls
--                                   back to the other language, then "Got it")
--   button_url                      where it takes the visitor: a path on the
--                                   site ("/pricing") or an http(s) address.
--                                   Anything else (javascript:, data:, "//host")
--                                   is refused, so a link can't run script.
-- Only pop-ups use these; other kinds keep them at their defaults.

alter table public.announcements
  add column popup_placement text not null default 'both'
    check (popup_placement in ('home', 'landing', 'both')),
  add column button_label text check (button_label is null or length(button_label) <= 40),
  add column button_label_vi text check (button_label_vi is null or length(button_label_vi) <= 40),
  add column button_url text check (
    button_url is null
    or (length(button_url) <= 2000 and button_url ~ '^(https?://[^\s/]+[^\s]*|/([^/\s][^\s]*)?)$')
  ),
  add constraint announcements_landing_for_everyone
    check (popup_placement <> 'landing' or audience = 'everyone'),
  add constraint announcements_button_popup_only
    check (kind = 'popup' or (button_label is null and button_label_vi is null and button_url is null));

-- Same body as 20261020000000_announcement_audience.sql, recreated so the
-- returned rows carry the new columns.
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
