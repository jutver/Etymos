-- Support tickets (backend/api/support.py, support_inbound.py).
--
-- A ticket is opened from the /contact form (signed in or not) or by an email
-- to support@etymos.site. Agents answer from the admin app; the requester
-- answers by replying to the email or on the site. Every message, whichever
-- way it came in, is a row in support_messages.
--
-- Access: RLS on. Admins may read everything (the admin app could query it
-- directly); users read their own tickets through the backend, which checks
-- ownership itself. No client may write: every write goes through the
-- service-role backend, which applies rate limits, sends the emails and
-- keeps statuses consistent.
--
-- Tickets without an account (guest form, email) are opened from emails
-- through /support/t/{token}. The token is an HMAC of the ticket id under a
-- server-only secret (SUPPORT_LINK_SECRET), so nothing about it is stored
-- here.

create table public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  -- The public ticket number shown to people ("#1042").
  number bigint generated always as identity (start with 1001) unique,
  user_id uuid references public.profiles(id) on delete set null,
  -- Stored lower-cased.
  requester_email text not null check (char_length(requester_email) between 3 and 254 and requester_email = lower(requester_email)),
  requester_name text check (requester_name is null or char_length(requester_name) <= 120),
  -- True only when a signed-in user opened it. Guest and email tickets are
  -- false even when the address matches an account: a From header can be
  -- forged and a guest can type anyone's address.
  identity_verified boolean not null default false,
  category text not null default 'other' check (category in ('billing', 'account', 'checks', 'bug', 'other')),
  subject text not null check (char_length(subject) between 1 and 200),
  -- open = waiting on us; pending = waiting on the requester.
  status text not null default 'open' check (status in ('open', 'pending', 'resolved', 'closed')),
  priority text not null default 'normal' check (priority in ('normal', 'high')),
  assigned_to uuid references public.profiles(id) on delete set null,
  source text not null default 'form' check (source in ('form', 'email')),
  -- A reply to a closed ticket opens a new one that points back here.
  previous_ticket_id uuid references public.support_tickets(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_user_message_at timestamptz,
  last_agent_message_at timestamptz,
  resolved_at timestamptz,
  closed_at timestamptz
);

create index support_tickets_status_idx on public.support_tickets (status, last_user_message_at);
create index support_tickets_user_id_idx on public.support_tickets (user_id);
create index support_tickets_assigned_to_idx on public.support_tickets (assigned_to);
create index support_tickets_requester_email_idx on public.support_tickets (requester_email);

create table public.support_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.support_tickets(id) on delete cascade,
  author_type text not null check (author_type in ('user', 'agent', 'system')),
  author_id uuid references public.profiles(id) on delete set null,
  -- Plain text. For email replies, the quoted history is already cut.
  body text not null check (char_length(body) <= 20000),
  -- Agent-only notes; never shown or emailed to the requester.
  internal boolean not null default false,
  channel text not null check (channel in ('web', 'email', 'admin')),
  -- The Message-ID we sent this message with, or the one it arrived with.
  -- Replies are matched to tickets through it, and it makes the inbound
  -- poller idempotent.
  email_message_id text unique,
  -- Original .eml in the support-attachments bucket, for inbound email.
  raw_email_path text,
  -- spf/dkim/dmarc verdict of an inbound email: pass / fail / none.
  sender_auth text check (sender_auth is null or sender_auth in ('pass', 'fail', 'none')),
  -- Inbound email from an address other than the requester's.
  sender_mismatch boolean not null default false,
  sender_email text,
  created_at timestamptz not null default now()
);

create index support_messages_ticket_id_idx on public.support_messages (ticket_id, created_at);

create table public.support_attachments (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.support_tickets(id) on delete cascade,
  message_id uuid not null references public.support_messages(id) on delete cascade,
  path text not null,
  filename text not null,
  content_type text not null,
  size_bytes integer not null check (size_bytes >= 0),
  created_at timestamptz not null default now()
);

create index support_attachments_message_id_idx on public.support_attachments (message_id);

-- One row per email the inbound poller looked at, whatever it did with it.
-- The row is inserted first ('processing') as a claim, so an email is handled
-- once even if two backend processes poll the mailbox.
create table public.support_inbound_log (
  id uuid primary key default gen_random_uuid(),
  message_id text not null unique,
  from_address text,
  subject text,
  outcome text not null check (outcome in ('processing', 'appended', 'ticket_created', 'ignored_auto', 'ignored_own', 'failed')),
  ticket_id uuid references public.support_tickets(id) on delete set null,
  detail text,
  received_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.support_tickets enable row level security;
alter table public.support_messages enable row level security;
alter table public.support_attachments enable row level security;
alter table public.support_inbound_log enable row level security;

create policy "support_tickets_select_admin"
  on public.support_tickets for select using (public.is_admin(auth.uid()));
create policy "support_messages_select_admin"
  on public.support_messages for select using (public.is_admin(auth.uid()));
create policy "support_attachments_select_admin"
  on public.support_attachments for select using (public.is_admin(auth.uid()));
create policy "support_inbound_log_select_admin"
  on public.support_inbound_log for select using (public.is_admin(auth.uid()));

revoke insert, update, delete on public.support_tickets from anon, authenticated;
revoke insert, update, delete on public.support_messages from anon, authenticated;
revoke insert, update, delete on public.support_attachments from anon, authenticated;
revoke insert, update, delete on public.support_inbound_log from anon, authenticated;

-- Attachments and raw inbound emails. Private, no client policies: the
-- backend reads and writes with the service role and hands out short-lived
-- signed URLs. Path: {ticket_id}/{uuid}-{filename}.
insert into storage.buckets (id, name, public)
values ('support-attachments', 'support-attachments', false)
on conflict (id) do nothing;
