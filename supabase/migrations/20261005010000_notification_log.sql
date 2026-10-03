-- Ledger of emails the backend sends (backend/api/notifications.py).
--
-- Each email is claimed by inserting its (kind, ref) before sending, e.g.
-- ('payment_receipt', <order id>) or ('plan_expiring_3d', '<user>:<term end>').
-- The unique key makes the claim atomic, so an email goes out once even when
-- the webhook and the periodic scheduler both notice the same event, or when
-- more than one backend process is running. A failed send releases its claim
-- so the next scheduler pass can retry.
--
-- Backend-only (service role). Admins may read it to see what was sent.

create table public.notification_log (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  ref text not null,
  user_id uuid references public.profiles(id) on delete set null,
  recipient text,
  status text not null default 'sending' check (status in ('sending', 'sent')),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (kind, ref)
);

create index notification_log_user_id_idx on public.notification_log (user_id);
create index notification_log_created_at_idx on public.notification_log (created_at);

alter table public.notification_log enable row level security;

create policy "notification_log_select_admin"
  on public.notification_log for select
  using (public.is_admin(auth.uid()));

revoke insert, update, delete on public.notification_log from anon, authenticated;
