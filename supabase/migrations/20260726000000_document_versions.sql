-- Report page "Version History" (top bar, VersionHistoryMenu.tsx) has always
-- been an edit-history stub: handleSave kept snapshots only in React state,
-- so they vanished on reload. This table gives it real persistence.
--
-- Deliberately separate from document_passages/document_matches: those hold
-- the *check* result (one row per passage/match, keyed to the run that
-- produced them); this holds *edit* snapshots of the document body a user
-- makes while reviewing/rewriting in the Report editor, which can happen
-- any number of times after a check completes.

create table public.document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  label text not null,
  html text not null,
  word_count integer not null default 0,
  created_at timestamptz not null default now()
);

create index document_versions_document_id_idx
  on public.document_versions (document_id, created_at desc);

alter table public.document_versions enable row level security;

create policy "document_versions_all_self_or_admin"
  on public.document_versions for all
  using (
    public.is_admin(auth.uid())
    or exists (select 1 from public.documents d where d.id = document_id and d.user_id = auth.uid())
  )
  with check (
    public.is_admin(auth.uid())
    or exists (select 1 from public.documents d where d.id = document_id and d.user_id = auth.uid())
  );
