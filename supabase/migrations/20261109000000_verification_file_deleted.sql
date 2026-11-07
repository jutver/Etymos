-- Admins can delete a student's uploaded evidence file and keep the request:
-- who asked, when, the decision and who made it. The admin app removes the
-- file through the Storage API first (admins may already delete in the
-- student-verification bucket, 20260716120000), then stamps the row, so a
-- row is only marked once its file is really gone. storage_path stays so the
-- record still says which file it was.
--
-- Admins may also approve a request they had rejected; that needs no schema
-- change (student_verification_requests_update_admin_only already allows it).

alter table public.student_verification_requests
  add column if not exists file_deleted_at timestamptz,
  add column if not exists file_deleted_by uuid references public.profiles(id) on delete set null;

comment on column public.student_verification_requests.file_deleted_at is
  'When an admin deleted the evidence file; the request record is kept. Null while the file exists.';
