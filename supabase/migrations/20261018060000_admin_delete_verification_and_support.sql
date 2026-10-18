-- Admins delete student verification requests and support tickets from the
-- admin app: picked rows, every row with one status, or all of them.
--
-- Each function deletes the rows and returns the Storage paths of the files
-- that belonged to them; the admin app then removes those files through the
-- Storage API (Supabase doesn't let SQL delete stored files). Rows go first:
-- if removing a file fails, what's left is an unused file in a private
-- bucket, never a record pointing at a missing file.
--
-- Deleting an approved request doesn't take back the verification:
-- profiles.student_verified stays as it is, and the web app's /verify page
-- reads it.

create or replace function public.admin_delete_verification_requests(
  p_ids uuid[] default null,
  p_status text default null,
  p_all boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_paths text[];
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  if (p_ids is not null)::int + (p_status is not null)::int + p_all::int <> 1 then
    raise exception 'Pass exactly one of p_ids, p_status or p_all.' using errcode = '22023';
  end if;

  with deleted as (
    delete from public.student_verification_requests
    where p_all
       or id = any (p_ids)
       or status = p_status
    returning storage_path
  )
  select coalesce(array_agg(storage_path), '{}') into v_paths from deleted;

  return jsonb_build_object('deleted', cardinality(v_paths), 'paths', to_jsonb(v_paths));
end;
$$;

create or replace function public.admin_delete_support_tickets(
  p_ids uuid[] default null,
  p_status text default null,
  p_all boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids uuid[];
  v_paths text[];
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  if (p_ids is not null)::int + (p_status is not null)::int + p_all::int <> 1 then
    raise exception 'Pass exactly one of p_ids, p_status or p_all.' using errcode = '22023';
  end if;

  select coalesce(array_agg(id), '{}') into v_ids
  from (
    select id from public.support_tickets
    where p_all or id = any (p_ids) or status = p_status
    for update
  ) picked;

  -- Attachments and the original .eml of inbound emails. Messages and
  -- attachment rows go with the ticket (on delete cascade).
  select coalesce(array_agg(path), '{}') into v_paths
  from (
    select path from public.support_attachments where ticket_id = any (v_ids)
    union
    select raw_email_path from public.support_messages
    where ticket_id = any (v_ids) and raw_email_path is not null
  ) files;

  delete from public.support_tickets where id = any (v_ids);

  return jsonb_build_object('deleted', cardinality(v_ids), 'paths', to_jsonb(v_paths));
end;
$$;

revoke execute on function public.admin_delete_verification_requests(uuid[], text, boolean) from public, anon;
grant execute on function public.admin_delete_verification_requests(uuid[], text, boolean) to authenticated;
revoke execute on function public.admin_delete_support_tickets(uuid[], text, boolean) from public, anon;
grant execute on function public.admin_delete_support_tickets(uuid[], text, boolean) to authenticated;

-- The admin app removes the returned files itself. student-verification
-- already lets admins delete (20260716120000); support-attachments didn't.
create policy "support_attachments_bucket_delete_admin"
  on storage.objects for delete
  using (bucket_id = 'support-attachments' and public.is_admin(auth.uid()));
