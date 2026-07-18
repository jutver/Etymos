-- Student verification requests, admin audit log, and the Storage buckets
-- (`documents`, `student-verification`) both features depend on. Also seeds
-- the `gemini_metadata_extraction` feature flag the Python backend will read.

create table public.student_verification_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  storage_path text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create index student_verification_requests_user_id_idx on public.student_verification_requests (user_id);
create index student_verification_requests_status_idx on public.student_verification_requests (status);

alter table public.student_verification_requests enable row level security;

create policy "student_verification_requests_insert_self"
  on public.student_verification_requests for insert
  with check (user_id = auth.uid());

create policy "student_verification_requests_select_self_or_admin"
  on public.student_verification_requests for select
  using (user_id = auth.uid() or public.is_admin(auth.uid()));

create policy "student_verification_requests_update_admin_only"
  on public.student_verification_requests for update
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

-- Admin/moderation action trail (e.g. profile edits, verification decisions).
-- SELECT is admin-only. INSERT is allowed from the admin SPA but only as
-- the caller's own uid (actor_id = auth.uid()), so a client session can
-- never spoof who performed an action. There is deliberately NO update/
-- delete policy for clients, and no insert policy for non-admins — system-
-- generated events (document uploads, checks run, etc.) go through the
-- backend's service-role client, which bypasses RLS entirely.
create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id),
  target_user_id uuid references public.profiles(id),
  action text not null,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create index audit_log_target_user_id_idx on public.audit_log (target_user_id);
create index audit_log_actor_id_idx on public.audit_log (actor_id);

alter table public.audit_log enable row level security;

create policy "audit_log_select_admin_only"
  on public.audit_log for select
  using (public.is_admin(auth.uid()));

-- Admins may insert audit rows from the admin SPA (e.g. after editing a
-- user's plan in UserDetail), but only as themselves — actor_id must match
-- the caller's own uid, so a client session can never spoof who performed
-- the action. Broader/system-generated events (document uploads, checks
-- run, etc.) still go through the service-role path, which bypasses RLS.
create policy "audit_log_insert_admin_self"
  on public.audit_log for insert
  with check (public.is_admin(auth.uid()) and actor_id = auth.uid());

-- Storage buckets: private, path-scoped per user (`{bucket_id}/{user_id}/...`).
insert into storage.buckets (id, name, public)
values
  ('documents', 'documents', false),
  ('student-verification', 'student-verification', false)
on conflict (id) do nothing;

create policy "documents_bucket_owner_read"
  on storage.objects for select
  using (
    bucket_id = 'documents'
    and (auth.uid()::text = (storage.foldername(name))[1] or public.is_admin(auth.uid()))
  );

create policy "documents_bucket_owner_write"
  on storage.objects for insert
  with check (
    bucket_id = 'documents'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "documents_bucket_owner_update"
  on storage.objects for update
  using (
    bucket_id = 'documents'
    and (auth.uid()::text = (storage.foldername(name))[1] or public.is_admin(auth.uid()))
  )
  with check (
    bucket_id = 'documents'
    and (auth.uid()::text = (storage.foldername(name))[1] or public.is_admin(auth.uid()))
  );

create policy "documents_bucket_owner_delete"
  on storage.objects for delete
  using (
    bucket_id = 'documents'
    and (auth.uid()::text = (storage.foldername(name))[1] or public.is_admin(auth.uid()))
  );

create policy "student_verification_bucket_owner_read"
  on storage.objects for select
  using (
    bucket_id = 'student-verification'
    and (auth.uid()::text = (storage.foldername(name))[1] or public.is_admin(auth.uid()))
  );

create policy "student_verification_bucket_owner_write"
  on storage.objects for insert
  with check (
    bucket_id = 'student-verification'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "student_verification_bucket_owner_update"
  on storage.objects for update
  using (
    bucket_id = 'student-verification'
    and (auth.uid()::text = (storage.foldername(name))[1] or public.is_admin(auth.uid()))
  )
  with check (
    bucket_id = 'student-verification'
    and (auth.uid()::text = (storage.foldername(name))[1] or public.is_admin(auth.uid()))
  );

create policy "student_verification_bucket_owner_delete"
  on storage.objects for delete
  using (
    bucket_id = 'student-verification'
    and (auth.uid()::text = (storage.foldername(name))[1] or public.is_admin(auth.uid()))
  );

-- Feature flag: lets the admin portal switch the Python backend's section
-- metadata extraction between the Gemini API and the local Qwen2.5 model.
-- Defaults to disabled (false) because the VPS has a GPU, so the local
-- Qwen2.5 path stays the default; Gemini is an opt-in toggle for admins.
insert into public.feature_flags (key, label, description, enabled)
values (
  'gemini_metadata_extraction',
  'Use Gemini for metadata extraction',
  'When enabled, the Python backend calls the Gemini API for section metadata extraction instead of the local Qwen2.5 model. Defaults off since the VPS has a GPU and can run Qwen2.5 locally at no per-call cost.',
  false
)
on conflict (key) do nothing;
