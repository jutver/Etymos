-- Google sign-in: default the profile's display name from the Google account.
--
-- Supabase's Google provider fills auth.users.raw_user_meta_data with
-- `full_name` / `name` (and `avatar_url` / `picture`), but never
-- `display_name`, which is the only key handle_new_user read. Google signups
-- therefore landed with a null profiles.display_name. A name the user typed
-- (email signup, or a later save on My Profile) still wins.

-- ---------------------------------------------------------------------------
-- 1. handle_new_user: fall back to the OAuth provider's name
-- ---------------------------------------------------------------------------
-- Re-declared in full; identical to 20260721000000 apart from the coalesce.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name, access_requested_at)
  values (
    new.id,
    new.email,
    coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
      nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
      nullif(trim(new.raw_user_meta_data ->> 'name'), '')
    ),
    now()
  );
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Backfill existing Google users that have no name yet
-- ---------------------------------------------------------------------------
-- Not a user action, so it stays out of user_activity_log.
select set_config('etymos.suppress_activity_log', 'on', true);

update public.profiles p
set display_name = coalesce(
  nullif(trim(u.raw_user_meta_data ->> 'full_name'), ''),
  nullif(trim(u.raw_user_meta_data ->> 'name'), '')
)
from auth.users u
where u.id = p.id
  and nullif(trim(p.display_name), '') is null
  and coalesce(
    nullif(trim(u.raw_user_meta_data ->> 'full_name'), ''),
    nullif(trim(u.raw_user_meta_data ->> 'name'), '')
  ) is not null;

select set_config('etymos.suppress_activity_log', '', true);
