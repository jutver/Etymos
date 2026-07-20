-- Discount system backing the new admin Pricing > Discounts tab:
--   1. plan_discounts   — a direct % or fixed-amount markdown on one
--      plan_definitions row or one credit_packs row, with an optional
--      schedule window. Public-readable (same pattern as plan_definitions/
--      credit_packs) so the customer-facing Pricing/Checkout pages can show
--      the discounted price without needing an authenticated call.
--   2. discount_codes   — a code the user types in at checkout, with its own
--      schedule window and a redemption cap. NOT publicly listable (no
--      select policy for regular users) — validated only through the
--      redeem_discount_code() RPC below, so the codes table can't be
--      browsed/enumerated by end users.
--   3. discount_code_redemptions — one row per (code, user) redemption, both
--      for admin audit visibility and to enforce one-redemption-per-user.

create table public.plan_discounts (
  id uuid primary key default gen_random_uuid(),
  target_type text not null check (target_type in ('plan', 'pack')),
  target_id text not null,
  discount_type text not null check (discount_type in ('percent', 'fixed')),
  amount numeric not null check (amount > 0),
  starts_at timestamptz,
  ends_at timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index plan_discounts_target_idx on public.plan_discounts (target_type, target_id);

alter table public.plan_discounts enable row level security;

create policy "plan_discounts_select_all"
  on public.plan_discounts for select
  using (true);

create policy "plan_discounts_write_admin_only"
  on public.plan_discounts for all
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

create trigger plan_discounts_set_updated_at
  before update on public.plan_discounts
  for each row execute function public.set_updated_at();

create table public.discount_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  discount_type text not null check (discount_type in ('percent', 'fixed')),
  amount numeric not null check (amount > 0),
  starts_at timestamptz,
  ends_at timestamptz,
  max_redemptions integer check (max_redemptions is null or max_redemptions > 0),
  redemption_count integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.discount_codes enable row level security;

-- No select policy for regular users: codes are opaque strings validated
-- only via redeem_discount_code() below, not a browsable table.
create policy "discount_codes_all_admin_only"
  on public.discount_codes for all
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

create trigger discount_codes_set_updated_at
  before update on public.discount_codes
  for each row execute function public.set_updated_at();

create table public.discount_code_redemptions (
  id uuid primary key default gen_random_uuid(),
  code_id uuid not null references public.discount_codes(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  redeemed_at timestamptz not null default now(),
  unique (code_id, user_id)
);

create index discount_code_redemptions_code_id_idx on public.discount_code_redemptions (code_id);

alter table public.discount_code_redemptions enable row level security;

create policy "discount_code_redemptions_select_self_or_admin"
  on public.discount_code_redemptions for select
  using (user_id = auth.uid() or public.is_admin(auth.uid()));

-- Atomic validate-and-redeem RPC, called by the checkout page with the
-- caller's own JWT (auth.uid() is populated here — this goes through
-- PostgREST, unlike the Dashboard SQL Editor gotcha from the profiles
-- trigger). SECURITY DEFINER so it can read/update discount_codes despite
-- that table having no end-user select policy. Raises a friendly exception
-- on any invalid state instead of silently no-op'ing, so the checkout UI
-- can surface *why* a code didn't apply.
create or replace function public.redeem_discount_code(p_code text)
returns table (discount_type text, amount numeric)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code public.discount_codes;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to apply a discount code.';
  end if;

  select * into v_code from public.discount_codes where upper(code) = upper(p_code);

  if v_code.id is null then
    raise exception 'Invalid discount code.';
  end if;
  if not v_code.active then
    raise exception 'This discount code is no longer active.';
  end if;
  if v_code.starts_at is not null and now() < v_code.starts_at then
    raise exception 'This discount code is not active yet.';
  end if;
  if v_code.ends_at is not null and now() > v_code.ends_at then
    raise exception 'This discount code has expired.';
  end if;
  if v_code.max_redemptions is not null and v_code.redemption_count >= v_code.max_redemptions then
    raise exception 'This discount code has reached its usage limit.';
  end if;
  if exists (select 1 from public.discount_code_redemptions r where r.code_id = v_code.id and r.user_id = auth.uid()) then
    raise exception 'You have already used this discount code.';
  end if;

  update public.discount_codes set redemption_count = redemption_count + 1 where id = v_code.id;
  insert into public.discount_code_redemptions (code_id, user_id) values (v_code.id, auth.uid());

  return query select v_code.discount_type, v_code.amount;
end;
$$;
