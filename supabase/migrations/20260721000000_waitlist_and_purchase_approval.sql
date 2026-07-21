-- Closed-beta waitlist + admin-approved purchases.
--
-- Two related gates land here:
--   1. `profiles.access_status` — a new signup lands in 'waitlisted' and
--      cannot use the product until an admin flips them to 'approved'
--      (or 'rejected'). The admin queue reads pending rows off this column.
--   2. `checkout_events` review columns — the purchase ledger already only
--      lets a user create a *pending* row (20260715120200), and only admins
--      may flip it (checkout_events_update_admin_only). This adds the
--      who/when/why trail for that decision, mirroring the reviewed_by /
--      reviewed_at pair on student_verification_requests (20260716120000).

-- ---------------------------------------------------------------------------
-- 1. profiles: access gate columns
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column access_status text not null default 'waitlisted'
    check (access_status in ('waitlisted', 'approved', 'rejected')),
  add column access_requested_at timestamptz,
  add column access_reviewed_at timestamptz,
  add column access_reviewed_by uuid references public.profiles(id),
  add column access_note text;

-- BACKFILL — critical. The column default is 'waitlisted' so that *future*
-- signups are gated, but every row that already exists belongs to a live
-- user who was using the product before this gate existed. Locking them out
-- would be a regression, so grandfather all of them in as 'approved'.
update public.profiles set access_status = 'approved';

-- Belt-and-braces: admins must never be gated, no matter what the statement
-- above did or what a future re-run of this migration might see.
update public.profiles set access_status = 'approved' where role = 'admin';

-- The admin queue is "show me everyone waiting", i.e. a filter on this
-- column alone — same shape as student_verification_requests_status_idx.
create index profiles_access_status_idx on public.profiles (access_status);

-- ---------------------------------------------------------------------------
-- 2. handle_new_user: stamp the request time on signup
-- ---------------------------------------------------------------------------
-- Re-declared in full (create-or-replace) rather than editing the historical
-- 20260715120000 file, which has already been applied to the live project.
-- Everything the previous version did is preserved; the only change is the
-- added access_requested_at stamp. access_status is deliberately left to its
-- 'waitlisted' column default — a fresh signup is a waitlist request.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name, access_requested_at)
  values (new.id, new.email, new.raw_user_meta_data ->> 'display_name', now());
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. profiles UPDATE policy + column-level escalation guard
-- ---------------------------------------------------------------------------
-- Two layers, because RLS alone cannot do this job:
--
--   * The POLICY decides *which row* you may write. The original
--     profiles_update_self_or_admin (20260715120000) had a USING clause but
--     no WITH CHECK, so a self-update's *resulting* row was never re-checked
--     — a user could pass USING on their own row and then rewrite `id` to
--     point the row at somebody else. Recreated below with a matching
--     WITH CHECK to close that.
--
--   * The TRIGGER decides *which columns* you may change, because a policy's
--     WITH CHECK cannot see OLD and therefore cannot express "this value must
--     not have changed". prevent_profile_self_privilege_escalation
--     (20260719000000, fixed in 20260719120000, re-pointed at the split
--     credit columns in 20260720000000) is the live enforcement point; it is
--     re-declared below with access_status and its review columns added, so a
--     non-admin cannot approve themselves off the waitlist. Non-privileged
--     self-updates (display_name, email) are untouched and still work.

drop policy if exists "profiles_update_self_or_admin" on public.profiles;

create policy "profiles_update_self_or_admin"
  on public.profiles for update
  using (auth.uid() = id or public.is_admin(auth.uid()))
  with check (auth.uid() = id or public.is_admin(auth.uid()));

-- Carries forward the full guarded column list from 20260720000000 (note
-- `credits` was split into standard_credits/premium_credits there and no
-- longer exists) and adds the access-gate columns. The three exemptions are
-- unchanged and all intentional: raw SQL with no PostgREST JWT context
-- (auth.role() is null), the backend's service-role client, and admins.
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
  then
    raise exception 'Not allowed to modify this field.';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. checkout_events: admin review trail
-- ---------------------------------------------------------------------------

alter table public.checkout_events
  add column reviewed_at timestamptz,
  add column reviewed_by uuid references public.profiles(id),
  add column review_note text;

-- The admin pending-purchases queue filters on status alone.
create index checkout_events_status_idx on public.checkout_events (status);
