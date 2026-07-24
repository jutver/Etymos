-- Adds the columns three CHANGES_I_WANT.md admin-portal features build on:
--   - presence ("is this user online right now")
--   - ban (period or permanent, with a message shown to the banned user)
--   - deletion requests (admin asks, user confirms — vs. admin force-delete,
--     which skips this table entirely and goes straight to DELETE
--     /api/admin/users/{id})
--
-- All three are plain profiles columns, not new tables: they're per-user
-- state, not events, and every existing admin screen already fetches one
-- profiles row per user (getProfile/listProfiles in supabaseQueries.ts), so
-- this needs no new query plumbing beyond selecting the extra columns.

alter table public.profiles
  add column last_seen_at timestamptz,
  add column banned_permanent boolean not null default false,
  add column banned_until timestamptz,
  add column ban_reason text,
  add column banned_by uuid references public.profiles(id) on delete set null,
  add column deletion_requested_at timestamptz,
  add column deletion_requested_by uuid references public.profiles(id) on delete set null;

-- Deleting a profile (cascaded from auth.users, see delete_account /
-- the new admin force-delete endpoint) must never be blocked by a plain
-- FK from some *other* row that merely references this user as an actor
-- (admin who reviewed a verification request, admin who posted an
-- announcement, etc.) — none of those existing FKs specified an ON DELETE
-- action, which defaults to NO ACTION and would raise a foreign-key
-- violation the moment an admin account (or any user who ever acted as
-- one) got deleted. Repoint them at SET NULL: the historical row survives,
-- just with its actor reference cleared.
alter table public.audit_log drop constraint audit_log_actor_id_fkey;
alter table public.audit_log add constraint audit_log_actor_id_fkey
  foreign key (actor_id) references public.profiles(id) on delete set null;

alter table public.audit_log drop constraint audit_log_target_user_id_fkey;
alter table public.audit_log add constraint audit_log_target_user_id_fkey
  foreign key (target_user_id) references public.profiles(id) on delete set null;

alter table public.student_verification_requests drop constraint student_verification_requests_reviewed_by_fkey;
alter table public.student_verification_requests add constraint student_verification_requests_reviewed_by_fkey
  foreign key (reviewed_by) references public.profiles(id) on delete set null;

alter table public.feature_flags drop constraint feature_flags_updated_by_fkey;
alter table public.feature_flags add constraint feature_flags_updated_by_fkey
  foreign key (updated_by) references public.profiles(id) on delete set null;

alter table public.announcements drop constraint announcements_created_by_fkey;
alter table public.announcements add constraint announcements_created_by_fkey
  foreign key (created_by) references public.profiles(id) on delete set null;

alter table public.documents drop constraint documents_flagged_by_fkey;
alter table public.documents add constraint documents_flagged_by_fkey
  foreign key (flagged_by) references public.profiles(id) on delete set null;

-- Extend 20260721000000's self-escalation guard (the latest applied
-- version — carries the access_status/waitlist columns forward, note
-- `credits` was already split into standard_credits/premium_credits there)
-- to also cover the new privileged columns: a banned or deletion-flagged
-- user must not be able to clear their own ban/deletion state by re-running
-- the same self-update the client already performs elsewhere (e.g.
-- AccountProfile saving display_name). last_seen_at is deliberately NOT
-- guarded — every user's own presence heartbeat writes it to their own row,
-- and it grants no privilege.
create or replace function public.prevent_profile_self_privilege_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is null or auth.role() = 'service_role' or public.is_admin(auth.uid()) then
    return new;
  end if;

  if new.role is distinct from old.role
     or new.plan_tier is distinct from old.plan_tier
     or new.billing_cycle is distinct from old.billing_cycle
     or new.standard_credits is distinct from old.standard_credits
     or new.premium_credits is distinct from old.premium_credits
     or new.checks_used_this_period is distinct from old.checks_used_this_period
     or new.plan_period_start is distinct from old.plan_period_start
     or new.student_verified is distinct from old.student_verified
     or new.access_status is distinct from old.access_status
     or new.access_reviewed_at is distinct from old.access_reviewed_at
     or new.access_reviewed_by is distinct from old.access_reviewed_by
     or new.access_note is distinct from old.access_note
     or new.banned_permanent is distinct from old.banned_permanent
     or new.banned_until is distinct from old.banned_until
     or new.ban_reason is distinct from old.ban_reason
     or new.banned_by is distinct from old.banned_by
     or new.deletion_requested_at is distinct from old.deletion_requested_at
     or new.deletion_requested_by is distinct from old.deletion_requested_by
  then
    raise exception 'Not allowed to modify this field.';
  end if;

  return new;
end;
$$;

create index profiles_last_seen_at_idx on public.profiles (last_seen_at);
