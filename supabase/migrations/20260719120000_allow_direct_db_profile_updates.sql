-- 20260719000000_lock_down_profile_self_updates.sql's trigger blocked ALL
-- writes to sensitive profiles columns unless auth.role() = 'service_role'
-- or public.is_admin(auth.uid()) — but auth.role()/auth.uid() are Supabase
-- helpers that read request.jwt.claims, which is only set when a write goes
-- through PostgREST with a user JWT. Direct connections (the Dashboard SQL
-- Editor, psql, migrations) never set that GUC, so auth.role() and
-- auth.uid() are both NULL there — meaning the trigger was accidentally
-- blocking legitimate admin SQL (e.g. `update profiles set role = 'admin'`)
-- in addition to the app-traffic self-escalation it was meant to stop.
--
-- Fix: also allow through when there's no PostgREST JWT context at all
-- (auth.role() is null) — anyone running raw SQL already has Dashboard/DB
-- credentials, a strictly stronger privilege boundary than anything this
-- trigger could add, so gating on "no JWT" doesn't weaken the protection
-- against authenticated app users self-escalating via the client SDK (they
-- always carry a JWT with role='authenticated').
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
     or new.credits is distinct from old.credits
     or new.checks_used_this_period is distinct from old.checks_used_this_period
     or new.plan_period_start is distinct from old.plan_period_start
     or new.student_verified is distinct from old.student_verified
  then
    raise exception 'Not allowed to modify this field.';
  end if;

  return new;
end;
$$;
