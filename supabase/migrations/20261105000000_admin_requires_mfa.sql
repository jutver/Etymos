-- Admin powers need a second factor.
--
-- is_admin() is the check behind every admin policy and admin function
-- (about 90 call sites). Until now it only read profiles.role, so a stolen
-- admin password was enough to read and change everything through the
-- Supabase API. Supabase puts the session's assurance level in the JWT:
-- 'aal1' after a password or Google sign-in, 'aal2' once an authenticator
-- code has been entered (the admin dashboard asks for one before it loads).
--
-- The extra condition only applies when the uid being checked is the caller
-- (`is_admin(auth.uid())`, how every policy uses it):
--   * an admin signed in with aal2 keeps full access;
--   * the same admin at aal1 is treated as a normal user (their own rows only);
--   * callers without a user JWT (backend service role, triggers fired by
--     GoTrue, migrations) have no auth.uid() and are unaffected;
--   * asking whether someone else is an admin answers as before.
--
-- Rollout: every admin must have enrolled an authenticator in the admin app
-- before this is applied, or they lose access until they do.

create or replace function public.is_admin(uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles where id = uid and role = 'admin'
  )
  and (
    uid is distinct from auth.uid()
    or coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
  );
$$;
