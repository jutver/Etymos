# Waitlist demo seed

Admin-portal-demo-only seeding for backfilling historical waitlist signups
with plausible, randomized timestamps.

Two batches, matching the two "waves" of demo signups:

| Phase | Window (Asia/Ho_Chi_Minh, UTC+7) | Users |
| --- | --- | --- |
| 1 | 2026-07-16 08:00 → 2026-07-18 15:00 | 31 |
| 2 | 2026-07-19 07:30 → 2026-07-20 22:00 | 5 |

Every timestamp is drawn uniformly at random from its window, **excluding
01:00–06:00** each day (no one signs up at 3am) — enforced by a small
retry loop, not a post-hoc filter, so the excluded hours don't skew the
distribution of the hours around them.

## Why this is a script, not a SQL query

The original plan was a plain SQL script for the Supabase SQL Editor. That
doesn't work:

- `public.profiles.id` is a hard `foreign key references auth.users(id)`
  (`supabase/migrations/20260715120000_profiles.sql:5`), so a `profiles` row
  cannot exist without a matching `auth.users` row first — seeding
  `profiles` alone is not an option.
- `auth.users` is owned by the `supabase_auth_admin` role, not `postgres`
  (the role the SQL Editor connects as). Both writing to it (`INSERT`) and
  altering it (`ALTER TABLE ... DISABLE TRIGGER`, needed to stop the
  auto-provisioning trigger from fighting a manual insert) require table
  ownership, which `postgres` doesn't have and can't acquire via `SET ROLE`
  either — Supabase deliberately doesn't grant that membership, so the
  `auth` schema can only be written through the Auth Admin API.

So the seed is `backend/scripts/seed_waitlist_demo.py`: it creates each user
through the Admin API (`auth.admin.create_user`, using the backend's
existing service-role client), lets the existing `handle_new_user` trigger
create the matching `profiles` row as normal, then immediately overwrites
that row's `access_status` / `access_requested_at` / `created_at` /
`updated_at` with the randomized backdated timestamp.

Caveat: `auth.users.created_at` itself is stamped "now" by the Admin API and
can't be backdated — only `profiles.created_at` is randomized. This is fine
for the admin portal (it reads exclusively from `public.profiles`, never
joins `auth.users`), but the Supabase Auth dashboard's own user list will
show today's date for these accounts.

## How to use

1. Open `backend/scripts/seed_waitlist_demo.py` and replace `PHASE_1_EMAILS`
   / `PHASE_2_EMAILS` with the real addresses.
2. Run it against the target project's service-role key:
   ```bash
   cd backend
   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... python3 -m scripts.seed_waitlist_demo
   ```
3. Verify in the admin portal's Users page: the new rows should show up with
   "Waitlisted" status and a spread of join dates across each window, none
   of them between 1am and 6am.

The script is safe to re-run — an email that already has an auth user
fails `create_user` and is logged as skipped rather than aborting the rest,
so a partial run can be resumed.

Every seeded account uses the placeholder password in the script
(`DemoWaitlist#2026`) — these are demo rows for the admin portal to
display, not accounts anyone is meant to sign into. Rotate/delete them
before go-live if they were ever seeded against a project that isn't purely
for demo purposes.
