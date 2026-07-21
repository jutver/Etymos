-- Atomic purchase approval.
--
-- The admin portal originally approved a purchase as two sequential client
-- calls: grant the entitlement, then flip checkout_events.status to 'success'.
-- That ordering was chosen so a failed grant left the row 'pending' and
-- retryable rather than marked paid with nothing delivered — correct as far as
-- it goes, but it leaves the mirror-image hole open: if the grant SUCCEEDS and
-- the status update then fails, the row is still 'pending', the admin sees an
-- unreviewed request, retries, and the user is credited twice.
--
-- The credit top-up had a second, independent double-grant path: it was a
-- read-then-write (select current balance, add, update), so two admins
-- approving pack purchases for the same user concurrently could lose one
-- grant — or, on retry, apply one twice.
--
-- Both collapse into one problem: approval is a transaction and was being run
-- as separate statements. This function does the whole thing atomically, and
-- takes a row lock that makes it idempotent under retry — a second call for an
-- already-approved event is a no-op that returns false rather than granting
-- again.

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
  'Atomically grants a pending checkout_events entitlement and marks it success. Returns false if the event is not pending (already reviewed), making admin retries safe.';
