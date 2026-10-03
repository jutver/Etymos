-- SePay bank-transfer payments.
--
-- Until now checkout only filed a pending checkout_events row and an admin
-- granted access by hand after eyeballing the bank account. SePay watches
-- that bank account and POSTs a webhook for every transfer, so payment can
-- be confirmed automatically:
--
--   1. The backend creates the order (a checkout_events row) with a
--      server-computed price and a unique `payment_code`, e.g. ETM7K2QF9XA.
--      The user scans a VietQR whose transfer content is that code.
--   2. SePay's webhook reaches the backend, which hands the transfer to
--      record_sepay_transaction() below. That function logs the transfer in
--      payment_transactions (once per SePay id), finds the order by code,
--      checks the amount and grants the plan/credits — all in one
--      transaction, so a retried webhook can never grant twice.
--   3. Anything that can't be settled automatically (no code, unknown code,
--      too little money, an order that was already paid) stays in
--      payment_transactions for an admin to link or resolve.
--
-- payment_transactions is the cash ledger: one row per bank transfer SePay
-- reported, kept even if the order or user is later deleted.

-- ---------------------------------------------------------------------------
-- 1. checkout_events: order fields
-- ---------------------------------------------------------------------------

alter table public.checkout_events drop constraint if exists checkout_events_payment_method_check;
alter table public.checkout_events add constraint checkout_events_payment_method_check
  check (payment_method in ('vnpay', 'momo', 'zalopay', 'sepay'));

-- 'cancelled': the user abandoned an unpaid SePay order (or started another).
alter table public.checkout_events drop constraint if exists checkout_events_status_check;
alter table public.checkout_events add constraint checkout_events_status_check
  check (status in ('success', 'declined', 'pending', 'cancelled'));

alter table public.checkout_events
  -- Transfer content the bank payment must carry. Only the backend sets it.
  add column payment_code text,
  -- Price before discounts; `amount` stays the price actually charged.
  add column list_amount numeric(12, 2),
  add column discount_code_id uuid references public.discount_codes(id) on delete set null,
  -- When the QR stops being shown. A transfer that arrives later is still
  -- honoured — the order says exactly what was bought at what price.
  add column expires_at timestamptz,
  add column paid_at timestamptz,
  add column paid_amount numeric(14, 2);

create unique index checkout_events_payment_code_key
  on public.checkout_events (payment_code)
  where payment_code is not null;

create index checkout_events_paid_at_idx
  on public.checkout_events (paid_at)
  where paid_at is not null;

-- Orders are now created only by the backend (service role), which prices
-- them itself. A user-inserted row could carry any amount and a made-up
-- payment_code, and with automatic matching that would buy a plan for 1 đ.
drop policy if exists "checkout_events_insert_self_pending" on public.checkout_events;

-- ---------------------------------------------------------------------------
-- 2. payment_transactions: every transfer SePay reports
-- ---------------------------------------------------------------------------

create table public.payment_transactions (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'sepay',
  -- SePay's transaction id. Unique per provider: SePay retries webhooks and
  -- may deliver the same transfer more than once.
  provider_transaction_id text not null,
  gateway text,
  account_number text,
  sub_account text,
  transfer_type text not null check (transfer_type in ('in', 'out')),
  amount numeric(14, 2) not null,
  content text,
  reference_code text,
  description text,
  -- The payment code SePay itself recognised, if configured to.
  provider_code text,
  -- The payment code the backend found in the transfer.
  payment_code text,
  transaction_date timestamptz,
  checkout_event_id uuid references public.checkout_events(id) on delete set null,
  -- matched    paid an order, which was granted
  -- unmatched  no payment code, or no order has it
  -- underpaid  less than the order's amount; nothing granted
  -- duplicate  the order was already paid (refund or relink)
  -- review     the order had been declined by an admin
  -- ignored    outgoing transfer, not a payment
  -- resolved   an admin settled it by hand (e.g. refunded)
  status text not null check (
    status in ('matched', 'unmatched', 'underpaid', 'duplicate', 'review', 'ignored', 'resolved')
  ),
  note text,
  resolved_by uuid references public.profiles(id) on delete set null,
  resolved_at timestamptz,
  raw jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  unique (provider, provider_transaction_id)
);

