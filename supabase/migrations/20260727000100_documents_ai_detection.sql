-- AI-generated-content detection result for a checked document
-- (backend/ai_detector.py -> report["ai_detection"]).
--
-- One nullable jsonb column, purely additive: existing rows stay null and every
-- existing query keeps working (the web app reads documents with select("*")).
-- Shape: { available, method, model, overall_score (0-100), level
-- ('low'|'possible'|'likely'), confidence, language, analyzed_words, ai_share,
-- segments: [{start, end, block_id, words, score}], reasons: [text], disclaimer }
-- or { available: false, reason } when the detector could not run.
--
-- It is deliberately NOT folded into similarity_score: plagiarism and
-- machine-written text are different signals and the report shows them apart.

alter table public.documents
  add column if not exists ai_detection jsonb;
