-- Optional second email address per account, used only for password resets
-- (backend/api/recovery_email.py). Replaces the unverified
-- `user_metadata.recovery_email` the profile page used to write, which
-- nothing ever read.
--
-- Purely additive: no existing table, policy or function is changed.
--
-- Access: RLS on with NO policies, and no grants to anon/authenticated. Only
-- the service-role backend touches this table. That keeps verification
-- tamper-proof (a user can't mark their own address verified) and keeps the
-- email -> account lookup used by "forgot password" away from clients.

create table public.recovery_emails (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  -- Stored lower-cased; the backend normalises before every read and write.
  email text not null check (char_length(email) between 3 and 254 and email = lower(email)),
  -- Null until the owner clicks the verify link. Only verified rows are used
  -- for password resets.
  verified_at timestamptz,
  -- sha256 of the single-use verify token (the token itself is only ever in
  -- the email), and when it stops being redeemable (30 minutes).
  verify_token_hash text,
  verify_expires_at timestamptz,
  -- Last time the backend emailed this address (verify link or reset link);
  -- enforces a minimum gap between emails so the endpoints can't flood it.
  last_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One account per verified recovery address, so "forgot password" for an
-- address always resolves to exactly one account. Unverified rows may share
-- an address (someone can't block an address by typing it first).
create unique index recovery_emails_verified_email_key
  on public.recovery_emails (email)
  where verified_at is not null;

create index recovery_emails_verify_token_idx
  on public.recovery_emails (verify_token_hash)
  where verify_token_hash is not null;

alter table public.recovery_emails enable row level security;
revoke all on public.recovery_emails from anon, authenticated;
