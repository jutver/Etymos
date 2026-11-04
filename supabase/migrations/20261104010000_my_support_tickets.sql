-- My requests list (/account/support) read straight from the database.
--
-- It used to go web -> backend -> database, which added a slow round trip
-- through the API for a plain list. support_tickets stays admin-only (rows
-- hold priority, assignee and identity_verified), so this returns only the
-- fields backend/api/support.py public_ticket() returns, for the same tickets
-- its my_tickets() lists: opened by this account, or sent from its login
-- address. Opening a ticket still goes through the backend.

create or replace function public.my_support_tickets()
returns table (
  number bigint,
  subject text,
  category text,
  status text,
  created_at timestamptz,
  updated_at timestamptz,
  last_agent_message_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select t.number, t.subject, t.category, t.status, t.created_at, t.updated_at, t.last_agent_message_at
  from public.support_tickets t
  where auth.uid() is not null
    and (
      t.user_id = auth.uid()
      or t.requester_email = (select lower(u.email) from auth.users u where u.id = auth.uid())
    )
  order by t.updated_at desc;
$$;

revoke all on function public.my_support_tickets() from public, anon;
grant execute on function public.my_support_tickets() to authenticated, service_role;
