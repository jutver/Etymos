# Waitlist demo seed

Admin-portal-demo-only SQL for backfilling historical waitlist signups with
plausible, randomized timestamps. Not run automatically by any migration —
paste the finished query into the Supabase SQL Editor (or `psql`) by hand
once the email lists below are filled in.

Two batches, matching the two "waves" of demo signups:

| Phase | Window (Asia/Ho_Chi_Minh, UTC+7) | Users |
| --- | --- | --- |
| 1 | 2026-07-16 08:00 → 2026-07-18 15:00 | 31 |
| 2 | 2026-07-19 07:30 → 2026-07-20 22:00 | 5 |

Every timestamp is drawn uniformly at random from its window, **excluding
01:00–06:00** each day (no one signs up at 3am) — enforced by a small
retry-loop function, not a post-hoc filter, so the excluded hours don't skew
the distribution of the hours around them.

Each seeded user gets a real `auth.users` row (so they show up anywhere the
admin portal joins against `auth.users`, e.g. Supabase Auth's own dashboard)
and a matching `public.profiles` row with `access_status = 'waitlisted'` —
same state a real signup lands in (see
`supabase/migrations/20260721000000_waitlist_and_purchase_approval.sql`).
Both rows' `created_at` are backdated to the same randomized timestamp.

## How to use

1. Replace the two `values (...)` email lists below (`-- PHASE 1 EMAILS` /
   `-- PHASE 2 EMAILS`) with the real addresses, one per line, e.g.
   `('student1@fpt.edu.vn'),`.
2. Run the whole script in one Supabase SQL Editor session (the random-
   timestamp helper is a `pg_temp` function — session-scoped, cleans itself
   up, never touches the `public` schema).
3. Verify in the admin portal's Users page: the new rows should show up with
   "Waitlisted" status and a spread of join dates across each window, none
   of them between 1am and 6am.

Every seeded account uses the placeholder password below — these are demo
rows for the admin portal to display, not accounts anyone is meant to sign
into. Rotate/delete them before go-live if they were ever seeded against a
project that isn't purely for demo purposes.

```sql
-- =============================================================================
-- Waitlist demo seed — Phase 1 (31 users) + Phase 2 (5 users)
-- =============================================================================

create extension if not exists pgcrypto;

-- Auto-provisioning trigger (supabase/migrations/20260715120000_profiles.sql)
-- would otherwise fire on every auth.users insert below and create its own
-- profiles row (with access_requested_at = now(), not our backdated
-- timestamp) before our explicit profiles insert ever runs, causing a
-- primary-key conflict. Disable it for the duration of this script, restore
-- it at the end — real signups go through the normal signup flow, which is
-- unaffected once this script finishes.
alter table auth.users disable trigger on_auth_user_created;

-- Uniform-random timestamp in [start_ts, end_ts], resampled until its local
-- hour falls outside 01:00–06:00. Bounded in practice: a 5-hour exclusion
-- inside multi-day windows resolves in a handful of iterations.
create or replace function pg_temp.random_ts_excluding_night(start_ts timestamptz, end_ts timestamptz)
returns timestamptz
language plpgsql
as $$
declare
  candidate timestamptz;
begin
  loop
    candidate := start_ts + random() * (end_ts - start_ts);
    if extract(hour from candidate at time zone 'Asia/Ho_Chi_Minh') not in (1, 2, 3, 4, 5) then
      return candidate;
    end if;
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Phase 1: 2026-07-16 08:00 -> 2026-07-18 15:00 (Asia/Ho_Chi_Minh), 31 users
-- -----------------------------------------------------------------------------

create temporary table _waitlist_seed_phase1 as
select
  gen_random_uuid() as id,
  email,
  pg_temp.random_ts_excluding_night(
    '2026-07-16 08:00:00+07'::timestamptz,
    '2026-07-18 15:00:00+07'::timestamptz
  ) as ts
from (
  values
    -- PHASE 1 EMAILS — replace with the real 31 addresses
    ('phase1-user01@example.com'),
    ('phase1-user02@example.com')
    -- ... add the remaining 29 here, one `('email@example.com'),` per line
) as e(email);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, confirmation_token, recovery_token,
  email_change, email_change_token_new,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
)
select
  '00000000-0000-0000-0000-000000000000',
  id,
  'authenticated',
  'authenticated',
  email,
  crypt('DemoWaitlist#2026', gen_salt('bf')),
  ts, '', '', '', '',
  ts, ts,
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb
from _waitlist_seed_phase1;

insert into public.profiles (id, email, display_name, access_status, access_requested_at, created_at, updated_at)
select id, email, split_part(email, '@', 1), 'waitlisted', ts, ts, ts
from _waitlist_seed_phase1;

drop table _waitlist_seed_phase1;

-- -----------------------------------------------------------------------------
-- Phase 2: 2026-07-19 07:30 -> 2026-07-20 22:00 (Asia/Ho_Chi_Minh), 5 users
-- -----------------------------------------------------------------------------

create temporary table _waitlist_seed_phase2 as
select
  gen_random_uuid() as id,
  email,
  pg_temp.random_ts_excluding_night(
    '2026-07-19 07:30:00+07'::timestamptz,
    '2026-07-20 22:00:00+07'::timestamptz
  ) as ts
from (
  values
    -- PHASE 2 EMAILS — replace with the real 5 addresses
    ('phase2-user01@example.com'),
    ('phase2-user02@example.com'),
    ('phase2-user03@example.com'),
    ('phase2-user04@example.com'),
    ('phase2-user05@example.com')
) as e(email);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, confirmation_token, recovery_token,
  email_change, email_change_token_new,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
)
select
  '00000000-0000-0000-0000-000000000000',
  id,
  'authenticated',
  'authenticated',
  email,
  crypt('DemoWaitlist#2026', gen_salt('bf')),
  ts, '', '', '', '',
  ts, ts,
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb
from _waitlist_seed_phase2;

insert into public.profiles (id, email, display_name, access_status, access_requested_at, created_at, updated_at)
select id, email, split_part(email, '@', 1), 'waitlisted', ts, ts, ts
from _waitlist_seed_phase2;

drop table _waitlist_seed_phase2;

-- -----------------------------------------------------------------------------
alter table auth.users enable trigger on_auth_user_created;
```
