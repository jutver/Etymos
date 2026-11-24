-- Additive columns on public.document_matches for canonical top-to-bottom reading order
-- and cached per-language on-demand AI explanations (Spec 007).
alter table public.document_matches
  add column if not exists sort_order integer,
  add column if not exists start_offset integer,
  add column if not exists end_offset integer,
  add column if not exists ai_explanations jsonb;

create index if not exists document_matches_doc_sort_idx
  on public.document_matches (document_id, sort_order);
