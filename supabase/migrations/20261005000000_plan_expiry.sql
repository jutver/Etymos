-- Subscriptions that actually end.
--
-- Until now a paid plan never expired: one payment set plan_tier and it
-- stayed forever. Payments are bank transfers (SePay), which the customer
-- pushes — we can't pull money for an automatic renewal — so a subscription
-- is a prepaid term:
--
--   * Buying a plan starts a term of one month or one year.
--   * Buying the SAME plan while it's still active renews it: the new term
--     is added to the end of the current one, and usage carries on.
--   * Buying a DIFFERENT plan replaces the current one from now.
--   * When the term ends the account drops to Free (expire_lapsed_plans,
--     run every 10 minutes by pg_cron; the backend also treats a lapsed plan
--     as Free immediately, so the gap between runs costs nothing).
--
-- plan_expires_at null on a paid plan means "no end date" — only an admin
-- can set that (e.g. a comped account).

alter table public.profiles add column plan_expires_at timestamptz;

comment on column public.profiles.plan_expires_at is
  'End of the paid term. Null on a paid plan = no end date (admin-granted). Ignored on the free plan.';

-- ---------------------------------------------------------------------------
-- 1. Users can't extend their own term
-- ---------------------------------------------------------------------------

-- Same as 20260724000000_ban_delete_presence.sql, plus plan_expires_at.
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
     or new.plan_expires_at is distinct from old.plan_expires_at
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

-- ---------------------------------------------------------------------------
-- 2. Granting a plan starts or extends a term
-- ---------------------------------------------------------------------------

-- Replaces the version in 20261004000000_sepay_payments.sql (packs unchanged).
create or replace function public.grant_checkout_entitlement(p_event public.checkout_events)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_checks integer;
  v_profile public.profiles;
  v_term interval;
begin
  if p_event.kind = 'plan' then
    if p_event.plan_tier is null then
      raise exception 'Plan order % has no plan_tier', p_event.id;
    end if;
    v_term := case when p_event.billing_cycle = 'annual' then interval '1 year' else interval '1 month' end;

    select * into v_profile from public.profiles where id = p_event.user_id for update;

    if v_profile.plan_tier = p_event.plan_tier
       and v_profile.plan_expires_at is not null
       and v_profile.plan_expires_at > now() then
      -- Renewal: add the new term to the end of the current one.
      update public.profiles
      set plan_expires_at = plan_expires_at + v_term,
          billing_cycle = p_event.billing_cycle
      where id = p_event.user_id;
    else
      -- New plan (or switching plans, or the old term lapsed): start now.
      update public.profiles
      set plan_tier = p_event.plan_tier,
          billing_cycle = p_event.billing_cycle,
          plan_expires_at = now() + v_term,
          checks_used_this_period = 0,
          plan_period_start = now()
      where id = p_event.user_id;
    end if;
  else
    if p_event.pack_id is null then
      raise exception 'Pack order % has no pack_id', p_event.id;
    end if;
    select checks into v_checks from public.credit_packs where id = p_event.pack_id;
    if v_checks is null then
      raise exception 'Unknown credit pack % on order %', p_event.pack_id, p_event.id;
    end if;
    v_checks := v_checks * coalesce(p_event.quantity, 1);
    if p_event.pack_id = 'pack-premium' then
      update public.profiles set premium_credits = premium_credits + v_checks where id = p_event.user_id;
    else
      update public.profiles set standard_credits = standard_credits + v_checks where id = p_event.user_id;
    end if;
  end if;
end;
$$;

revoke all on function public.grant_checkout_entitlement(public.checkout_events) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Lapsed plans drop to Free
-- ---------------------------------------------------------------------------

-- plan_expires_at is kept so the account can show when the plan ended.
create or replace function public.expire_lapsed_plans()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.profiles
  set plan_tier = 'free',
      billing_cycle = null,
      checks_used_this_period = 0,
      plan_period_start = now()
  where plan_tier <> 'free'
    and plan_expires_at is not null
    and plan_expires_at <= now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.expire_lapsed_plans() from public, anon, authenticated;
grant execute on function public.expire_lapsed_plans() to service_role;

-- Every 10 minutes, where pg_cron is available (it is on Supabase).
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
    perform cron.schedule('expire-lapsed-plans', '*/10 * * * *', 'select public.expire_lapsed_plans()');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Give existing paid plans an end date
-- ---------------------------------------------------------------------------

-- From the user's latest paid order for that plan when there is one, else 30
-- days from now (plans granted by hand). Never less than 7 days from now, so
-- nobody loses access the moment this ships.
update public.profiles p
set plan_expires_at = greatest(
  coalesce(
    (
      select max(
        coalesce(e.paid_at, e.reviewed_at, e.created_at)
        + case when e.billing_cycle = 'annual' then interval '1 year' else interval '1 month' end
      )
      from public.checkout_events e
      where e.user_id = p.id and e.kind = 'plan' and e.status = 'success' and e.plan_tier = p.plan_tier
    ),
    now() + interval '30 days'
  ),
  now() + interval '7 days'
)
where p.plan_tier <> 'free' and p.plan_expires_at is null;
