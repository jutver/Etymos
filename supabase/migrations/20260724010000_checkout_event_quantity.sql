-- Lets a user buy more than one of a credit pack in a single checkout
-- request. Plan purchases have no quantity concept and always store 1.
--
-- Without this, a frontend-only "buy 3x" stepper would inflate the
-- *displayed* price with nothing backing it server-side: approve_purchase_request
-- always granted exactly credit_packs.checks regardless of what was paid for.
-- This migration adds the missing column and re-teaches the approval RPC to
-- multiply the grant by it, so price paid and credits granted stay in sync.

alter table public.checkout_events
  add column quantity integer not null default 1 check (quantity >= 1);

comment on column public.checkout_events.quantity is
  'Number of packs purchased in this request. Always 1 for kind = ''plan''. Multiplies credit_packs.checks on approval — see approve_purchase_request.';

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
  v_checks integer;
  v_admin uuid := auth.uid();
begin
  if not public.is_admin(v_admin) then
    raise exception 'Only an admin may approve a purchase request'
      using errcode = 'insufficient_privilege';
  end if;

  -- `for update` serializes concurrent approvals of the same event; the
  -- status predicate makes a retry of an already-approved event fall through
  -- to `not found` instead of granting a second time.
  select * into v_event
  from public.checkout_events
  where id = p_event_id and status = 'pending'
  for update;

  if not found then
    return false;
  end if;

  if v_event.kind = 'plan' then
    if v_event.plan_tier is null then
      raise exception 'Plan request % has no plan_tier and cannot be approved', p_event_id;
    end if;

    -- A newly granted plan starts a fresh period, mirroring the web app's
    -- former self-serve purchase behaviour.
    update public.profiles
    set plan_tier = v_event.plan_tier,
        billing_cycle = v_event.billing_cycle,
        checks_used_this_period = 0,
        plan_period_start = now()
    where id = v_event.user_id;

  else
    if v_event.pack_id is null then
      raise exception 'Pack request % has no pack_id and cannot be approved', p_event_id;
    end if;

    select checks into v_checks
    from public.credit_packs
    where id = v_event.pack_id;

    if v_checks is null then
      raise exception 'Unknown credit pack % on request %', v_event.pack_id, p_event_id;
    end if;

    -- Scale the grant by how many packs were actually paid for. `quantity`
    -- predates coalesce-safety here only because the column has a `not null
    -- default 1`; the coalesce is defensive in case a future migration ever
    -- relaxes that.
    v_checks := v_checks * coalesce(v_event.quantity, 1);

    -- Read-modify-write done as a single statement, so concurrent grants
    -- accumulate instead of clobbering each other. pack_id is constrained to
    -- exactly these two values, and the two credit columns exist to mirror
    -- them (see 20260720000000_split_credit_balances.sql).
    if v_event.pack_id = 'pack-premium' then
      update public.profiles
      set premium_credits = premium_credits + v_checks
      where id = v_event.user_id;
    else
      update public.profiles
      set standard_credits = standard_credits + v_checks
      where id = v_event.user_id;
    end if;
  end if;

  update public.checkout_events
  set status = 'success',
      reviewed_at = now(),
      reviewed_by = v_admin,
      review_note = nullif(btrim(coalesce(p_note, '')), '')
  where id = p_event_id;

  return true;
end;
$$;

revoke all on function public.approve_purchase_request(uuid, text) from public;
grant execute on function public.approve_purchase_request(uuid, text) to authenticated;

comment on function public.approve_purchase_request(uuid, text) is
  'Atomically grants a pending checkout_events entitlement (credit_packs.checks * quantity for packs) and marks it success. Returns false if the event is not pending (already reviewed), making admin retries safe.';
