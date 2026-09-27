-- Match explanations in the reader's UI language, plus source details for
-- citing the matched source after a report is reloaded.
--
-- explanation_facts: which explanation template applies and the values it
--   fills in (backend/ai_explain.py explanation_facts()). The web app turns it
--   into a sentence in the language the user picked (VI/EN). Null for LLM-
--   polished explanations and older reports: the stored `explanation` text is
--   shown as before.
-- source_url / source_year / source_doi: previously only on the live check
--   result, so "Copy Citation" and the source line lost them after a reload.
--
-- Purely additive: nullable columns, no existing data or policy changes.

alter table public.document_matches
  add column if not exists explanation_facts jsonb,
  add column if not exists source_url text,
  add column if not exists source_year text,
  add column if not exists source_doi text;

notify pgrst, 'reload schema';
