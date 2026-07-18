-- Lock down self-service updates to `profiles`' privileged columns.
--
-- profiles_update_self_or_admin (20260715120000_profiles.sql) only checks
-- *which row* a caller may update (auth.uid() = id) — it does not restrict
-- *which columns* or *what values*. Nothing stops an authenticated user
-- from running, straight from the browser, using their own session and the
-- publishable/anon key already loaded on the page:
--
--   supabase.from("profiles")
--     .update({ role: "admin", plan_tier: "professional", credits: 999999 })
--     .eq("id", myOwnUserId)
--
-- and having it succeed — a self-service privilege-escalation / unlimited-
-- credits hole. This trigger closes it: non-admins may still update their
-- own row (e.g. future self-service profile fields), but may not change
-- role, plan_tier, billing_cycle, credits, checks_used_this_period,
-- plan_period_start, or student_verified on it.
--
-- Two callers are exempt from the restriction, both intentionally:
--   - admins (public.is_admin), since apps/admin's UserDetail screen
--     legitimately edits these fields for *other* users;
--   - the service role (auth.role() = 'service_role'), since the backend's
--     service-role client (backend/api/supabase_client.py) is the only
--     place that should ever grant credits, advance plan_period_start, or
--     increment checks_used_this_period going forward.

create or replace function public.prevent_profile_self_privilege_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() = 'service_role' or public.is_admin(auth.uid()) then
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

create trigger profiles_prevent_self_privilege_escalation
  before update on public.profiles
  for each row execute function public.prevent_profile_self_privilege_escalation();
