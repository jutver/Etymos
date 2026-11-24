-- Account-level UI and email preferences on public.profiles.
-- Both columns have safe defaults matching UserPreferences (light theme, opt-out of check emails).
alter table public.profiles
  add column if not exists theme_preference text not null default 'light'
    check (theme_preference in ('light', 'dark')),
  add column if not exists email_on_check_done boolean not null default false;
