-- documents + child tables, normalizing CheckedDocument/DocPassage/MatchedSource
-- from apps/web/src/lib/types.ts, plus moderation fields for the admin portal.

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text,
  file_name text,
  language text check (language in ('vi', 'en', 'fr', 'ja')),
  word_count integer,
  status text check (status in ('clean', 'low', 'moderate', 'high')),
  similarity_score numeric(5, 2),
  similarity_score_free numeric(5, 2),
  web_sources_scanned integer default 0,
  academic_sources_scanned integer default 0,
  project text,
  is_trashed boolean not null default false,
  moderation_status text not null default 'none' check (moderation_status in ('none', 'flagged', 'removed')),
  moderation_notes text,
  flagged_at timestamptz,
  flagged_by uuid references public.profiles(id),
  uploaded_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index documents_user_id_idx on public.documents (user_id);
create index documents_moderation_status_idx on public.documents (moderation_status);

alter table public.documents enable row level security;

create policy "documents_all_self_or_admin"
  on public.documents for all
  using (user_id = auth.uid() or public.is_admin(auth.uid()))
  with check (user_id = auth.uid() or public.is_admin(auth.uid()));

create table public.document_matches (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  severity text check (severity in ('high', 'moderate', 'low')),
  detection_type text check (detection_type in ('traditional', 'semantic')),
  match_percent numeric(5, 2),
  source_title text,
  source_author text,
  source_kind text check (source_kind in ('web', 'academic')),
  citation text,
  user_snippet text,
  source_snippet text,
  explanation text,
  rewrite_suggestions text[]
);

create index document_matches_document_id_idx on public.document_matches (document_id);

alter table public.document_matches enable row level security;

create policy "document_matches_all_self_or_admin"
  on public.document_matches for all
  using (
    public.is_admin(auth.uid())
    or exists (select 1 from public.documents d where d.id = document_id and d.user_id = auth.uid())
  )
  with check (
    public.is_admin(auth.uid())
    or exists (select 1 from public.documents d where d.id = document_id and d.user_id = auth.uid())
  );

create table public.document_passages (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  text text,
  severity text check (severity in ('high', 'moderate', 'low')),
  match_id uuid references public.document_matches(id) on delete set null,
  sort_order integer
);

create index document_passages_document_id_idx on public.document_passages (document_id);

alter table public.document_passages enable row level security;

create policy "document_passages_all_self_or_admin"
  on public.document_passages for all
  using (
    public.is_admin(auth.uid())
    or exists (select 1 from public.documents d where d.id = document_id and d.user_id = auth.uid())
  )
  with check (
    public.is_admin(auth.uid())
    or exists (select 1 from public.documents d where d.id = document_id and d.user_id = auth.uid())
  );
