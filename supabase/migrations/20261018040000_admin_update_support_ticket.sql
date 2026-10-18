-- Ticket fields (status, assignee, topic, priority) edited from the admin app.
--
-- These changes send no email, so the admin app makes them straight against
-- the database instead of through the backend's PATCH
-- /api/admin/support/tickets/{number}, which also rebuilt and re-signed the
-- whole conversation on every change. Clients still can't write
-- support_tickets (20261009000000_support.sql revokes it); this function is
-- the one way in, and only for admins. It applies the same rules as the
-- backend's admin_update_ticket(): resolved_at/closed_at follow the status,
-- and only an admin can be assigned.
--
-- Because the call runs as the admin, the support_tickets activity trigger
-- records them as the actor, where the backend's service role showed up as
-- "system".

create or replace function public.admin_update_support_ticket(
  p_number bigint,
  p_status text default null,
  p_priority text default null,
  p_category text default null,
  -- null leaves the assignee alone; '' unassigns.
  p_assigned_to text default null
)
returns public.support_tickets
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ticket public.support_tickets;
  v_assignee uuid;
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Admins only.' using errcode = '42501';
  end if;

  select * into v_ticket from public.support_tickets where number = p_number for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  if p_assigned_to is not null and p_assigned_to <> '' then
    begin
      v_assignee := p_assigned_to::uuid;
    exception when invalid_text_representation then
      raise exception 'invalid_assignee' using errcode = '22023';
    end;
    if not public.is_admin(v_assignee) then
      raise exception 'invalid_assignee' using errcode = '22023';
    end if;
  end if;

  update public.support_tickets set
    status = coalesce(p_status, status),
    resolved_at = case
      when p_status is null or p_status = v_ticket.status then resolved_at
      when p_status = 'resolved' then now()
      when p_status = 'closed' then resolved_at
      else null
    end,
    closed_at = case
      when p_status is null or p_status = v_ticket.status then closed_at
      when p_status = 'closed' then now()
      when p_status = 'resolved' then closed_at
      else null
    end,
    priority = coalesce(p_priority, priority),
    category = coalesce(p_category, category),
    assigned_to = case
      when p_assigned_to is null then assigned_to
      when p_assigned_to = '' then null
      else v_assignee
    end,
    updated_at = now()
  where id = v_ticket.id
  returning * into v_ticket;

  return v_ticket;
end;
$$;

revoke execute on function public.admin_update_support_ticket(bigint, text, text, text, text) from public, anon;
grant execute on function public.admin_update_support_ticket(bigint, text, text, text, text) to authenticated;
