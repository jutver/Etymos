-- Security hardening (Nov 2026 audit).
--
-- 1. profiles: email, created_at and access_requested_at were missing from
--    the self-update guard, so a signed-in user could rewrite them through
--    the Supabase API. Those columns decide targeted discounts (allowed
--    emails, signup window), email-based support bans, which addresses may
--    reply to a ticket by email, and the waitlist order. Users never write
--    them directly: email and display name reach profiles from auth.users
--    (GoTrue, no JWT, exempt below) and the web app only stamps last_seen_at.
--    Full column list carried forward from 20261005000000_plan_expiry.sql.
--
-- 2. redeem_discount_code(text): left over from before the backend priced
--    orders itself (payments.py), and never revoked, so any signed-in user
--    could call it to spend a limited code's redemptions or probe which codes
--    exist. Nothing calls it any more; only the backend (service_role) keeps
--    access.

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
     or new.email is distinct from old.email
     or new.created_at is distinct from old.created_at
     or new.plan_tier is distinct from old.plan_tier
     or new.billing_cycle is distinct from old.billing_cycle
     or new.plan_expires_at is distinct from old.plan_expires_at
     or new.standard_credits is distinct from old.standard_credits
     or new.premium_credits is distinct from old.premium_credits
     or new.checks_used_this_period is distinct from old.checks_used_this_period
     or new.plan_period_start is distinct from old.plan_period_start
     or new.student_verified is distinct from old.student_verified
     or new.access_status is distinct from old.access_status
     or new.access_requested_at is distinct from old.access_requested_at
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

revoke all on function public.redeem_discount_code(text) from public, anon, authenticated;
grant execute on function public.redeem_discount_code(text) to service_role;

-- 3. recovery_emails: a 24-hour count of reset codes sent to the address.
--    Each code allows 5 guesses; recovery_email.py now stops at 5 codes a
--    day, so rotating IPs can't turn re-sending into unlimited guessing.
--    Apply before deploying the backend that writes these columns.
alter table public.recovery_emails
  add column if not exists reset_codes_sent integer not null default 0,
  add column if not exists reset_codes_since timestamptz;
