-- Splits the single generic `profiles.credits` bucket into two distinct
-- purchasable balances (`standard_credits`, `premium_credits`), matching the
-- two credit packs that already exist (pack-standard, pack-premium) but
-- previously both just incremented the same undifferentiated `credits`
-- column. Users now have three independent balances to check a document
-- with: plan checks (checks_used_this_period vs plan_definitions.doc_limit,
-- unchanged), standard_credits, and premium_credits — apps/web lets the
-- user pick which one to spend per check.

alter table public.profiles add column standard_credits integer not null default 0;
alter table public.profiles add column premium_credits integer not null default 0;

-- Backfill: treat pre-existing generic credits as standard credits (that's
-- the cheaper/default pack, the safer assumption for a lossy split).
update public.profiles set standard_credits = credits;

alter table public.profiles drop column credits;

-- Re-point the self-privilege-escalation trigger (20260719120000) at the
-- new columns instead of the now-dropped `credits`. Re-declaring via
-- create-or-replace rather than editing the historical migration files,
-- since those have already been applied to the live project.
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
  then
    raise exception 'Not allowed to modify this field.';
  end if;

  return new;
end;
$$;
