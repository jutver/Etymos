-- Additive nullable JSONB column for report-level published-paper self-match
-- detection (specs/002-unify-academic-source-matching/data-model.md).
ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS published_paper_match jsonb;
