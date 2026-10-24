-- The source-paper cache, moved off the API server's disk (backend/paper_cache/
-- papers.db + chunks/*.json) so it survives replacing the server and is shared
-- by every API instance. The PDFs themselves are not stored: only the text
-- chunks the matcher compares against, which is all a check needs.
--
-- Server-only: RLS is on with no policies, so only the service-role key (the
-- backend) can read or write. The full text of other people's papers must
-- never reach a browser; reports keep showing matched snippets only.

create table public.source_papers (
  paper_id text primary key,
  title text not null default '',
  normalized_title text not null default '',
  year text not null default '',
  doi text not null default '',
  arxiv_id text not null default '',
  acl_id text not null default '',
  source text not null default '',
  source_kind text not null default 'academic' check (source_kind in ('academic', 'web')),
  url text not null default '',
  pdf_url text not null default '',
  authors jsonb not null default '[]'::jsonb,
  abstract text not null default '',
  -- True once chunks were built from the paper's full text (its PDF).
  has_full_text boolean not null default false,
  -- backend/paper_cache.py CHUNK_VERSION of the full-text chunks; older ones
  -- are rebuilt when the server still has the PDF.
  chunk_version integer,
  -- The last PDF download attempt, so a failing link isn't retried every check
  -- but a paper gets another try once the link changes or the attempt is old.
  pdf_attempted_url text not null default '',
  pdf_attempted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search_vector tsvector generated always as (
    setweight(to_tsvector('simple', title), 'A') ||
    setweight(to_tsvector('simple', left(abstract, 4000)), 'B')
  ) stored
);

create index source_papers_search_idx on public.source_papers using gin (search_vector);
create index source_papers_normalized_title_idx on public.source_papers (normalized_title);
create index source_papers_doi_idx on public.source_papers (lower(doi)) where doi <> '';

-- One row per paper: the chunk list exactly as the matcher reads it
-- (paper_id, section, chunk_id, start_char, end_char, text).
create table public.source_paper_chunks (
  paper_id text primary key references public.source_papers(paper_id) on delete cascade,
  chunks jsonb not null default '[]'::jsonb,
  -- 'full_text' (from the PDF) or 'abstract' (title + abstract only).
  chunks_source text not null check (chunks_source in ('full_text', 'abstract')),
  updated_at timestamptz not null default now()
);

alter table public.source_papers enable row level security;
alter table public.source_paper_chunks enable row level security;
revoke all on public.source_papers from anon, authenticated;
revoke all on public.source_paper_chunks from anon, authenticated;

-- Cached papers whose title or abstract shares words with a check's search
-- queries, best first. Any one word may match; ts_rank_cd favours papers that
-- match many of them, and title words count more than abstract words.
create or replace function public.search_source_papers(p_terms text[], p_limit integer default 15)
returns table (paper_id text, rank real)
language sql
stable
set search_path = public
as $$
  with q as (
    select string_agg(plainto_tsquery('simple', t)::text, ' | ')::tsquery as query
    from unnest(p_terms) as t
    where plainto_tsquery('simple', t)::text <> ''
  )
  select p.paper_id, ts_rank_cd(p.search_vector, q.query) as rank
  from public.source_papers p, q
  where q.query is not null and p.search_vector @@ q.query
  order by rank desc
  limit least(greatest(p_limit, 1), 50);
$$;

revoke execute on function public.search_source_papers(text[], integer) from public, anon, authenticated;
grant execute on function public.search_source_papers(text[], integer) to service_role;

notify pgrst, 'reload schema';
