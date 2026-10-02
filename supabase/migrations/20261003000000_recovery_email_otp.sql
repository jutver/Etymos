-- Recovery email moves from emailed links to 6-digit one-time codes, for
-- both confirming the address (profile page) and recovering the account
-- (/recover-account), and one address may now serve several accounts. See
-- backend/api/recovery_email.py.
--
-- Each purpose gets its own code, expiry and attempt counter, so a code sent
-- to confirm the address can never be used to reset the password (or the
-- reverse). Codes are stored hashed; after MAX_ATTEMPTS wrong guesses the
-- code is discarded and a new one must be requested.
--
-- The table was empty when this was written, so the rename is safe.

alter table public.recovery_emails rename column verify_token_hash to verify_code_hash;

alter table public.recovery_emails
  add column verify_attempts smallint not null default 0,
  add column reset_code_hash text,
  add column reset_expires_at timestamptz,
  add column reset_attempts smallint not null default 0;

-- Codes are looked up by user (confirm) or by verified address (reset),
-- never by the code itself.
drop index if exists public.recovery_emails_verify_token_idx;

-- Several accounts may confirm the same recovery address (e.g. one person's
-- personal and work accounts); recovery then lists them to choose from,
-- after the code proves control of the inbox. So the one-account-per-address
-- rule goes, replaced by a plain lookup index for recovery requests.
drop index if exists public.recovery_emails_verified_email_key;
create index recovery_emails_verified_email_idx
  on public.recovery_emails (email)
  where verified_at is not null;
