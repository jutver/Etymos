-- Append-only purchase/subscription ledger. Current plan/credit *state* stays
-- denormalized on profiles (mirrors apps/web's zustand store today); this
-- table is history only.

create table public.checkout_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('plan', 'pack')),
  plan_tier text check (plan_tier in ('student', 'professional')),
  billing_cycle text check (billing_cycle in ('monthly', 'annual')),
  pack_id text check (pack_id in ('pack-standard', 'pack-premium')),
  amount numeric(10, 2),
  currency text not null default 'VND',
  payment_method text check (payment_method in ('vnpay', 'momo', 'zalopay')),
  status text not null default 'pending' check (status in ('success', 'declined', 'pending')),
  created_at timestamptz not null default now()
);

create index checkout_events_user_id_idx on public.checkout_events (user_id);

alter table public.checkout_events enable row level security;

create policy "checkout_events_select_self_or_admin"
  on public.checkout_events for select
  using (user_id = auth.uid() or public.is_admin(auth.uid()));

-- No real payment gateway is integrated yet, so a regular user may only ever
-- create a *pending* record for themselves — never insert or flip a row to
-- 'success' directly. Granting paid access is an admin-only action for now.
create policy "checkout_events_insert_self_pending"
  on public.checkout_events for insert
  with check (user_id = auth.uid() and status = 'pending');

create policy "checkout_events_update_admin_only"
  on public.checkout_events for update
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));