create index payment_transactions_status_idx on public.payment_transactions (status);
create index payment_transactions_received_at_idx on public.payment_transactions (received_at);
create index payment_transactions_checkout_event_idx on public.payment_transactions (checkout_event_id);

alter table public.payment_transactions enable row level security;

create policy "payment_transactions_select_admin"
  on public.payment_transactions for select
  using (public.is_admin(auth.uid()));

-- Writes go through the functions below (security definer) or the backend's
-- service role, never straight from a client.
revoke insert, update, delete on public.payment_transactions from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Shared fulfilment
-- ---------------------------------------------------------------------------

-- Grants what an order bought. Callers must hold the order's row lock.
create or replace function public.grant_checkout_entitlement(p_event public.checkout_events)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_checks integer;
begin
  if p_event.kind = 'plan' then
    if p_event.plan_tier is null then
      raise exception 'Plan order % has no plan_tier', p_event.id;
    end if;
    update public.profiles
    set plan_tier = p_event.plan_tier,
        billing_cycle = p_event.billing_cycle,
        checks_used_this_period = 0,
        plan_period_start = now()
    where id = p_event.user_id;
  else
    if p_event.pack_id is null then
      raise exception 'Pack order % has no pack_id', p_event.id;
    end if;
    select checks into v_checks from public.credit_packs where id = p_event.pack_id;
    if v_checks is null then
      raise exception 'Unknown credit pack % on order %', p_event.pack_id, p_event.id;
    end if;
    v_checks := v_checks * coalesce(p_event.quantity, 1);
    if p_event.pack_id = 'pack-premium' then
      update public.profiles set premium_credits = premium_credits + v_checks where id = p_event.user_id;
    else
      update public.profiles set standard_credits = standard_credits + v_checks where id = p_event.user_id;
    end if;
  end if;
end;
$$;

-- Grants the order, counts its discount code as used, and marks it paid.
-- Callers must hold the order's row lock and have checked it isn't paid yet.
create or replace function public.complete_checkout_event(
  p_event public.checkout_events,
  p_paid_amount numeric,
  p_paid_at timestamptz,
  p_reviewer uuid default null,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.grant_checkout_entitlement(p_event);

  -- A code is used up when the order is paid, not when it is typed in.
  if p_event.discount_code_id is not null then
    insert into public.discount_code_redemptions (code_id, user_id)
    values (p_event.discount_code_id, p_event.user_id)
    on conflict (code_id, user_id) do nothing;
    if found then
      update public.discount_codes
      set redemption_count = redemption_count + 1
      where id = p_event.discount_code_id;
    end if;
  end if;

  update public.checkout_events
  set status = 'success',
      paid_at = coalesce(p_paid_at, now()),
      paid_amount = p_paid_amount,
      reviewed_at = case when p_reviewer is null then reviewed_at else now() end,
      reviewed_by = coalesce(p_reviewer, reviewed_by),
      review_note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), review_note)
  where id = p_event.id;
end;
$$;

