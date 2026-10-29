-- Waitlist auto-approve: a switch on the admin Waitlist screen that lets new
-- sign-ups straight in instead of queueing them for review.
--
-- The switch is a feature_flags row (public read, admin write), so it also
-- shows on the admin Feature Flags page. handle_new_user reads it when the
-- profile is created. An auto-approved profile is stamped with
-- access_reviewed_at and the note 'Auto-approved', but no reviewer.
--
-- Turning it on goes through admin_set_waitlist_auto_approve, which also
-- approves everyone already waiting, in the same transaction as the flip, so
-- a sign-up that lands mid-switch is never left in the queue.

-- ---------------------------------------------------------------------------
-- 1. The flag
-- ---------------------------------------------------------------------------

insert into public.feature_flags (key, label, description, enabled)
values (
  'waitlist_auto_approve',
  'Auto-approve new sign-ups',
  'When enabled, new accounts can use the app right away instead of waiting on the Waitlist for an admin to approve them.',
  false
)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. handle_new_user: approve on sign-up while the flag is on
-- ---------------------------------------------------------------------------
-- Re-declared in full; identical to 20261018030000 apart from the access
-- columns.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_auto boolean := coalesce(
    (select enabled from public.feature_flags where key = 'waitlist_auto_approve'),
    false
  );
begin
  insert into public.profiles (
    id, email, display_name, access_requested_at,
    access_status, access_reviewed_at, access_note
  )
  values (
    new.id,
    new.email,
    coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
      nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
      nullif(trim(new.raw_user_meta_data ->> 'name'), '')
    ),
    now(),
    case when v_auto then 'approved' else 'waitlisted' end,
    case when v_auto then now() end,
    case when v_auto then 'Auto-approved' end
  );
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. admin_set_waitlist_auto_approve: flip the flag (and clear the queue)
-- ---------------------------------------------------------------------------
-- Returns how many waiting accounts were approved (0 when turning it off).
create or replace function public.admin_set_waitlist_auto_approve(p_enabled boolean)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_approved integer := 0;
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Admins only.' using errcode = '42501';
  end if;

  update public.feature_flags
  set enabled = p_enabled, updated_by = auth.uid()
  where key = 'waitlist_auto_approve';

  if p_enabled then
    update public.profiles
    set access_status = 'approved',
        access_reviewed_at = now(),
        access_reviewed_by = auth.uid(),
        access_note = 'Auto-approved'
    where access_status = 'waitlisted';
    get diagnostics v_approved = row_count;
  end if;

  return v_approved;
end;
$$;

revoke execute on function public.admin_set_waitlist_auto_approve(boolean) from public, anon;
grant execute on function public.admin_set_waitlist_auto_approve(boolean) to authenticated;
