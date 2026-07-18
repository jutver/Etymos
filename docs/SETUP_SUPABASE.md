# Supabase live-project setup

Reproducible runbook for applying Etymos's schema and dashboard settings to
the **live** Supabase project. Run this yourself — no live credentials exist
in the dev/agent environment, so none of these steps have been executed
against a real project on your behalf.

## 1. Apply the migrations

`supabase/migrations/` currently has 6 files, applied in filename order:

```
20260715120000_profiles.sql
20260715120100_documents.sql
20260715120200_checkout_events.sql
20260715120300_plan_definitions_and_credit_packs.sql
20260715120400_feature_flags_and_announcements.sql
20260716120000_student_verification_and_audit_log.sql
```

Pick one of the two options below.

### Option A — Supabase CLI

```bash
# once, if you don't have the CLI yet
npm install -g supabase

# from the repo root
supabase login
supabase link --project-ref <your-project-ref>   # ref is the subdomain in VITE_SUPABASE_URL
supabase db push                                   # applies migrations/*.sql in order
psql "$(supabase db url)" -f supabase/seed.sql      # or run seed.sql via the SQL Editor
```

### Option B — Dashboard SQL Editor

Paste each file in `supabase/migrations/` (in the filename order listed
above) into the Dashboard's SQL Editor and run it, then paste and run
`supabase/seed.sql` last.

Either way, run the migrations before the seed file — `seed.sql` upserts
into `plan_definitions`/`credit_packs`, which only exist after
`20260715120300_plan_definitions_and_credit_packs.sql` has been applied, and
the new `20260716120000_student_verification_and_audit_log.sql` seeds the
`gemini_metadata_extraction` feature flag itself (no separate seed step
needed for that one).

## 2. Enable "Confirm email"

Go to **Authentication > Providers > Email** and turn on **Confirm email**
(may also appear as "Enable email confirmations" depending on dashboard
version). This forces new signups through the email-confirmation link before
they can use the app, which the frontend's confirmation-gate UI expects.

## 3. Enable identity linking for Google sign-in

So that a Google sign-in using an email address that already has a
password-based (or other provider) account merges into the *same*
`auth.users` row instead of creating a duplicate account, enable Supabase
Auth's automatic (or manual) identity linking. As of when this doc was
written this lives under **Authentication > Providers** (sometimes
surfaced as "Account Linking" or "Manual Linking" in the provider/session
settings) — enable automatic linking by verified email if available.

**Flag:** the exact toggle name and location may have moved since this was
written. Verify live in your dashboard rather than trusting this section
literally — search the Auth settings for "linking" if you don't see it
where described.

## 4. Confirm the Storage buckets

Migration `20260716120000_student_verification_and_audit_log.sql` inserts
two buckets directly (`insert into storage.buckets ...`):

- `documents`
- `student-verification`

Both are created private (`public = false`). After applying the migrations,
open **Storage** in the dashboard and double-check:

- Both buckets exist.
- Both show as **private** (no public access toggle enabled).

If either bucket is missing or shows as public, the `insert` may have been
skipped (e.g. an `on conflict do nothing` no-op against a pre-existing
differently-configured bucket) — create/fix it manually via the Storage UI
to match: private, no public URL access.

## 5. Promote your first admin

No self-serve admin promotion exists anywhere in the app (by design — see
`PLAN.md`). After signing up normally through the app, run once in the SQL
Editor:

```sql
update public.profiles set role = 'admin' where id = '<your-auth-user-uuid>';
```

Find `<your-auth-user-uuid>` under **Authentication > Users**.

## Verify before moving on

With two different signed-in users, confirm neither can read/write the
other's `profiles`/`documents`/`student_verification_requests` rows, that
the `role = 'admin'` user can read/write everything (including all rows in
`audit_log`, which is admin-select-only with no client write policy at all —
writes only happen via the backend's service-role key), and that both
Storage buckets reject cross-user reads/writes outside a caller's own
`{bucket}/{user_id}/...` prefix.