-- Internal helpers: only other functions call these.
revoke all on function public.grant_checkout_entitlement(public.checkout_events) from public, anon, authenticated, service_role;
revoke all on function public.complete_checkout_event(public.checkout_events, numeric, timestamptz, uuid, text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. SePay webhook entry point (backend service role only)
-- ---------------------------------------------------------------------------

-- p_tx keys: id, gateway, account_number, sub_account, transfer_type,
-- amount, content, reference_code, description, provider_code,
-- payment_code (found by the backend), transaction_date (ISO timestamp),
-- raw (the original webhook body).
--
-- Returns {transaction_id, status, checkout_event_id, duplicate}.
-- `duplicate` is true when this SePay id was already recorded; nothing is
-- changed in that case.
create or replace function public.record_sepay_transaction(p_tx jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tx_id uuid;
  v_existing public.payment_transactions;
  v_event public.checkout_events;
  v_amount numeric := (p_tx ->> 'amount')::numeric;
  v_code text := nullif(upper(btrim(coalesce(p_tx ->> 'payment_code', ''))), '');
  v_paid_at timestamptz := nullif(p_tx ->> 'transaction_date', '')::timestamptz;
  v_status text;
  v_note text;
begin
  if coalesce(p_tx ->> 'id', '') = '' then
    raise exception 'SePay transaction id is required';
  end if;

  insert into public.payment_transactions (
    provider, provider_transaction_id, gateway, account_number, sub_account,
    transfer_type, amount, content, reference_code, description,
    provider_code, payment_code, transaction_date, status, raw
  )
  values (
    'sepay', p_tx ->> 'id', p_tx ->> 'gateway', p_tx ->> 'account_number', nullif(p_tx ->> 'sub_account', ''),
    p_tx ->> 'transfer_type', v_amount, p_tx ->> 'content', p_tx ->> 'reference_code', p_tx ->> 'description',
    nullif(p_tx ->> 'provider_code', ''), v_code, v_paid_at, 'unmatched', coalesce(p_tx -> 'raw', '{}'::jsonb)
  )
  on conflict (provider, provider_transaction_id) do nothing
  returning id into v_tx_id;

  if v_tx_id is null then
    select * into v_existing
    from public.payment_transactions
    where provider = 'sepay' and provider_transaction_id = p_tx ->> 'id';
    return jsonb_build_object(
      'transaction_id', v_existing.id,
      'status', v_existing.status,
      'checkout_event_id', v_existing.checkout_event_id,
      'duplicate', true
    );
  end if;

  if p_tx ->> 'transfer_type' is distinct from 'in' then
    v_status := 'ignored';
    v_note := 'Outgoing transfer.';
  elsif v_code is null then
    v_status := 'unmatched';
    v_note := 'No payment code in the transfer content.';
  else
    select * into v_event
    from public.checkout_events
    where payment_code = v_code
    for update;

    if not found then
      v_status := 'unmatched';
      v_note := 'No order has this payment code.';
    elsif v_event.status = 'success' then
      v_status := 'duplicate';
      v_note := 'The order was already paid. Refund this transfer or link it to another order.';
    elsif v_event.status = 'declined' then
      v_status := 'review';
      v_note := 'The order had been declined by an admin.';
    elsif v_amount < coalesce(v_event.amount, 0) then
      v_status := 'underpaid';
      v_note := format('Expected %s, received %s.', round(v_event.amount), round(v_amount));
    else
      -- pending, or cancelled by the user after they had already paid
      perform public.complete_checkout_event(v_event, v_amount, v_paid_at, null, null);
      v_status := 'matched';
      if v_amount > v_event.amount then
        v_note := format('Overpaid by %s.', round(v_amount - v_event.amount));
      end if;
    end if;
  end if;

  update public.payment_transactions
  set status = v_status,
      note = v_note,
      checkout_event_id = v_event.id
  where id = v_tx_id;

  return jsonb_build_object(
    'transaction_id', v_tx_id,
    'status', v_status,
    'checkout_event_id', v_event.id,
    'duplicate', false
  );
end;
$$;

revoke all on function public.record_sepay_transaction(jsonb) from public, anon, authenticated;
grant execute on function public.record_sepay_transaction(jsonb) to service_role;

-- Orders whose price came to 0 đ (a 100% discount) have nothing to transfer;
-- the backend completes them straight away. Returns false if the order isn't
-- a pending zero-amount order.
create or replace function public.complete_free_checkout(p_event_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event public.checkout_events;
begin
  select * into v_event
  from public.checkout_events
  where id = p_event_id and status = 'pending' and coalesce(amount, 0) = 0
  for update;
  if not found then
    return false;
  end if;
  perform public.complete_checkout_event(v_event, 0, now(), null, null);
  return true;
end;
$$;

revoke all on function public.complete_free_checkout(uuid) from public, anon, authenticated;
grant execute on function public.complete_free_checkout(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Admin actions on transactions
-- ---------------------------------------------------------------------------

-- Pays an order with a transfer the webhook couldn't settle (wrong or
-- missing code, too little money, an already-paid order). Linking an
-- underpaid transfer accepts the smaller amount.
create or replace function public.admin_match_payment_transaction(
  p_transaction_id uuid,
  p_event_id uuid,
  p_note text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin uuid := auth.uid();
  v_tx public.payment_transactions;
  v_event public.checkout_events;
begin
  if not public.is_admin(v_admin) then
    raise exception 'Only an admin may link a payment' using errcode = 'insufficient_privilege';
  end if;

  select * into v_tx from public.payment_transactions where id = p_transaction_id for update;
  if not found then
    raise exception 'Transaction not found.';
  end if;
  if v_tx.transfer_type <> 'in' or v_tx.status not in ('unmatched', 'underpaid', 'duplicate', 'review') then
    raise exception 'This transaction is already settled.';
  end if;

  select * into v_event from public.checkout_events where id = p_event_id for update;
  if not found then
    raise exception 'Order not found.';
  end if;
  if v_event.status = 'success' then
    raise exception 'That order is already paid.';
  end if;

  perform public.complete_checkout_event(
    v_event, v_tx.amount, coalesce(v_tx.transaction_date, v_tx.received_at), v_admin, p_note
  );

  update public.payment_transactions
  set status = 'matched',
      checkout_event_id = v_event.id,
      resolved_by = v_admin,
      resolved_at = now(),
      note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), 'Linked by an admin.')
  where id = v_tx.id;

  return true;
end;
$$;

-- Closes a transfer that needs no order (refunded, a personal transfer, ...).
-- A note is required so the ledger says what happened to the money.
create or replace function public.admin_resolve_payment_transaction(
  p_transaction_id uuid,
  p_note text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin uuid := auth.uid();
begin
  if not public.is_admin(v_admin) then
    raise exception 'Only an admin may resolve a payment' using errcode = 'insufficient_privilege';
  end if;
  if nullif(btrim(coalesce(p_note, '')), '') is null then
    raise exception 'Add a note saying what happened to this money.';
  end if;

  update public.payment_transactions
  set status = 'resolved',
      resolved_by = v_admin,
      resolved_at = now(),
      note = btrim(p_note)
  where id = p_transaction_id
    and status in ('unmatched', 'underpaid', 'duplicate', 'review');

  return found;
end;
$$;

revoke all on function public.admin_match_payment_transaction(uuid, uuid, text) from public, anon;
revoke all on function public.admin_resolve_payment_transaction(uuid, text) from public, anon;
grant execute on function public.admin_match_payment_transaction(uuid, uuid, text) to authenticated;
grant execute on function public.admin_resolve_payment_transaction(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Manual approval reuses the shared fulfilment
-- ---------------------------------------------------------------------------

-- Same contract as before (20260724010000): admin only, pending only,
-- returns false when already reviewed. It now also stamps paid_at and
-- paid_amount, so manually approved transfers count in revenue reports.
create or replace function public.approve_purchase_request(
  p_event_id uuid,
  p_note text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event public.checkout_events;
  v_admin uuid := auth.uid();
begin
  if not public.is_admin(v_admin) then
    raise exception 'Only an admin may approve a purchase request'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_event
  from public.checkout_events
  where id = p_event_id and status = 'pending'
  for update;

  if not found then
    return false;
  end if;

  perform public.complete_checkout_event(v_event, coalesce(v_event.amount, 0), now(), v_admin, p_note);
  return true;
end;
$$;

revoke all on function public.approve_purchase_request(uuid, text) from public, anon;
grant execute on function public.approve_purchase_request(uuid, text) to authenticated;
