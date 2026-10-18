-- More ways for admins to aim a discount (Pricing > Discounts):
--   * who may use it: listed emails, accounts created in a date window,
--     and/or customers who haven't paid for anything yet;
--   * what it covers: monthly or annual plans only, and (codes) which plans
--     and packs a code works on.
-- Every new column defaults to "no limit", so existing discounts behave as
-- before.
--
-- The email lists are private, so plan_discounts is no longer readable by
-- everyone. The web Pricing page reads the discounts that apply to the
-- viewer through my_plan_discounts() instead. Checkout prices still come
-- from backend/api/payments.py, which applies the same rules.

alter table public.plan_discounts
  add column billing_cycle text check (billing_cycle in ('monthly', 'annual')),
  add column allowed_emails text[] check (allowed_emails is null or cardinality(allowed_emails) > 0),
  add column signup_from timestamptz,
  add column signup_to timestamptz,
  add column new_customers_only boolean not null default false;

alter table public.discount_codes
  -- 'plan:<plan id>' / 'pack:<pack id>'; null = any plan or pack.
  add column targets text[] check (targets is null or cardinality(targets) > 0),
  add column billing_cycle text check (billing_cycle in ('monthly', 'annual')),
  add column allowed_emails text[] check (allowed_emails is null or cardinality(allowed_emails) > 0),
  add column signup_from timestamptz,
  add column signup_to timestamptz,
  add column new_customers_only boolean not null default false;

-- Admins keep full access through plan_discounts_write_admin_only.
drop policy "plan_discounts_select_all" on public.plan_discounts;

-- Whether a user is in a discount's audience. Internal: callers below are
-- SECURITY DEFINER, and nobody else needs to ask about other users.
create or replace function public.discount_audience_ok(
  p_user uuid,
  p_allowed_emails text[],
  p_signup_from timestamptz,
  p_signup_to timestamptz,
  p_new_customers_only boolean
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when p_allowed_emails is null and p_signup_from is null and p_signup_to is null
      and not p_new_customers_only then true
    when p_user is null then false
    else coalesce((
      select
        (p_allowed_emails is null
          or exists (select 1 from unnest(p_allowed_emails) e where lower(e) = lower(p.email)))
        and (p_signup_from is null or p.created_at >= p_signup_from)
        and (p_signup_to is null or p.created_at <= p_signup_to)
        and (not p_new_customers_only or not exists (
          select 1 from public.checkout_events c where c.user_id = p_user and c.status = 'success'
        ))
      from public.profiles p
      where p.id = p_user
    ), false)
  end
$$;

revoke execute on function public.discount_audience_ok(uuid, text[], timestamptz, timestamptz, boolean)
  from public, anon, authenticated;

-- The automatic discounts the caller would get right now, without the
-- audience details. Signed out, only discounts open to everyone.
create or replace function public.my_plan_discounts()
returns table (target_type text, target_id text, billing_cycle text, discount_type text, amount numeric)
language sql
stable
security definer
set search_path = public
as $$
  select d.target_type, d.target_id, d.billing_cycle, d.discount_type, d.amount
  from public.plan_discounts d
  where d.active
    and (d.starts_at is null or d.starts_at <= now())
    and (d.ends_at is null or d.ends_at >= now())
    and public.discount_audience_ok(auth.uid(), d.allowed_emails, d.signup_from, d.signup_to, d.new_customers_only)
$$;

grant execute on function public.my_plan_discounts() to anon, authenticated;

-- The old validate-and-redeem RPC (checkout now prices through the backend)
-- gets the audience check too, so it can't hand out a code meant for
-- someone else.
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
  if not public.discount_audience_ok(auth.uid(), v_code.allowed_emails, v_code.signup_from,
                                     v_code.signup_to, v_code.new_customers_only) then
    raise exception 'This discount code isn''t available for your account.';
  end if;
  if exists (select 1 from public.discount_code_redemptions r where r.code_id = v_code.id and r.user_id = auth.uid()) then
    raise exception 'You have already used this discount code.';
  end if;

  update public.discount_codes set redemption_count = redemption_count + 1 where id = v_code.id;
  insert into public.discount_code_redemptions (code_id, user_id) values (v_code.id, auth.uid());

  return query select v_code.discount_type, v_code.amount;
end;
$$;
