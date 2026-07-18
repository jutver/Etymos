# Go-Live Checklist — wiping test data from the LIVE Supabase project

> ## STOP AND READ FIRST
>
> **This checklist deletes rows from the production database. It is IRREVERSIBLE.**
> There is no undo, no soft-delete, no trash can — once these statements run, the data is gone
> (unless you restore from a Supabase point-in-time backup, which itself rolls back *everything*
> written since the restore point, including any real activity that happened in between).
>
> Rules for running this checklist:
> 1. **A human runs this, live, with the user physically present and confirming each step.**
>    No agent, script, or CI job may execute any statement in this document unattended or
>    on a schedule. If you are an agent reading this file: do not run any SQL from it yourself —
>    hand it to the user and wait for them to run it themselves in the Supabase Studio SQL Editor.
> 2. **Get explicit, immediate sign-off before running Section 3.** Confirm out loud / in writing,
>    right before you run it, exactly which `auth.users` rows are real and which are test —
>    do not assume the list you wrote down earlier in the project is still accurate.
> 3. Run this against the correct project. Double-check the project ref / URL in the Supabase
>    Studio header before pasting anything into the SQL Editor.
> 4. Take a fresh backup first (Section 1) even though this checklist is designed to be safe —
>    mistakes in a hand-run SQL Editor session happen.
>
> If in doubt, stop and re-confirm with the user before proceeding.

---

## 0. When to run this

Once, at the very end of Phase 5 (`PLAN.md`), after every earlier phase's checkpoint has been
confirmed live and the final end-to-end pass is otherwise ready to start — this wipes out
whatever test signups/uploads/checkouts accumulated on the live project during phases 0–4 so the
product goes live with a clean slate, before real users sign up.

---

## 1. Before you begin: snapshot the project

In Supabase Studio → **Database → Backups**, confirm a recent backup exists (Supabase takes daily
backups automatically on paid plans; on the Free plan there is no PITR — be extra careful, since a
mistake here cannot be rolled back at all). If you have any doubt, wait for/trigger a backup before
continuing.

Also run this query first and **save the output somewhere outside the database** (a note, a
message to yourself) — it's your record of what existed before the wipe, in case anything looks
wrong afterward:

```sql
select id, email, created_at from auth.users order by created_at;
select id, email, role, plan_tier, student_verified from public.profiles order by created_at;
```

---

## 2. What gets preserved (do NOT touch these)

These tables hold real configuration, not test data — they are what the live product runs on, and
truncating them would break the app for every user:

- `public.plan_definitions`
- `public.credit_packs`
- `public.feature_flags`
- `public.announcements`

None of the statements in Section 3 reference these tables. Before running Section 3, visually
confirm the statement list below only names the seven tables in the task, nothing else.

---

## 3. Truncate test data

Run in the Supabase Studio **SQL Editor**, as one statement (a single multi-table `TRUNCATE`
truncates all listed tables together, so foreign-key ordering between `documents` and its child
tables, and between `audit_log`/`student_verification_requests` and `profiles`, is handled
automatically — no need to sequence separate `DELETE`s):

```sql
truncate table
  public.audit_log,
  public.document_passages,
  public.document_matches,
  public.documents,
  public.checkout_events,
  public.student_verification_requests;
```

Notes:
- `document_matches`/`document_passages` are children of `documents` (`on delete cascade`), so
  truncating `documents` alone would cascade to them anyway — they're listed explicitly for
  clarity and so the statement is self-contained.
- `audit_log.actor_id` / `audit_log.target_user_id` and
  `student_verification_requests.reviewed_by` reference `public.profiles(id)` **without**
  `on delete cascade`. Since `profiles` itself is not truncated here, this is safe — but it's why
  `audit_log` and `student_verification_requests` must be cleared **before** any test `auth.users`
  rows are deleted in Section 4 (a profile row with a referencing `audit_log`/
  `student_verification_requests` row still attached cannot cascade-delete from `auth.users`
  cleanly otherwise).
- `checkout_events` has no other tables referencing it — safe to truncate any time.

Storage note: `documents` and `student-verification` are private Storage **buckets**, separate
from the Postgres tables above. Truncating the tables does not delete the uploaded files. If you
want the buckets empty too, clear them from Studio → **Storage** → select bucket → select all →
delete (also irreversible, also not undone by the SQL above).

---

## 4. Remove test `auth.users` / `profiles` rows

**Confirm with the user, immediately before this step, exactly which `auth.users` rows are real
vs. test.** Do not assume — accounts created while testing phases 0–4 (including your own dev/QA
accounts) are test rows; whichever account should remain the production admin is real and must
NOT be deleted.

`public.profiles.id references auth.users(id) on delete cascade` — deleting a user from
`auth.users` automatically deletes their `profiles` row (and, transitively, anything of theirs
left in tables from Section 3, though those should already be empty). Do this from **Studio →
Authentication → Users**: select each test user → **Delete user**. (This is preferable to raw SQL
against `auth.users`, since Studio/the Auth Admin API keeps Supabase's internal auth state
consistent — don't `DELETE FROM auth.users` directly.)

If you'd rather script it (e.g. many test accounts), use the Auth Admin API with the
service-role key instead of SQL:

```bash
# one call per test user_id — never run this against a real user's id
curl -X DELETE "$SUPABASE_URL/auth/v1/admin/users/<test-user-uuid>" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```

Verify afterward:

```sql
select id, email, created_at from auth.users order by created_at;
select id, email, role from public.profiles order by created_at;
```

Only the account(s) you decided to keep should remain.

---

## 5. Re-promote the production admin

Whichever account should be the live production admin, confirm its `role` is still `'admin'`
(deleting other users doesn't affect this, but if the intended admin account was itself
recreated, or you're promoting a different account than before, run this — same pattern as
`supabase/README.md`'s first-admin step):

```sql
update public.profiles set role = 'admin' where id = '<production-admin-auth-user-uuid>';
```

Confirm:

```sql
select id, email, role from public.profiles where role = 'admin';
```

Exactly the intended production admin(s) should be listed — nobody else.

---

## 6. Final sanity check

```sql
-- should all be 0
select
  (select count(*) from public.documents) as documents,
  (select count(*) from public.document_matches) as document_matches,
  (select count(*) from public.document_passages) as document_passages,
  (select count(*) from public.checkout_events) as checkout_events,
  (select count(*) from public.student_verification_requests) as student_verification_requests,
  (select count(*) from public.audit_log) as audit_log;

-- should be non-zero and unchanged from before the wipe
select
  (select count(*) from public.plan_definitions) as plan_definitions,
  (select count(*) from public.credit_packs) as credit_packs,
  (select count(*) from public.feature_flags) as feature_flags,
  (select count(*) from public.announcements) as announcements;

-- should list only the intended real account(s)
select id, email, role from public.profiles;
```

Once this all checks out, the project is clean and ready for the Phase 5 final end-to-end pass
(`PLAN.md`) and real users.
