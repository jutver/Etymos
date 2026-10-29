-- Support ban: stops one account from opening or writing on support tickets
-- (web form, guest links, email) without touching anything else it can do.
-- Same shape as the account ban in 20260724000000_ban_delete_presence.sql —
-- permanent or until a time, with a message shown to the user — set by
-- admins straight on profiles from the admin app; backend/api/support.py
-- enforces it.

alter table public.profiles
  add column support_banned_permanent boolean not null default false,
  add column support_banned_until timestamptz,
  add column support_ban_reason text,
  add column support_banned_by uuid references public.profiles(id) on delete set null;

-- A user must not lift their own support ban. A separate trigger rather than
-- another copy of prevent_profile_self_privilege_escalation (latest in
-- 20261005000000_plan_expiry.sql); same bypass rule.
create or replace function public.prevent_profile_support_ban_self_edit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is null or auth.role() = 'service_role' or public.is_admin(auth.uid()) then
    return new;
  end if;

  if new.support_banned_permanent is distinct from old.support_banned_permanent
     or new.support_banned_until is distinct from old.support_banned_until
     or new.support_ban_reason is distinct from old.support_ban_reason
     or new.support_banned_by is distinct from old.support_banned_by
  then
    raise exception 'Not allowed to modify this field.';
  end if;

  return new;
end;
$$;

create trigger profiles_prevent_support_ban_self_edit
  before update on public.profiles
  for each row execute function public.prevent_profile_support_ban_self_edit();

-- Activity log, worded like account.banned / account.unbanned in
-- log_profile_activity (20261018020000_user_activity_log.sql).
create or replace function public.log_profile_support_ban_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.activity_log_suppressed() then
    return null;
  end if;

  if new.support_banned_permanent is distinct from old.support_banned_permanent
     or new.support_banned_until is distinct from old.support_banned_until
     or new.support_ban_reason is distinct from old.support_ban_reason then
    if new.support_banned_permanent or new.support_banned_until is not null then
      perform public.log_user_activity(new.id, 'support', 'support.banned', null, null,
        jsonb_build_object('permanent', new.support_banned_permanent, 'until', new.support_banned_until,
                           'reason', new.support_ban_reason));
    else
      perform public.log_user_activity(new.id, 'support', 'support.unbanned');
    end if;
  end if;

  return null;
end;
$$;

create trigger profiles_log_support_ban_activity
  after update on public.profiles
  for each row execute function public.log_profile_support_ban_activity();

-- Emails from a support-banned sender are logged and dropped.
alter table public.support_inbound_log drop constraint support_inbound_log_outcome_check;
alter table public.support_inbound_log add constraint support_inbound_log_outcome_check
  check (outcome in ('processing', 'appended', 'ticket_created', 'ignored_auto', 'ignored_own', 'ignored_banned', 'failed'));
